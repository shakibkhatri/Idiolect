import { git, loadRepoConfig, repoConfigPath } from "@shakibkhatri/idiolect-core";
import { Command } from "commander";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DEFAULT_TARGETS, removeBlock, START } from "./sync.js";
import { term, type Term } from "./term.js";
import { hookFiles, removeHook } from "./unbot.js";

export type Level = 1 | 2 | 3;
/** The keys in the repo config that choose what is served. */
const STYLE_KEYS = ["styles", "profile", "borrow"];
const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

/** Everything idiolect left behind, found without changing anything. Paths in the repo are relative to it. */
export type Found = {
  blocks: { file: string; deletes: boolean }[];
  configKeys: string[];
  hooks: { file: string; deletes: boolean }[];
  lefthook?: number;
  dir?: { reports: number; decisions: boolean; committed: boolean };
  home?: string;
};

const read = (path: string) => readFile(path, "utf8").catch(() => undefined);
const exists = (path: string) => stat(path).then(() => true, () => false);

/** The known agent files, the configured targets, and any file in the repo root that holds the start marker. */
async function agentFiles(repo: string): Promise<string[]> {
  const targets = (await loadRepoConfig(repo).catch(() => undefined))?.sync.targets ?? [];
  const root: string[] = [];
  for (const e of await readdir(repo, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && (await stat(join(repo, e.name))).size <= MAX_SCANNED_BYTES) root.push(e.name);
  }
  return [...new Set([...DEFAULT_TARGETS, ...targets, ...root])];
}

export async function find(repo: string, home = join(homedir(), ".idiolect")): Promise<Found> {
  const found: Found = { blocks: [], configKeys: [], hooks: [] };
  for (const file of await agentFiles(repo)) {
    const text = await read(join(repo, file));
    if (!text?.includes(START)) continue;
    const rest = removeBlock(text);
    if (rest !== null) found.blocks.push({ file, deletes: rest === undefined });
  }
  const config = JSON.parse((await read(repoConfigPath(repo))) ?? "{}") as Record<string, unknown>;
  found.configKeys = STYLE_KEYS.filter((k) => k in config);
  for (const path of await hookFiles(repo)) {
    const text = await read(path);
    const rest = text === undefined ? null : removeHook(text);
    if (rest !== null) found.hooks.push({ file: relative(repo, path), deletes: rest === undefined });
  }
  const line = ((await read(join(repo, "lefthook.yml"))) ?? "").split("\n").findIndex((l) => l.includes("idiolect"));
  if (line >= 0) found.lefthook = line + 1;
  const dir = join(repo, ".idiolect");
  if (await exists(dir)) {
    found.dir = {
      reports: (await readdir(join(dir, "eval")).catch(() => [])).filter((f) => f.endsWith(".json")).length,
      decisions: await exists(join(dir, "overrides.json")),
      committed: !!(await git(repo, ["ls-files", ".idiolect"]).catch(() => "")).trim(),
    };
  }
  if (await exists(home)) found.home = home;
  return found;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const dirHolds = (d: NonNullable<Found["dir"]>) => ["settings", ...(d.decisions ? ["your rule decisions"] : []), "the cache", ...(d.reports ? [plural(d.reports, "eval report")] : [])].join(", ");

/** What was found, by level, with the real paths. */
export function renderFound(repo: string, f: Found, t: Term = term): string {
  const one = [
    ...f.blocks.map((b) => [b.file, b.deletes ? "the style block, nothing else is in the file, so it is deleted" : "the style block, your own text stays"]),
    ...(f.configKeys.length ? [[".idiolect/config.json", `the choice of style (${f.configKeys.join(", ")})`]] : []),
  ];
  const two = [
    ...f.hooks.map((h) => [h.file, h.deletes ? "the idiolect line, nothing else is in the hook, so it is deleted" : "the idiolect line, your other hooks stay"]),
    ...(f.dir ? [[".idiolect/", dirHolds(f.dir)]] : []),
  ];
  const three = f.home ? [[f.home, "your own learned style and settings, shared by every project"]] : [];
  if (!one.length && !two.length && !three.length) return `idiolect left nothing in ${repo}, and there is no ${join(homedir(), ".idiolect")}.`;
  const width = Math.min(34, Math.max(...[...one, ...two, ...three].map(([path]) => path!.length)));
  const section = (n: Level, title: string, rows: string[][]) => [`${t.bold(String(n))}  ${t.bold(title)}`, ...(rows.length ? rows.map(([path, what]) => `     ${t.accent(path!.padEnd(width))}  ${what}`) : [t.dim("     nothing found")])];
  return [
    `idiolect left this in ${repo}:`, "",
    ...section(1, "The style", one),
    ...section(2, "Everything in this project, the style included", two),
    ...section(3, "Everything on this machine, this project included", three),
    ...(f.lefthook ? ["", `lefthook.yml line ${f.lefthook} runs idiolect. You added it by hand, so it is yours to take out.`] : []),
  ].join("\n");
}

/** Removes up to the given level and returns one line per thing removed. */
export async function apply(repo: string, f: Found, level: Level): Promise<string[]> {
  const done: string[] = [];
  for (const b of f.blocks) {
    const path = join(repo, b.file);
    const rest = removeBlock((await read(path)) ?? "");
    if (rest === null) continue;
    if (rest === undefined) await rm(path); else await writeFile(path, rest);
    done.push(rest === undefined ? `deleted  ${b.file}` : `removed  the style block from ${b.file}`);
  }
  if (level === 1 && f.configKeys.length) {
    const config = JSON.parse((await read(repoConfigPath(repo))) ?? "{}") as Record<string, unknown>;
    for (const k of STYLE_KEYS) delete config[k];
    await writeFile(repoConfigPath(repo), JSON.stringify(config, null, 2) + "\n");
    done.push(`removed  ${f.configKeys.join(", ")} from .idiolect/config.json`);
  }
  if (level === 1) return done;
  for (const h of f.hooks) {
    const path = join(repo, h.file);
    const rest = removeHook((await read(path)) ?? "");
    if (rest === null) continue;
    if (rest === undefined) await rm(path); else await writeFile(path, rest);
    done.push(rest === undefined ? `deleted  ${h.file}` : `removed  the idiolect line from ${h.file}`);
  }
  if (f.dir) {
    await rm(join(repo, ".idiolect"), { recursive: true, force: true });
    done.push("deleted  .idiolect/");
  }
  if (level === 3 && f.home) {
    await rm(f.home, { recursive: true, force: true });
    done.push(`deleted  ${f.home}`);
  }
  return done;
}

/** What a removal cannot undo, and what is still there after it. */
function leftovers(f: Found, level: Level): string[] {
  const left = [
    ...(level === 1 && (f.hooks.length || f.dir) ? ["Still here: the git hooks and .idiolect/, idiolect remove --project takes them out.", "idiolect use brings the style back."] : []),
    ...(level === 2 && f.home ? [`Still here: ${f.home}, your own style for every project.`] : []),
    ...(level > 1 && f.dir?.committed ? [".idiolect/ was committed, so removing it is a change you have to commit."] : []),
    ...(f.lefthook ? [`lefthook.yml line ${f.lefthook} still runs idiolect, take it out by hand.`] : []),
    "Not undone: files that unbot --fix rewrote, git has the old versions.",
    "Not touched: the MCP server in your agent's own config. Remove it with: claude mcp remove idiolect",
  ];
  return left;
}

/** Level 2 and 3 delete things that cannot be brought back, so they are named before the user agrees. */
export function warning(f: Found, level: Level): string | undefined {
  const project = f.dir ? ["the settings in .idiolect/config.json", ...(f.dir.reports ? [`${plural(f.dir.reports, "eval report")} and their quiz picks`] : []), ...(f.dir.decisions ? ["your rule decisions"] : [])] : [];
  const lost = level === 1 ? [] : [...project, ...(level === 3 && f.home ? ["your learned style, which only a new scan rebuilds"] : [])];
  return lost.length ? `This cannot be brought back: ${lost.join(", ")}.` : undefined;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } catch { return ""; } finally { rl.close(); }
}

