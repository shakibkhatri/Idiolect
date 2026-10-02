#!/usr/bin/env node
import { analyzeKotlin, isTestPath, collect, detectEmail, emptyProfile, emptyStats, git, loadUserConfig, saveUserConfig, loadRepoConfig, saveRepoConfig, ensureRepoDir, userConfigPath, repoConfigPath, loadProfile, mergeStats, profilePath, saveProfile, upsertSource, analyzeCommits, collectSamples, createProvider, writeRules, buildPrompt, baselineRules, renderStyleMd, estimateTokens, type UserConfig, type SampleInput } from "@idiolect/core";
import { loadTasks, renderReport, runEval, type Report } from "@idiolect/eval";
import { createIdiolectServer } from "@idiolect/mcp";
import { syncTargets } from "./sync.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const program = new Command().name("idiolect").description("Learn your coding style and feed it to AI agents");
const PROVIDERS = ["claude-cli", "anthropic", "openai", "gemini", "openai-compatible", "none"] as const;
type Provider = UserConfig["llm"]["provider"];

program.command("init")
  .description("detect your author emails in this repo, set up ~/.idiolect/config.json and .idiolect/config.json")
  .option("--repo <path>", "repository path", ".")
  .option("--email <email...>", "your author emails in this repo (skips the prompt)")
  .option("--provider <name>", `LLM provider: ${PROVIDERS.join(", ")}`)
  .option("-y, --yes", "accept detected defaults without prompting")
  .action(async (o: { repo: string; email?: string[]; yes?: boolean; provider?: string }) => {
    const repo = resolve(o.repo);
    const user = await loadUserConfig();
    const authors = await listAuthors(repo);
    const mine = await detectEmail(repo);
    const known = new Set((user?.emails ?? []).map((e) => e.toLowerCase()));

    let emails = o.email?.map((e) => e.toLowerCase());
    let name = user?.name;
    if (!emails) {
      console.log("Authors in this repo:");
      authors.forEach((a, i) => {
        const tag = known.has(a.email) ? "  <- you (from ~/.idiolect)" : a.email === mine ? "  <- git config" : "";
        console.log(`  ${i + 1}. ${a.email}  (${a.name}, ${a.commits} commits)${tag}`);
      });
      const myName = user?.name ?? authors.find((x) => x.email === mine)?.name;
      const def = authors.map((a, i) => (known.has(a.email) || a.email === mine || sameName(a.name, myName) ? i + 1 : 0)).filter(Boolean);
      const answer = o.yes ? "" : (await ask(`Which are you? numbers, comma separated [${def.join(",")}]: `)).trim();
      const picks = answer ? answer.split(/[,\s]+/).map(Number) : def;
      emails = picks.map((i) => authors[i - 1]?.email).filter((e): e is string => !!e);
      name ??= authors[(picks[0] ?? 1) - 1]?.name;
    }
    if (!emails.length) throw new Error("no emails selected");
    name ??= authors.find((a) => a.email === emails![0])?.name ?? emails[0];

    let provider = (o.provider ?? user?.llm.provider) as Provider | undefined;
    if (!provider || provider === "none" && !o.provider && !user) {
      const hasClaude = await hasCommand("claude");
      const def = hasClaude ? "claude-cli" : "none";
      console.log(`\nLLM provider. Samples of your code go to it to phrase the rules. "none" keeps everything local with metric rules only.`);
      console.log(`  claude-cli         your installed Claude Code, uses your existing plan${hasClaude ? "  <- found" : "  (not found on PATH)"}`);
      console.log(`  anthropic | openai | gemini   API key`);
      console.log(`  openai-compatible  Ollama, LM Studio, vLLM, any local server`);
      console.log(`  none`);
      const answer = o.yes ? "" : (await ask(`Provider [${def}]: `)).trim();
      provider = (answer || def) as Provider;
    }
    if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider ${provider}`);

    // the user file accumulates every email you use, so one profile covers all your repos
    const allEmails = [...(user?.emails ?? []), ...emails.filter((e) => !known.has(e))];
    await saveUserConfig({ ...user, name, emails: allEmails, llm: { ...user?.llm, provider } });

    const kotlinFiles = (await git(repo, ["ls-files", "*.kt", "*.kts"])).split("\n").filter(Boolean).length;
    const repoConfig = await loadRepoConfig(repo);
    await saveRepoConfig(repo, { languages: kotlinFiles ? ["kotlin"] : [], ignore: repoConfig.ignore });

    const need = { "claude-cli": "your Claude Code login", anthropic: "needs ANTHROPIC_API_KEY", openai: "needs OPENAI_API_KEY and llm.model", gemini: "needs GEMINI_API_KEY and llm.model", "openai-compatible": "needs llm.model, default base url is Ollama", none: "metric rules only" }[provider];
    console.log(`\nwrote ${userConfigPath()}  (you, shared across repos)`);
    console.log(`  developer: ${name}`);
    console.log(`  emails:    ${allEmails.join(", ")}`);
    console.log(`  llm:       ${provider} (${need})`);
    console.log(`wrote ${repoConfigPath(repo)}  (repo settings only, safe to commit)`);
    console.log(`  languages: ${kotlinFiles ? "kotlin" : "none supported yet (kotlin only for now)"}`);
    console.log(`\nnext: idiolect scan`);
  });

program.command("scan")
  .description("collect your code, analyze it, merge into your personal profile, write rules")
  .option("--repo <path>", "repository path", ".")
  .option("--no-cache", "ignore the blame cache")
  .option("--no-llm", "metric rules only, no LLM call")
  .option("--dry-run", "print what would be sent to the LLM and stop")
  .action(async (o: { repo: string; cache: boolean; llm: boolean; dryRun?: boolean }) => {
    const repo = resolve(o.repo);
    const user = await loadUserConfig();
    if (!user) throw new Error(`no ${userConfigPath()}, run: idiolect init`);
    const config = await loadRepoConfig(repo);
    const t0 = Date.now();
    const c = await collect({ repo, emails: user.emails, ignore: config.ignore, cache: o.cache });
    const linesOwned = c.files.reduce((n, f) => n + f.ownedLines, 0);
    if (!c.files.length && !c.commits.length) throw new Error(`none of your emails (${user.emails.join(", ")}) appear in this repo, run: idiolect init`);
    process.stderr.write(`collected ${c.files.length} files, ${linesOwned} owned lines, ${c.commits.length} commits (${Date.now() - t0}ms)\n`);

    let kotlin = emptyStats();
    const inputs: SampleInput[] = [];
    for (const f of c.files) {
      const code = await git(repo, ["show", `${c.head}:${f.path}`]);
      const test = isTestPath(f.path);
      inputs.push({ path: f.path, code, ranges: f.ranges, test });
      kotlin = mergeStats(kotlin, await analyzeKotlin(code, f.ranges, { test }));
    }
    const commitStats = analyzeCommits(c.commits);

    const primary = user.emails[0]!;
    const name = user.name ?? primary;
    let profile = upsertSource(await loadProfile(primary) ?? emptyProfile(name, user.emails), {
      repo, head: c.head, scannedAt: new Date().toISOString(), commits: c.commits.length, linesOwned, stats: { kotlin }, commitStats,
    });
    profile = { ...profile, developer: { name, emails: user.emails } };
    await saveProfile(profile);

    let provider;
    try { provider = o.llm ? createProvider(user.llm) : undefined; }
    catch (e) { process.stderr.write(`warning: ${(e as Error).message}, writing metric rules only\n`); }
    const samples = await collectSamples(inputs, c.commits, { maxTokens: config.sampling.maxTokens });
    const ruleOpts = { minSampleSize: config.minSampleSize, confidenceThreshold: config.confidenceThreshold, repo };
    if (o.dryRun) {
      const prompt = buildPrompt(profile, samples, baselineRules(profile, ruleOpts));
      console.log(`--- system (${estimateTokens(prompt.system)} tokens)\n${prompt.system}\n\n--- user (${estimateTokens(prompt.user)} tokens, ${samples.functions.length} functions, ${samples.comments.length} comments, ${samples.commits.length} commits)\n${prompt.user}`);
      console.log(`\nprovider: ${provider ? `${provider.name} ${provider.model}` : "none (metric rules only)"}. Nothing was sent.`);
      return;
    }
    if (provider) process.stderr.write(`asking ${provider.name} ${provider.model} (${estimateTokens(buildPrompt(profile, samples, []).user)} tokens)...\n`);
    profile = { ...profile, rules: await writeRules(profile, samples, provider, ruleOpts) };
    await saveProfile(profile);
    await writeFile(profilePath(primary).replace(/\.json$/, ".STYLE.md"), renderStyleMd(profile, { threshold: config.confidenceThreshold }));
    const project = profile.rules.filter((r) => r.repo === repo).length;
    if (project) process.stderr.write(`${project} project-only rules kept for this repo, shown by idiolect show inside it\n`);

    const { summarizeKotlin, summarizeCommits } = await import("./summary.js");
    console.log(`\nThis repo`);
    console.log(summarizeKotlin(kotlin));
    console.log(summarizeCommits(commitStats));
    if (profile.sources.length > 1) {
      console.log(`\nMerged profile (${profile.sources.length} repos)`);
      console.log(summarizeKotlin(profile.stats.kotlin!));
      console.log(summarizeCommits(profile.commitStats));
    }
    const by = (st: string) => profile.rules.filter((r) => r.status === st).length;
    console.log(`\nrules: ${profile.rules.length} (${by("auto")} auto, ${by("approved")} approved, ${by("pending")} pending, ${by("rejected")} rejected)${provider ? "" : ", metric rules only"}`);
    console.log(`profile: ${profilePath(primary)}`);
    console.log(`next: idiolect show`);
  });

program.command("show")
  .description("print your style profile as STYLE.md")
  .option("--repo <path>", "repository path, for the confidence threshold", ".")
  .option("--email <email>", "profile to show, default is yours")
  .option("--lang <language>", "only rules for this language")
  .option("--evidence", "append metric and example evidence to each rule")
  .action(async (o: { repo: string; email?: string; lang?: string; evidence?: boolean }) => {
    const email = o.email ?? (await loadUserConfig())?.emails[0];
    if (!email) throw new Error("no ~/.idiolect/config.json, run: idiolect init");
    const profile = await loadProfile(email);
    if (!profile) throw new Error(`no profile for ${email}, run: idiolect scan`);
    const repo = (await git(resolve(o.repo), ["rev-parse", "--show-toplevel"]).catch(() => "")).trim() || undefined;
    const { confidenceThreshold } = await loadRepoConfig(resolve(o.repo));
    console.log(renderStyleMd(profile, { threshold: confidenceThreshold, language: o.lang, evidence: o.evidence, repo }));
  });

program.command("sync")
  .description("write your STYLE.md into agent instruction files, between idiolect markers only")
  .option("--repo <path>", "repository path", ".")
  .option("--target <file...>", "files to write, overrides sync.targets in .idiolect/config.json")
  .action(async (o: { repo: string; target?: string[] }) => {
    const repo = (await git(resolve(o.repo), ["rev-parse", "--show-toplevel"])).trim();
    const user = await loadUserConfig();
    if (!user) throw new Error(`no ${userConfigPath()}, run: idiolect init`);
    const profile = await loadProfile(user.emails[0]!);
    if (!profile) throw new Error("no profile, run: idiolect scan");
    const config = await loadRepoConfig(repo);
    const body = renderStyleMd(profile, { threshold: config.confidenceThreshold, repo });
    const results = await syncTargets(repo, body, o.target ?? config.sync.targets);
    for (const r of results) console.log(`${r.status.padEnd(9)} ${r.file}${r.status === "skipped" ? "  (not present, list it in sync.targets or pass --target to create it)" : ""}`);
  });

program.command("eval")
  .description("generate code with and without your profile and score which sounds more like you")
  .option("--repo <path>", "repository path, used for reference samples and project rules", ".")
  .option("--tasks <dir>", "task directory", fileURLToPath(new URL("../../../data/eval-tasks", import.meta.url)))
  .option("--only <ids...>", "run only these task ids")
  .option("--quiz", "after the judge, show pairs blind and let you pick")
  .option("--from <report.json>", "skip generation, quiz an existing report and update it")
  .option("--concurrency <n>", "parallel LLM calls", "3")
  .action(async (o: { repo: string; tasks: string; only?: string[]; quiz?: boolean; from?: string; concurrency: string }) => {
    const repo = resolve(o.repo);
    if (o.from) {
      const path = resolve(o.from);
      const report = JSON.parse(await readFile(path, "utf8")) as Report;
      report.quiz = await quiz(report);
      await writeFile(path, JSON.stringify(report, null, 2));
      await writeFile(path.replace(/\.json$/, ".md"), renderReport(report));
      console.log(`\nquiz:   you picked the profile output ${Math.round(report.quiz.winRate * 100)}% (${report.quiz.withWins}/${report.quiz.total})`);
      console.log(`judge:  with profile wins ${Math.round(report.judge.winRate * 100)}% (${report.judge.withWins}/${report.judge.total})`);
      console.log(`report: ${path.replace(/\.json$/, ".md")}`);
      return;
    }
    const user = await loadUserConfig();
    if (!user) throw new Error(`no ${userConfigPath()}, run: idiolect init`);
    const profile = await loadProfile(user.emails[0]!);
    if (!profile) throw new Error("no profile, run: idiolect scan");
    const provider = createProvider(user.llm);
    if (!provider) throw new Error("eval needs an LLM provider, run: idiolect init");
    const config = await loadRepoConfig(repo);
    let tasks = await loadTasks(o.tasks);
    if (o.only) tasks = tasks.filter((t) => o.only!.includes(t.id));
    if (!tasks.length) throw new Error("no tasks");

    const c = await collect({ repo, emails: user.emails, ignore: config.ignore });
    const inputs: SampleInput[] = [];
    for (const f of c.files.slice(0, 400)) inputs.push({ path: f.path, code: await git(repo, ["show", `${c.head}:${f.path}`]), ranges: f.ranges, test: isTestPath(f.path) });
    const samples = await collectSamples(inputs, c.commits, { maxTokens: 12000, functions: 12, comments: 20, commits: 8 });
    const references = [...samples.functions, ...samples.comments, ...samples.commits];
    process.stderr.write(`${tasks.length} tasks, ${references.length} reference samples, ${provider.name} ${provider.model}, ${tasks.length * 3} LLM calls\n`);

    const report: Report = await runEval({ profile, provider, references, tasks, repo, threshold: config.confidenceThreshold, concurrency: Number(o.concurrency), onProgress: (m) => process.stderr.write(`  ${m}\n`) });
    if (o.quiz) report.quiz = await quiz(report);

    const dir = join(await ensureRepoDir(repo), "eval");
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    await writeFile(join(dir, `${stamp}.json`), JSON.stringify(report, null, 2));
    await writeFile(join(dir, `${stamp}.md`), renderReport(report));
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    console.log(`\njudge:  with profile wins ${pct(report.judge.winRate)} (${report.judge.withWins}/${report.judge.total})`);
    if (report.quiz) console.log(`quiz:   you picked the profile output ${pct(report.quiz.winRate)} (${report.quiz.withWins}/${report.quiz.total})`);
    console.log(`metric distance: with ${report.metricDistance.with}, without ${report.metricDistance.without} (lower is closer to you)`);
    console.log(`report: ${join(dir, `${stamp}.md`)}`);
  });

program.command("mcp")
  .description("serve your style to MCP clients over stdio. Install: claude mcp add idiolect -- idiolect mcp")
  .action(async () => {
    const user = () => loadUserConfig();
    const server = createIdiolectServer({
      profile: async () => { const u = await user(); return u && loadProfile(u.emails[0]!); },
      provider: async () => { const u = await user(); return u && createProvider(u.llm); },
    });
    await server.connect(new StdioServerTransport());
  });

async function quiz(report: Report) {
  const picks: NonNullable<Report["quiz"]>["picks"] = [];
  for (const g of report.generations) {
    const flip = Math.random() < 0.5;
    const [a, b] = flip ? [g.without, g.with] : [g.with, g.without];
    console.log(`\n==== ${g.task.id}\n\n--- A\n${a.trim()}\n\n--- B\n${b.trim()}\n`);
    const pick = (await ask("Which sounds like you? [A/B/skip]: ")).trim().toUpperCase();
    if (pick !== "A" && pick !== "B") { picks.push({ task: g.task.id, picked: "skip" }); continue; }
    picks.push({ task: g.task.id, picked: (pick === "A") !== flip ? "with" : "without" });
  }
  const answered = picks.filter((p) => p.picked !== "skip");
  const withWins = answered.filter((p) => p.picked === "with").length;
  return { withWins, total: answered.length, winRate: answered.length ? withWins / answered.length : 0, picks };
}

async function listAuthors(repo: string) {
  const out = await git(repo, ["shortlog", "-sne", "--all", "--no-merges"]);
  return out.split("\n").map((l) => l.match(/^\s*(\d+)\s+(.*?)\s+<(.+)>$/)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ commits: Number(m[1]), name: m[2]!, email: m[3]!.toLowerCase() }));
}
const hasCommand = (cmd: string) => new Promise<boolean>((res) => execFile("which", [cmd], (err) => res(!err)));
const sameName = (a: string, b?: string) => !!b && a.toLowerCase().replace(/\s+/g, "") === b.toLowerCase().replace(/\s+/g, "");
async function ask(q: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(q); } finally { rl.close(); }
}

program.parseAsync().catch((e: Error) => { console.error(`error: ${e.message}`); process.exit(1); });
