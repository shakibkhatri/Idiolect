import { git, loadRepoConfig, loadServedProfile, loadStyle, loadUserConfig, renderStyleMd, type Language, type Rule } from "@shakibkhatri/idiolect-core";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ago, commitsSince } from "./refresh.js";
import { LANGUAGE_NAMES, LANGUAGES } from "./styles.js";
import { START, syncTargets } from "./sync.js";
import { canAsk, select, term, type Term } from "./term.js";

/** Where a project stands: no style, a house style, the developer's own, or their own without a scan of this repo. */
export type ProjectState = {
  kind: "none" | "house" | "own" | "unscanned";
  styles: { language: Language; id: string; summary: string }[];
  named?: string;
  rules: number;
  pending: Pick<Rule, "id" | "text">[];
  updated?: string;
  scan?: { since: number; scannedAt: string };
  refreshEvery: number;
  files: { written: string[]; stale: string[] };
};

/** One thing the user can do next. Each run is an existing command, so the line can name it. */
export type Step = { label: string; runs: string[][] };

const NONE: ProjectState = { kind: "none", styles: [], rules: 0, pending: [], refreshEvery: 0, files: { written: [], stale: [] } };

/** Agent files that hold the block, and the ones a sync would change. A dry run, nothing is written. */
async function agentFiles(repo: string, body: string, targets?: string[]): Promise<ProjectState["files"]> {
  const written: string[] = [], stale: string[] = [], missing: string[] = [];
  for (const r of await syncTargets(repo, body, targets, undefined, false)) {
    if (r.status === "unchanged") written.push(r.file);
    else if (r.status === "created") missing.push(r.file);
    else if (r.status === "updated") {
      stale.push(r.file);
      if ((await readFile(join(repo, r.file), "utf8")).includes(START)) written.push(r.file);
    }
  }
  // a file that does not exist only counts when the style is in no file at all
  return { written, stale: written.length ? stale : [...stale, ...missing] };
}

