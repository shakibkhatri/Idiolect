import { loadServedProfile, loadRepoConfig, loadUserConfig, profilePath, renderStyleMd, saveProfile, updateRules, userConfigPath, type Profile, type Rule } from "@shakibkhatri/idiolect-core";
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** STYLE.md next to the profile mirrors the stored rules, so every rule change re-renders it. */
export async function writeStyle(profile: Profile, threshold: number) {
  await writeFile(profilePath(profile.developer.emails[0]!).replace(/\.json$/, ".STYLE.md"), renderStyleMd(profile, { threshold }));
}

async function load(repo: string) {
  const user = await loadUserConfig();
  if (!user) throw new Error(`no ${userConfigPath()}, run: idiolect init`);
  const profile = await loadServedProfile(resolve(repo));
  if (!profile) throw new Error("no profile, run: idiolect scan");
  return profile;
}

async function decide(ids: string[], status: "approved" | "rejected" | "edited", repo: string, text?: string) {
  const profile = updateRules(await load(repo), ids, status, text);
  await saveProfile(profile);
  await writeStyle(profile, (await loadRepoConfig(resolve(repo))).confidenceThreshold);
  for (const id of ids) console.log(`${status.padEnd(9)} ${id}`);
  console.log("run idiolect sync to update agent files, the MCP server picks this up on its next call");
}

const tag = (r: Rule) => (r.repo ? `[${r.repo.split("/").pop()}] ` : "");

export function rulesCommand(): Command {
  const rules = new Command("rules").description("list, approve, reject or edit the rules in your profile");
  const repoOpt = (c: Command) => c.option("--repo <path>", "repository path, for the confidence threshold", ".");

  repoOpt(rules.command("list").description("one line per rule: status, confidence, id, text"))
    .option("--status <status>", "auto | pending | approved | rejected | edited")
    .option("--lang <language>", "kotlin | any")
    .option("--category <category>", "naming | comments | structure | errors | framework | commits | avoid")
    .action(async (o: { repo: string; status?: string; lang?: string; category?: string }) => {
      const profile = await load(o.repo);
      const { confidenceThreshold } = await loadRepoConfig(resolve(o.repo));
      const width = (process.stdout.columns || 120) - 1;
      const rows = profile.rules.filter((r) => (!o.status || r.status === o.status) && (!o.lang || r.language === o.lang) && (!o.category || r.category === o.category));
      for (const r of rows) {
        const served = r.confidence >= confidenceThreshold ? " " : "-";
        const line = `${r.status.padEnd(8)} ${served}${r.confidence.toFixed(2)}  ${r.id}  ${tag(r)}${r.text}`;
        console.log(line.length > width ? `${line.slice(0, width - 1)}…` : line);
      }
      const by = (st: string) => rows.filter((r) => r.status === st).length;
      console.log(`\n${rows.length} rules (${by("auto")} auto, ${by("pending")} pending, ${by("approved")} approved, ${by("edited")} edited, ${by("rejected")} rejected). "-" before the confidence means below the threshold ${confidenceThreshold}, stored but not served.`);
    });

  repoOpt(rules.command("show <id>").description("full text and evidence of one rule")).action(async (id: string, o: { repo: string }) => {
    const r = (await load(o.repo)).rules.find((x) => x.id === id);
    if (!r) throw new Error(`no rule ${id}, see: idiolect rules list`);
    console.log(`${r.id}\n  ${r.text}\n  status ${r.status}, confidence ${r.confidence}, ${r.scope}, ${r.language}, ${r.category}${r.repo ? `, project rule for ${r.repo}` : ""}${r.learnedIn ? `, learned in ${r.learnedIn}` : ""}`);
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