export async function removeStyle(repo: string) {
  const found = await find(repo);
  const done = await apply(repo, found, 1);
  console.log(done.length ? `${done.join("\n")}\n\nYour agent no longer follows the style. idiolect use brings it back.` : "This project has no style to remove.");
}

export function removeCommand(): Command {
  return new Command("remove").description("take idiolect out of this project again: the style, everything in the project, or everything on this machine")
    .option("--repo <path>", "repository path", ".")
    .option("--style", "level 1: the style block in the agent files and the choice of style")
    .option("--project", "level 2: also the git hooks and the .idiolect folder")
    .option("--everything", "level 3: also ~/.idiolect, your own learned style")
    .option("--yes", "do not ask before deleting what cannot be brought back")
    .option("--dry-run", "only list what would be removed")
    .action(async (o: { repo: string; style?: boolean; project?: boolean; everything?: boolean; yes?: boolean; dryRun?: boolean }) => {
      const repo = (await git(resolve(o.repo), ["rev-parse", "--show-toplevel"]).catch(() => "")).trim() || resolve(o.repo);
      const found = await find(repo);
      console.log(renderFound(repo, found));
      let level: Level | undefined = o.everything ? 3 : o.project ? 2 : o.style ? 1 : undefined;
      const interactive = process.stdin.isTTY === true && term.interactive;
      const nothing = !found.blocks.length && !found.configKeys.length && !found.hooks.length && !found.dir && !found.home;
      if (o.dryRun || nothing) return;
      if (!level) {
        if (!interactive) { console.log("\nNothing was changed. Remove with: idiolect remove --style, --project or --everything"); return; }
        console.log("");
        const answer = await ask("Type a level to remove, or Enter to leave: ");
        if (!answer) return;
        if (!/^[123]$/.test(answer)) throw new Error(`${answer} is not one of 1 to 3, nothing was changed`);
        level = Number(answer) as Level;
      }
      const warn = warning(found, level);
      if (warn && !o.yes) {
        if (!interactive) throw new Error(`${warn}\nrun it again with --yes to go ahead`);
        console.log(`\n${term.warn(warn)}`);
        if ((await ask("Type yes to remove it: ")).toLowerCase() !== "yes") { console.log("Nothing was changed."); return; }
      }
      const done = await apply(repo, found, level);
      console.log(`\n${done.length ? done.join("\n") : "There was nothing to remove at this level."}\n\n${leftovers(found, level).join("\n")}`);
    });
}
