import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { matchesGlob } from "node:path";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LineRange = { start: number; end: number };
export type OwnedFile = { path: string; blob: string; ranges: LineRange[]; ownedLines: number };
export type Commit = { hash: string; email: string; date: string; subject: string; body: string };
export type Collection = { repo: string; head: string; emails: string[]; files: OwnedFile[]; commits: Commit[] };

export type CollectOptions = {
  repo: string;
  emails: string[];
  extensions?: string[];
  ignore?: string[];
  maxFileBytes?: number;
  cache?: boolean;
};

export const DEFAULT_IGNORE = [
  "**/build/**", "**/dist/**", "**/out/**", "**/generated/**", "**/node_modules/**",
  "**/vendor/**", "**/third_party/**", "**/*.lock", "**/*lock.json", "**/*.min.*",
];

type Cache = { files: Record<string, OwnedFile>; commitsHead?: string; commits: Commit[] };

export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

export async function detectEmail(repo: string): Promise<string | undefined> {
  return (await git(repo, ["config", "user.email"]).catch(() => "")).trim() || undefined;
}

export async function collect(opts: CollectOptions): Promise<Collection> {
  const { repo, extensions = [".kt", ".kts"], maxFileBytes = 512 * 1024, cache: useCache = true } = opts;
  const emails = opts.emails.map((e) => e.toLowerCase());
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const ignore = [...DEFAULT_IGNORE, ...(opts.ignore ?? []), ...(await readIgnoreFile(repo))];
  const cachePath = join(repo, ".idiolect", "cache", "collector.json");
  const cache = useCache ? await readCache(cachePath) : { files: {}, commits: [] };

  const files: OwnedFile[] = [];
  await pool(await listFiles(repo, head, extensions, ignore, maxFileBytes), 8, async (f) => {
    const cached = cache.files[f.path];
    const owned = cached?.blob === f.blob ? cached : await blameFile(repo, head, f, emails);
    if (owned.ownedLines > 0) files.push(owned);
  });
  files.sort((a, b) => a.path.localeCompare(b.path));

  const commits = await listCommits(repo, head, emails, cache);

  if (useCache) {
    cache.files = Object.fromEntries(files.map((f) => [f.path, f]));
    cache.commits = commits;
    cache.commitsHead = head;
    await writeCache(cachePath, cache);
  }
  return { repo, head, emails, files, commits };
}

async function listFiles(repo: string, head: string, extensions: string[], ignore: string[], maxBytes: number) {
  const out = await git(repo, ["ls-tree", "-r", "-l", "-z", head]);
  const files: { path: string; blob: string }[] = [];
  for (const entry of out.split("\0")) {
    if (!entry) continue;
    const [meta, path] = entry.split("\t") as [string, string];
    const [, type, blob, size] = meta.trim().split(/\s+/) as [string, string, string, string];
    if (type !== "blob" || Number(size) > maxBytes) continue;
    if (!extensions.some((ext) => path.endsWith(ext))) continue;
    if (ignore.some((g) => matchesGlob(path, g))) continue;
    files.push({ path, blob });
  }
  return files;
}

const GENERATED = /\b(auto-?generated|do not edit)\b/i;

async function blameFile(repo: string, head: string, f: { path: string; blob: string }, emails: string[]): Promise<OwnedFile> {
  const empty: OwnedFile = { ...f, ranges: [], ownedLines: 0 };
  const header = await git(repo, ["show", `${head}:${f.path}`]);
  if (GENERATED.test(header.slice(0, 1024))) return empty;

  const out = await git(repo, ["blame", "-w", "--line-porcelain", head, "--", f.path]);
  const ranges: LineRange[] = [];
  let line = 0;
  let mine = false;
  for (const l of out.split("\n")) {
    if (/^[0-9a-f]{40} \d+ \d+/.test(l)) line = Number(l.split(" ")[2]);
    else if (l.startsWith("author-mail ")) mine = emails.includes(l.slice(13, -1).toLowerCase());
    else if (l.startsWith("\t") && mine) {
      const last = ranges.at(-1);
      if (last && last.end === line - 1) last.end = line;
      else ranges.push({ start: line, end: line });
    }
  }
  return { ...f, ranges, ownedLines: ranges.reduce((n, r) => n + r.end - r.start + 1, 0) };
}

async function listCommits(repo: string, head: string, emails: string[], cache: Cache): Promise<Commit[]> {
  const since = cache.commitsHead && (await git(repo, ["merge-base", "--is-ancestor", cache.commitsHead, head]).then(() => true, () => false));
  const range = since ? `${cache.commitsHead}..${head}` : head;
  const out = await git(repo, ["log", "--no-merges", "--format=%H%x1f%ae%x1f%aI%x1f%B%x1e", range]);
  const fresh: Commit[] = [];
  for (const rec of out.split("\x1e")) {
    const [hash, email, date, message] = rec.trim().split("\x1f");
    if (!hash || !emails.includes(email!.toLowerCase())) continue;
    const [subject = "", ...rest] = message!.trim().split("\n");
    fresh.push({ hash, email: email!, date: date!, subject, body: rest.join("\n").trim() });
  }
  return since ? [...fresh, ...cache.commits] : fresh;
}

async function readIgnoreFile(repo: string): Promise<string[]> {
  const text = await readFile(join(repo, ".idiolectignore"), "utf8").catch(() => "");
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

async function readCache(path: string): Promise<Cache> {
  return JSON.parse(await readFile(path, "utf8").catch(() => '{"files":{},"commits":[]}'));
}

async function writeCache(path: string, cache: Cache) {
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "*\n");
  await writeFile(path, JSON.stringify(cache));
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const next = async (): Promise<void> => { while (i < items.length) await fn(items[i++]!); };
  await Promise.all(Array.from({ length: size }, next));
}