export async function projectState(repo: string): Promise<ProjectState> {
  const config = await loadRepoConfig(repo);
  const served = await loadServedProfile(repo);
  if (!served) return NONE;
  const files = await agentFiles(repo, renderStyleMd(served, { threshold: config.confidenceThreshold, repo }), config.sync.targets);
  const base = { ...NONE, rules: served.rules.length, pending: served.rules.filter((r) => r.status === "pending"), refreshEvery: config.refresh.everyCommits, files };
  const picked = config.styles ?? {};
  if (Object.values(picked).some(Boolean)) {
    const styles = await Promise.all(LANGUAGES.filter((l) => picked[l]).map(async (language) => { const style = await loadStyle(picked[language]!); return { language, id: style.id, summary: style.summary }; }));
    return { ...base, kind: "house", styles };
  }
  const user = await loadUserConfig();
  const named = config.profile && !user?.emails.some((e) => e.toLowerCase() === config.profile!.toLowerCase()) ? config.profile : undefined;
  const scan = await commitsSince(served, repo);
  return { ...base, kind: scan || named ? "own" : "unscanned", named, updated: served.generatedAt, scan };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const MAX_PENDING = 5;

function filesLine(f: ProjectState["files"]): string {
  if (!f.written.length) return "not written yet";
  const current = f.written.filter((file) => !f.stale.includes(file));
  if (!f.stale.length) return `${current.join(", ")}, up to date`;
  return `${current.length ? `${current.join(", ")}, ` : ""}out of date: ${f.stale.join(", ")}`;
}

export function renderState(s: ProjectState, t: Term = term): string {
  const row = (label: string, text: string) => `  ${t.dim(label.padEnd(11))}  ${text}`;
  if (s.kind === "none") return ["This project has no style yet.", "idiolect gives your AI coding agent a style to write in.", "Pick a house style, or learn your own from this project's git history."].join("\n");
  if (s.kind === "unscanned") return [`You have a style of your own, ${plural(s.rules, "rule")}, but it has not learned from this project yet.`, "Your agent reads it here once it is written into the agent files."].join("\n");
  if (s.kind === "house") {
    const width = Math.max(...s.styles.map((x) => x.id.length));
    return [
      `This project follows ${s.styles.length === 1 ? "a house style" : "house styles"}.`, "",
      ...s.styles.map((x) => row(LANGUAGE_NAMES[x.language], `${t.accent(x.id.padEnd(width))}  ${x.summary}`)),
      row("Agent files", filesLine(s.files)),
    ].join("\n");
  }
  const scan = s.scan && `scanned ${ago(s.scan.scannedAt)}, ${plural(s.scan.since, "commit")} since, ${s.scan.since >= s.refreshEvery ? "refresh due now" : `refresh due in ${s.refreshEvery - s.scan.since}`}`;
  return [
    s.named ? `This project follows the style stored for ${s.named}.` : "This project follows your own style.", "",
    row("Style", `${plural(s.rules, "rule")}, ${s.pending.length ? t.warn(`${s.pending.length} pending`) : "none pending"}, updated ${ago(s.updated!)}`),
    ...(scan ? [row("This repo", scan)] : []),
    row("Agent files", filesLine(s.files)),
    ...(s.pending.length ? ["", "Pending rules, decide with idiolect rules approve|reject|edit <id>:"] : []),
    ...s.pending.slice(0, MAX_PENDING).map((r) => `  ${r.text}  ${t.dim(r.id)}`),
    ...(s.pending.length > MAX_PENDING ? [`  and ${s.pending.length - MAX_PENDING} more: idiolect rules list --status pending`] : []),
  ].join("\n");
}

/** At most five steps, and only the ones that apply to this state. */
export function stepsFor(s: ProjectState): Step[] {
  const sync: Step[] = s.files.stale.length ? [{ label: s.files.written.length ? "Write the agent files again" : "Write the style into the agent files", runs: [["sync"]] }] : [];
  const check: Step = { label: "Check the project against the style", runs: [["unbot", "--all"]] };
  if (s.kind === "none") return [{ label: "Pick a house style", runs: [["use"]] }, { label: "Learn my own style from my git history", runs: [["init"], ["scan"]] }];
  if (s.kind === "unscanned") return [{ label: "Learn from this project's history too", runs: [["scan"]] }, { label: "Pick a house style instead", runs: [["use"]] }];
  const remove: Step = { label: "Take idiolect out of this project", runs: [["remove"]] };
  if (s.kind === "house") return [{ label: "Change the house style", runs: [["use"]] }, { label: "Review its rules in the browser", runs: [["ui"]] }, check, ...sync, remove];
  const rescan: Step[] = s.scan?.since && !s.named ? [{ label: `Learn from the ${plural(s.scan.since, "new commit")}`, runs: [["scan"]] }] : [];
  const review: Step = { label: s.pending.length ? `Review the ${plural(s.pending.length, "pending rule")} in the browser` : "Review the rules in the browser", runs: [["ui"]] };
  return [...rescan, review, ...sync, check, remove];
}

const commandOf = (step: Step) => step.runs.map((r) => `idiolect ${r.join(" ")}`).join(", then ");

/** The steps as commands, for a pipe, a script and status. A terminal gets them as a list to choose from. */
export function renderSteps(steps: Step[]): string {
  const width = Math.max(...steps.map((s) => commandOf(s).length));
  return ["Next:", ...steps.map((s) => `  ${commandOf(s).padEnd(width)}  ${s.label}`)].join("\n");
}

// the step runs as the same build of the CLI, in the user's terminal
const run = (args: string[], repo: string) => new Promise<number>((done) => {
  spawn(process.execPath, [process.argv[1]!, ...args], { stdio: "inherit", cwd: repo }).on("close", (code) => done(code ?? 1));
});

/** Reports where the project stands. In a terminal it then asks for a step by number, Enter leaves. */
export async function start(o: { repo: string; prompt: boolean }) {
  const repo = (await git(resolve(o.repo), ["rev-parse", "--show-toplevel"]).catch(() => "")).trim() || resolve(o.repo);
  const state = await projectState(repo);
  const steps = stepsFor(state);
  if (!o.prompt || !canAsk()) { console.log(`${renderState(state)}\n\n${renderSteps(steps)}`); return; }
  console.log(`${renderState(state)}\n`);
  // the list starts on Leave, so Enter alone changes nothing
  const step = await select(steps.map((s) => ({ value: s, label: s.label, hint: commandOf(s) })), { numbered: true, leave: "Leave", start: steps.length });
  if (!step) return;
  console.log("");
  for (const args of step.runs) {
    console.log(term.dim(`> idiolect ${args.join(" ")}`));
    const code = await run(args, repo);
    if (code !== 0) process.exit(code);
  }
}

export function statusCommand(): Command {
  return new Command("status").description("where this project stands: the style your agent reads, its agent files and what to do next")
    .option("--repo <path>", "repository path", ".")
    .action((o: { repo: string }) => start({ repo: o.repo, prompt: false }));
}
