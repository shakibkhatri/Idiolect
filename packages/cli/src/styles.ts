import { buildStyle, composeStyles, git, languageOf, listStyles, loadProfile, loadRepoConfig, loadServedProfile, loadStyle, monthYear, renderStyleMd, STYLES_DIR, updateRepoConfig, type Language, type Picked, type Style } from "@shakibkhatri/idiolect-core";
import { Command } from "commander";
import { execFile } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { syncTargets } from "./sync.js";

const LANGUAGES = ["kotlin", "typescript", "python", "go"] as const;
const LANGUAGE_NAMES: Record<Language, string> = { kotlin: "Kotlin", typescript: "TypeScript", python: "Python", go: "Go" };

/** One short line per style under its language, so a long catalogue stays readable in a narrow terminal. Numbered when it is a menu. */
export function renderList(all: Style[], opts: { numbered?: boolean; hidden?: number } = {}): string {
  if (!all.length) return "no styles ship with this build";
  const width = Math.max(...all.map((s) => s.id.length));
  const out: string[] = [];
  let n = 0;
  for (const l of LANGUAGES) {
    const styles = all.filter((s) => s.language === l);
    if (!styles.length) continue;
    out.push(LANGUAGE_NAMES[l]);
    for (const s of styles) out.push(`  ${opts.numbered ? `${String(++n).padStart(2)}  ` : ""}${s.id.padEnd(width)}  ${s.summary}${s.experimental ? "  (experimental)" : ""}`);
    out.push("");
  }
  if (opts.hidden) out.push(`${opts.hidden} more for other languages: idiolect styles --all`);
  return out.join("\n").trimEnd();
}

/** The order the menu numbers follow: by language, then as listed. */
export const menuOrder = (all: Style[]) => LANGUAGES.flatMap((l) => all.filter((s) => s.language === l));

/** Languages worth offering a style for: at least 5% of the project's source files, and always the biggest one. */
export function relevantLanguages(counts: Partial<Record<Language, number>>): Language[] {
  const entries = (Object.entries(counts) as [Language, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((n, [, c]) => n + c, 0);
  return entries.filter(([, c], i) => i === 0 || c / total >= 0.05).map(([l]) => l);
}

const SKIP_DIRS = new Set(["node_modules", "build", "dist", "out", "vendor", "target"]);
async function walk(dir: string, depth: number, files: string[]) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) { if (depth > 0 && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) await walk(join(dir, e.name), depth - 1, files); }
    else files.push(e.name);
  }
}

/** Counts source files per language: what git tracks or would track, or a shallow walk outside a git repo. */
export async function projectLanguages(repo: string): Promise<Language[]> {
  let files = (await git(repo, ["ls-files", "--cached", "--others", "--exclude-standard"]).catch(() => "")).split("\n").filter(Boolean);
  if (!files.length) await walk(repo, 6, files = []);
  const counts: Partial<Record<Language, number>> = {};
  for (const f of files) { const l = languageOf(f); if (l) counts[l] = (counts[l] ?? 0) + 1; }
  return relevantLanguages(counts);
}

/** Reads menu numbers. One style per language, so two numbers of the same language are refused. */
export function parsePick(input: string, shown: Style[]): Style[] {
  const picked = input.split(/[\s,]+/).filter(Boolean).map((t) => {
    const s = /^\d+$/.test(t) ? shown[Number(t) - 1] : undefined;
    if (!s) throw new Error(`${t} is not one of 1 to ${shown.length}`);
    return s;
  });
  const twice = LANGUAGES.find((l) => picked.filter((s) => s.language === l).length > 1);
  if (twice) throw new Error(`pick one ${LANGUAGE_NAMES[twice]} style, not several`);
  return picked;
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(q); } catch { return ""; } finally { rl.close(); }
}
const names = (ls: Language[]) => ls.map((l) => LANGUAGE_NAMES[l]).join(ls.length === 2 ? " and " : ", ");

