#!/usr/bin/env node
import { analyzeKotlin, isTestPath, collect, detectEmail, emptyProfile, emptyStats, git, loadConfig, loadProfile, mergeStats, profilePath, saveConfig, saveProfile, upsertSource, analyzeCommits, configPath, type Config } from "@idiolect/core";
import { Command } from "commander";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const program = new Command().name("idiolect").description("Learn your coding style and feed it to AI agents");

program.command("init")
  .description("detect your author emails and languages, write .idiolect/config.json")
  .option("--repo <path>", "repository path", ".")
  .option("--email <email...>", "your author emails (skips the prompt)")
  .option("-y, --yes", "accept detected defaults without prompting")
  .action(async (o: { repo: string; email?: string[]; yes?: boolean }) => {
    const repo = resolve(o.repo);
    const authors = await listAuthors(repo);
    const mine = await detectEmail(repo);
    let emails = o.email;
    if (!emails) {
      console.log("Authors in this repo:");
      authors.forEach((a, i) => console.log(`  ${i + 1}. ${a.email}  (${a.name}, ${a.commits} commits)${a.email === mine ? "  <- git config" : ""}`));
      const def = authors.map((a, i) => (a.email === mine || sameName(a.name, authors.find((x) => x.email === mine)?.name) ? i + 1 : 0)).filter(Boolean);
      const answer = o.yes ? "" : (await ask(`Which are you? numbers, comma separated [${def.join(",")}]: `)).trim();
      const picks = answer ? answer.split(/[,\s]+/).map(Number) : def;
      emails = picks.map((i) => authors[i - 1]?.email).filter((e): e is string => !!e);
    }
    if (!emails.length) throw new Error("no emails selected");
    const kotlinFiles = (await git(repo, ["ls-files", "*.kt", "*.kts"])).split("\n").filter(Boolean).length;
    const languages: Config["languages"] = kotlinFiles ? ["kotlin"] : [];
    const config: Config = { ...(await loadConfig(repo)), emails, languages } as Config;
    await saveConfig(repo, config);
    console.log(`\nwrote ${configPath(repo)}`);
    console.log(`  emails:    ${emails.join(", ")}`);
    console.log(`  languages: ${languages.join(", ") || "none supported yet (kotlin only for now)"}`);
    console.log(`\nnext: idiolect scan`);
  });

program.command("scan")
  .description("collect your code, analyze it, merge into your personal profile")
  .option("--repo <path>", "repository path", ".")
  .option("--no-cache", "ignore the blame cache")
  .action(async (o: { repo: string; cache: boolean }) => {
    const repo = resolve(o.repo);
    const config = await loadConfig(repo);
    if (!config) throw new Error(`no ${configPath(repo)}, run: idiolect init`);
    const t0 = Date.now();
    const c = await collect({ repo, emails: config.emails, ignore: config.ignore, cache: o.cache });
    const linesOwned = c.files.reduce((n, f) => n + f.ownedLines, 0);
    process.stderr.write(`collected ${c.files.length} files, ${linesOwned} owned lines, ${c.commits.length} commits (${Date.now() - t0}ms)\n`);

    let kotlin = emptyStats();
    for (const f of c.files) kotlin = mergeStats(kotlin, await analyzeKotlin(await git(repo, ["show", `${c.head}:${f.path}`]), f.ranges, { test: isTestPath(f.path) }));
    const commitStats = analyzeCommits(c.commits);

    const primary = config.emails[0]!;
    const name = (await git(repo, ["config", "user.name"]).catch(() => "")).trim() || primary;
    const profile = upsertSource(await loadProfile(primary) ?? emptyProfile(name, config.emails), {
      repo, head: c.head, scannedAt: new Date().toISOString(), commits: c.commits.length, linesOwned, stats: { kotlin }, commitStats,
    });
    await saveProfile(profile);

    const { summarizeKotlin, summarizeCommits } = await import("./summary.js");
    console.log(`\nThis repo`);
    console.log(summarizeKotlin(kotlin));
    console.log(summarizeCommits(commitStats));
    if (profile.sources.length > 1) {
      console.log(`\nMerged profile (${profile.sources.length} repos)`);
      console.log(summarizeKotlin(profile.stats.kotlin!));
      console.log(summarizeCommits(profile.commitStats));
    }
    console.log(`\nprofile: ${profilePath(primary)}`);
  });

async function listAuthors(repo: string) {
  const out = await git(repo, ["shortlog", "-sne", "--all", "--no-merges"]);
  return out.split("\n").map((l) => l.match(/^\s*(\d+)\s+(.*?)\s+<(.+)>$/)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ commits: Number(m[1]), name: m[2]!, email: m[3]!.toLowerCase() }));
}
const sameName = (a: string, b?: string) => !!b && a.toLowerCase().replace(/\s+/g, "") === b.toLowerCase().replace(/\s+/g, "");
async function ask(q: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(q); } finally { rl.close(); }
}

program.parseAsync().catch((e: Error) => { console.error(`error: ${e.message}`); process.exit(1); });
