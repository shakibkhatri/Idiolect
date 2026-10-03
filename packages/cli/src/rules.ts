import { git, isServed, loadServedProfile, loadRepoConfig, ruleKind, profilePath, renderStyleMd, saveOverrides, saveProfile, SECTIONS, updateRules, type Profile, type Rule } from "@shakibkhatri/idiolect-core";
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { term, type Term } from "./term.js";

/** STYLE.md next to the profile mirrors the stored rules, so every rule change re-renders it. */
export async function writeStyle(profile: Profile, threshold: number) {
  await writeFile(profilePath(profile.developer.emails[0]!).replace(/\.json$/, ".STYLE.md"), renderStyleMd(profile, { threshold }));
}

export const NO_PROFILE = "this project has no style yet\nrun: idiolect use to pick a house style, or idiolect init then idiolect scan to learn your own";

async function load(repo: string) {
  const profile = await loadServedProfile(resolve(repo));
  if (!profile) throw new Error(NO_PROFILE);
  return profile;
}

/** A decision is written where the served profile lives: its own file, or the repo's overrides for a shipped style. */
export async function persist(profile: Profile, repo: string, threshold: number) {
  if (profile.shipped) return saveOverrides(repo, profile);
  await saveProfile(profile);
  await writeStyle(profile, threshold);
}

async function decide(ids: string[], status: "approved" | "rejected" | "edited", repo: string, text?: string) {
  const profile = updateRules(await load(repo), ids, status, text);
  await persist(profile, resolve(repo), (await loadRepoConfig(resolve(repo))).confidenceThreshold);
  for (const id of ids) console.log(`${status.padEnd(9)} ${id}`);
  console.log("run idiolect sync to update agent files, the MCP server picks this up on its next call");
}

const tag = (r: Rule) => (r.repo ? `[${r.repo.split("/").pop()}] ` : "");

// no output may need more than 100 columns, the Windows terminal it is tested in is that narrow
const WIDTH = 100;
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (lines.length && lines.at(-1)!.length + 1 + word.length <= width) lines.push(`${lines.pop()} ${word}`); else lines.push(word);
  }
  return lines.length ? lines : [""];
}

type Mark = "served" | "held back" | "pending" | "rejected";
const MARKS: Record<Mark, string> = { served: "+", "held back": "-", pending: "?", rejected: "x" };

/** Grouped by section the way the rendered style is, the rule text first and the id last, where it is only needed to type a command. */
export function renderRules(rows: Rule[], served: (r: Rule) => boolean, t: Term = term): string {
  if (!rows.length) return "No rules match.";
  const markOf = (r: Rule): Mark => (r.status === "pending" ? "pending" : r.status === "rejected" ? "rejected" : served(r) ? "served" : "held back");
  const paint: Record<Mark, (s: string) => string> = { served: t.ok, "held back": t.dim, pending: t.warn, rejected: t.bad };
  const out: string[] = [];
  for (const [category, title] of SECTIONS) {
    const rules = rows.filter((r) => r.category === category);
    if (!rules.length) continue;
    out.push(t.bold(title), ...rules.map((r) => {
      const lines = wrap(`${tag(r)}${r.text}`, WIDTH - 4);
      // the id stays on the last line of the text when it fits, else it gets its own
      if (lines.at(-1)!.length + 2 + r.id.length <= WIDTH - 4) lines.push(`${lines.pop()}  ${t.dim(r.id)}`); else lines.push(t.dim(r.id));
      return `  ${paint[markOf(r)](MARKS[markOf(r)])} ${lines.join("\n    ")}`;
    }), "");
  }
  const count = (m: Mark) => rows.filter((r) => markOf(r) === m).length;
  const marks = Object.keys(MARKS) as Mark[];
  out.push(`${rows.length} ${rows.length === 1 ? "rule" : "rules"}: ${marks.map((m) => `${count(m)} ${m}`).join(", ")}.`);
  out.push(t.dim(`${marks.map((m) => `${MARKS[m]} ${m}`).join("   ")}. Held back means your agent does not get the rule.`));
  out.push("Next: idiolect rules approve|reject|edit <id>, or idiolect ui to do it in the browser.");
  return out.join("\n");
}

export function rulesCommand(): Command {
  const rules = new Command("rules").description("approve, reject or edit rules");
  const repoOpt = (c: Command) => c.option("--repo <path>", "repository path, for the confidence threshold", ".");

  repoOpt(rules.command("list").description("the rules by section, each marked served, held back, pending or rejected"))
    .option("--status <status>", "auto | pending | approved | rejected | edited")
    .option("--lang <language>", "kotlin | typescript | python | go | any")
    .option("--category <category>", "naming | comments | structure | errors | framework | commits | avoid")
    .action(async (o: { repo: string; status?: string; lang?: string; category?: string }) => {
      const profile = await load(o.repo);
      const repo = (await git(resolve(o.repo), ["rev-parse", "--show-toplevel"]).catch(() => "")).trim() || resolve(o.repo);
      const { confidenceThreshold } = await loadRepoConfig(repo);
      const rows = profile.rules.filter((r) => (!o.status || r.status === o.status) && (!o.lang || r.language === o.lang) && (!o.category || r.category === o.category));
      console.log(renderRules(rows, (r) => isServed(r, confidenceThreshold, profile.borrowed) && (!r.repo || r.repo === repo)));
    });

  repoOpt(rules.command("show <id>").description("full text and evidence of one rule")).action(async (id: string, o: { repo: string }) => {
    const r = (await load(o.repo)).rules.find((x) => x.id === id);
    if (!r) throw new Error(`no rule ${id}, see: idiolect rules list`);
    console.log(`${r.id}\n  ${r.text}\n  status ${r.status}, confidence ${r.confidence}, ${r.scope}, ${r.language}, ${r.category}, ${ruleKind(r)}${r.repo ? `, served only in ${r.repo}` : ""}${r.learnedIn ? `, learned in ${r.learnedIn}` : ""}`);
    if (r.evidence.metric) console.log(`  metric ${r.evidence.metric.name} = ${r.evidence.metric.value}, n = ${r.evidence.metric.sampleSize}`);
    for (const e of r.evidence.examples) console.log(`  ${e.file.startsWith("commit:") ? e.file : `${e.file}:${e.line}`}\n    ${e.snippet.split("\n").join("\n    ")}`);
  });

  repoOpt(rules.command("approve <id...>").description("serve these rules and keep them across rescans")).action((ids: string[], o: { repo: string }) => decide(ids, "approved", o.repo));
  repoOpt(rules.command("reject <id...>").description("stop serving these rules, a rescan does not bring them back")).action((ids: string[], o: { repo: string }) => decide(ids, "rejected", o.repo));
  repoOpt(rules.command("edit <id> [text]").description("replace the rule text, opens $EDITOR when no text is given"))
    .action(async (id: string, text: string | undefined, o: { repo: string }) => {
      if (!text) {
        const r = (await load(o.repo)).rules.find((x) => x.id === id);
        if (!r) throw new Error(`no rule ${id}, see: idiolect rules list`);
        const file = join(await mkdtemp(join(tmpdir(), "idiolect-rule-")), `${id}.md`);
        await writeFile(file, r.text + "\n");
        const res = spawnSync(process.env.EDITOR || "vi", [file], { stdio: "inherit" });
        if (res.status !== 0) throw new Error("editor exited without saving, rule unchanged");
        text = await readFile(file, "utf8");
        if (text.trim() === r.text) { console.log("unchanged"); return; }
      }
      await decide([id], "edited", o.repo, text);
    });
  return rules;
}