/** The styles for the languages this project uses. Every style when it has no source yet or when asked for all. */
async function forProject(repo: string, everything?: boolean) {
  const all = await listStyles();
  const languages = everything ? [] : await projectLanguages(repo);
  const shown = languages.length ? all.filter((s) => languages.includes(s.language)) : all;
  return { languages, shown: shown.length ? shown : all, hidden: shown.length ? all.length - shown.length : 0 };
}

const toplevel = async (path: string) => (await git(resolve(path), ["rev-parse", "--show-toplevel"]).catch(() => resolve(path))).trim();

export function stylesCommand(): Command {
  const styles = new Command("styles").description("list the styles for the languages this project uses, learned from open source code and reviewed")
    .option("--repo <path>", "repository path", ".")
    .option("--all", "every style, whatever the project is written in")
    .action(async (o: { repo: string; all?: boolean }) => {
      const { shown, hidden } = await forProject(await toplevel(o.repo), o.all);
      console.log(`${renderList(shown, { hidden })}\n\ndetails: idiolect styles show <style>\npick: idiolect use`);
    });

  styles.command("show <id>").description("where a style comes from and the rules it serves")
    .action(async (id: string) => {
      const s = await loadStyle(id);
      const md = renderStyleMd({ ...(await composeStyles({ [s.language]: s.id })), borrowed: ["voice", "layout"] }, { threshold: 0.6 });
      const held = s.rules.filter((r) => r.kind === "idiom").length;
      console.log([
        `${s.id}  ${LANGUAGE_NAMES[s.language]}${s.experimental ? "  experimental: nobody who writes the language has reviewed it" : ""}`,
        s.summary, "",
        `source    ${s.title}, ${s.source.project}, ${s.source.license}`,
        `snapshot  ${s.source.snapshot ? `code up to ${monthYear(s.source.snapshot)}, ` : ""}commit ${s.source.commit.slice(0, 8)}, ${s.source.lines} lines`,
        `rules     ${s.rules.length - held} served${held ? `, ${held} on language features held back` : ""}`, "",
        md.slice(md.indexOf("## ")).trimEnd(),
      ].join("\n"));
    });

  styles.command("build").description("maintainers: cut a shippable style from a scanned and reviewed profile")
    .requiredOption("--email <email>", "the scanned profile in ~/.idiolect/profiles")
    .requiredOption("--id <id>", "style id, like kotlin-tivi")
    .requiredOption("--title <title>", "the project the style is named after")
    .requiredOption("--summary <text>", "one short line on what the style feels like, shown in the list")
    .requiredOption("--language <language>", LANGUAGES.join(" | "))
    .requiredOption("--project <url>", "where the code lives, like github.com/shakibkhatri/Idiolect")
    .requiredOption("--license <license>", "license of the source project")
    .option("--experimental", "nobody who writes the language has reviewed it")
    .option("--out <dir>", "where to write the style", STYLES_DIR)
    .action(async (o: { email: string; id: string; title: string; summary: string; language: string; project: string; license: string; experimental?: boolean; out: string }) => {
      if (!(LANGUAGES as readonly string[]).includes(o.language)) throw new Error(`unknown language ${o.language}`);
      if (o.summary.length > 60) throw new Error(`the summary is ${o.summary.length} characters, keep it to 60 so the list fits a terminal line`);
      const profile = await loadProfile(o.email);
      if (!profile) throw new Error(`no profile for ${o.email}`);
      const style = buildStyle(profile, { id: o.id, title: o.title, summary: o.summary, language: o.language as Language, project: o.project, license: o.license, experimental: o.experimental });
      const unreviewed = profile.rules.filter((r) => !r.evidence.metric && !r.repo && r.status === "auto").length;
      await mkdir(o.out, { recursive: true });
      await writeFile(join(o.out, `${o.id}.json`), JSON.stringify(style, null, 2) + "\n");
      console.log(`wrote ${join(o.out, `${o.id}.json`)}: ${style.rules.length} rules, ${style.rules.filter((r) => !r.evidence.metric).length} of them reviewed voice rules`);
      if (unreviewed) console.log(`${unreviewed} example-backed rules were left out because nobody approved or edited them, see: idiolect rules list --status auto`);
    });
  return styles;
}

const isDir = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);
// Windows has no which, its lookup command is where
export const onPath = (cmd: string) => new Promise<boolean>((res) => execFile(process.platform === "win32" ? "where" : "which", [cmd], (err) => res(!err)));

/** AGENTS.md always. An agent's own file only when that agent is in use: Claude Code installed or a .claude folder, a .cursor folder. */
export async function filesToCreate(repo: string, claudeInstalled: boolean): Promise<Set<string>> {
  const create = new Set(["AGENTS.md"]);
  if (claudeInstalled || (await isDir(join(repo, ".claude")))) create.add("CLAUDE.md");
  if (await isDir(join(repo, ".cursor"))) create.add(".cursor/rules/idiolect.mdc");
  return create;
}

/** Shows the numbered styles for this project and reads the choice. Enter takes the only style of each language when there is no choice to make. */
async function pickFromMenu(repo: string, everything?: boolean): Promise<Style[]> {
  const { languages, shown, hidden } = await forProject(repo, everything);
  const menu = menuOrder(shown);
  if (languages.length) console.log(`This project is written in ${names(languages)}.\n`);
  console.log(`${renderList(menu, { numbered: true, hidden })}\n`);
  const single = LANGUAGES.every((l) => menu.filter((s) => s.language === l).length <= 1);
  const preset = single && languages.length ? menu.map((_, i) => i + 1).join(" ") : "";
  for (;;) {
    const answer = (await ask(`Type the number of the style you want, one per language${preset ? ` [${preset}]` : ""}: `)).trim() || preset;
    if (!answer) throw new Error("no style picked");
    try {
      const picked = parsePick(answer, menu);
      console.log("");
      return picked;
    } catch (e) {
      console.log(`  ${(e as Error).message}`);
      if (!process.stdin.isTTY) throw e;
    }
  }
}

export function useCommand(): Command {
  return new Command("use").description("serve shipped styles in this repo, one per language, and write them into the agent files")
    .argument("[style...]", "style ids, leave out to pick from a numbered list")
    .option("--repo <path>", "repository path", ".")
    .option("--target <file...>", "agent files to write, overrides sync.targets in .idiolect/config.json")
    .option("--all", "offer every style, whatever the project is written in")
    .option("--no-sync", "only record the choice, do not write agent files")
    .action(async (ids: string[], o: { repo: string; target?: string[]; all?: boolean; sync: boolean }) => {
      const repo = await toplevel(o.repo);
      const chosen = ids.length ? await Promise.all(ids.map((id) => loadStyle(id))) : await pickFromMenu(repo, o.all);
      const picked: Picked = { ...(await loadRepoConfig(repo)).styles };
      for (const s of chosen) picked[s.language] = s.id;
      // commit rules come from one style: keep the owner while it is still picked, else the first one named now
      const inUse = new Set(LANGUAGES.map((l) => picked[l]).filter(Boolean));
      if (!picked.commits || !inUse.has(picked.commits)) picked.commits = chosen[0]!.id;
      await updateRepoConfig(repo, { styles: picked });
      for (const l of LANGUAGES) if (picked[l]) console.log(`${l.padEnd(10)} ${picked[l]}`);
      console.log(`${"commits".padEnd(10)} ${picked.commits}`);
      if (!o.sync) return;
      const config = await loadRepoConfig(repo);
      const profile = (await loadServedProfile(repo))!;
      const create = await filesToCreate(repo, await onPath("claude"));
      const results = await syncTargets(repo, renderStyleMd(profile, { threshold: config.confidenceThreshold, repo }), o.target ?? config.sync.targets, create);
      for (const r of results) if (r.status !== "skipped") console.log(`${r.status.padEnd(9)} ${r.file}`);
      // one line for the agents that are not set up here, a row each was noise for someone who uses one agent
      const skipped = results.filter((r) => r.status === "skipped").map((r) => r.file);
      if (skipped.length) console.log(`\nnot written, those agents are not set up here: ${skipped.join(", ")}\nto write one anyway: idiolect use --target <file>`);
    });
}
