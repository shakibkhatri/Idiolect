#!/usr/bin/env node
import { analyze, fileSpread, languageOf, EXTENSIONS, isTestPath, collect, detectEmail, emptyProfile, emptyStats, git, loadUserConfig, saveUserConfig, loadRepoConfig, saveRepoConfig, updateRepoConfig, ensureRepoDir, userConfigPath, repoConfigPath, loadProfile, loadServedProfile, mergeStats, profilePath, saveProfile, upsertSource, analyzeCommits, collectSamples, createProvider, writeRules, buildPrompt, baselineRules, renderStyleMd, estimateTokens, type UserConfig, type SampleInput, type Language, type LanguageStats } from "@shakibkhatri/idiolect-core";
import { DEFAULT_TASKS_DIR, loadTasks, renderReport, runEval, type Report } from "@shakibkhatri/idiolect-eval";
import { createIdiolectServer } from "@shakibkhatri/idiolect-mcp";
import { renderHelp, TAGLINE } from "./help.js";
import { removeCommand } from "./remove.js";
import { llmHint, scanSummary } from "./summary.js";
import { progress, select, type Choice } from "./term.js";
import { syncTargets } from "./sync.js";
import { NO_PROFILE, rulesCommand, writeStyle } from "./rules.js";
import { FOLLOWS, onPath, stylesCommand, useCommand } from "./styles.js";
import { hooksCommand, unbotCommand } from "./unbot.js";
import { refreshCommand } from "./refresh.js";
import { start, statusCommand } from "./start.js";
import { ttyQuiz, webQuiz } from "./quiz.js";
import { uiCommand } from "./ui.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command, Help } from "commander";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const VERSION = (JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const program = new Command().name("idiolect").description(TAGLINE).version(VERSION);
// only the top level is grouped, a subcommand keeps commander's own help
program.configureHelp({ formatHelp: (cmd, helper) => (cmd === program ? renderHelp(cmd.commands.map((c) => c.name())) : Help.prototype.formatHelp.call(helper, cmd, helper)) });
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
        console.log(`  ${i + 1}. ${a.email}  (${a.name}, ${a.commits} ${a.commits === 1 ? "commit" : "commits"})${tag}`);
      });
      const myName = user?.name ?? authors.find((x) => x.email === mine)?.name;
      const matched = authors.map((a, i) => (known.has(a.email) || a.email === mine || sameName(a.name, myName) ? i + 1 : 0)).filter(Boolean);
      // a repo with one author needs no guess, and an empty default is not shown as []
      const def = matched.length || authors.length !== 1 ? matched : [1];
      const answer = o.yes ? "" : (await ask(`Which are you? numbers, comma separated${def.length ? ` [${def.join(",")}]` : ""}: `)).trim();
      const picks = answer ? answer.split(/[,\s]+/).map(Number) : def;
      emails = picks.map((i) => authors[i - 1]?.email).filter((e): e is string => !!e);
      name ??= authors[(picks[0] ?? 1) - 1]?.name;
    }
    if (!emails.length) throw new Error("no emails selected");
    name ??= authors.find((a) => a.email === emails![0])?.name ?? emails[0];

    let provider = (o.provider ?? user?.llm.provider) as Provider | undefined;
    if (!provider || provider === "none" && !o.provider && !user) {
      const hasClaude = await onPath("claude");
      const def = hasClaude ? "claude-cli" : "none";
      const choices: Choice<Provider>[] = [
        { value: "claude-cli", label: "claude-cli", hint: `your installed Claude Code, uses your existing plan${hasClaude ? ", found" : ", not found on PATH"}` },
        { value: "anthropic", label: "anthropic", hint: "API key in ANTHROPIC_API_KEY" },
        { value: "openai", label: "openai", hint: "API key in OPENAI_API_KEY, model in llm.model" },
        { value: "gemini", label: "gemini", hint: "API key in GEMINI_API_KEY, model in llm.model" },
        { value: "openai-compatible", label: "openai-compatible", hint: "Ollama, LM Studio, vLLM, any local server" },
        { value: "none", label: "none", hint: "nothing is sent, metric rules only" },
      ];
      console.log(`\nLLM provider. Samples of your code go to it to phrase the rules.`);
      // arrow keys in a terminal, the typed name everywhere else
      const picked = o.yes ? def : await select(choices, choices.findIndex((c) => c.value === def));
      if (picked) provider = picked;
      else {
        const width = Math.max(...choices.map((c) => c.label.length));
        for (const c of choices) console.log(`  ${c.label.padEnd(width)} - ${c.hint}`);
        provider = ((await ask(`Provider [${def}]: `)).trim() || def) as Provider;
      }
    }
    if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider ${provider}`);

    // the user file accumulates every email you use, so one profile covers all your repos
    const allEmails = [...(user?.emails ?? []), ...emails.filter((e) => !known.has(e))];
    await saveUserConfig({ ...user, name, emails: allEmails, llm: { ...user?.llm, provider } });

    const languages: Language[] = [];
    for (const [lang, exts] of Object.entries(EXTENSIONS) as [Language, string[]][]) {
      if ((await git(repo, ["ls-files", ...exts.map((e) => `*${e}`)])).split("\n").some((f) => f && languageOf(f))) languages.push(lang);
    }
    const repoConfig = await loadRepoConfig(repo);
    // keep whatever else the repo config holds, init only owns the language list
    await updateRepoConfig(repo, { languages, ignore: repoConfig.ignore });

    const need = { "claude-cli": "your Claude Code login", anthropic: "needs ANTHROPIC_API_KEY", openai: "needs OPENAI_API_KEY and llm.model", gemini: "needs GEMINI_API_KEY and llm.model", "openai-compatible": "needs llm.model, default base url is Ollama", none: "metric rules only" }[provider];
    console.log(`\nwrote ${userConfigPath()}  (you, shared across repos)`);
    console.log(`  developer: ${name}`);
    console.log(`  emails:    ${allEmails.join(", ")}`);
    console.log(`  llm:       ${provider} (${need})`);
    console.log(`wrote ${repoConfigPath(repo)}  (repo settings only, safe to commit)`);
    console.log(`  languages: ${languages.join(", ") || "no Kotlin, TypeScript, Python or Go files found"}`);
    console.log(`\nnext: idiolect scan`);
  });

program.command("scan")
  .description("learn or update your own style from your code and commits in this repo")
  .option("--repo <path>", "repository path", ".")
  .option("--no-cache", "ignore the blame cache")
  .option("--no-llm", "metric rules only, no LLM call")
  .option("--dry-run", "print what would be sent to the LLM and stop")
  .option("--verbose", "also print the measured statistics per language")
  .action(async (o: { repo: string; cache: boolean; llm: boolean; dryRun?: boolean; verbose?: boolean }) => {
    const repo = resolve(o.repo);
    const user = await loadUserConfig();
    if (!user) throw new Error(`no ${userConfigPath()}, run: idiolect init`);
    const config = await loadRepoConfig(repo);
    const t0 = Date.now();
    // the blame pass of a first scan takes seconds, a pipe and the refresh log stay quiet
    const reading = progress.interactive ? progress.spinner("reading your lines") : undefined;
    const c = await collect({ repo, emails: user.emails, ignore: config.ignore, cache: o.cache, extensions: config.languages.flatMap((l) => EXTENSIONS[l]), onFile: (done, total) => reading?.update(`${done}/${total} files`) })
      .catch((e) => { reading?.stop(""); throw e; });
    reading?.clear();
    const linesOwned = c.files.reduce((n, f) => n + f.ownedLines, 0);
    if (!c.files.length && !c.commits.length) reading?.stop("");
    if (!c.files.length && !c.commits.length) throw new Error(`none of your emails (${user.emails.join(", ")}) appear in this repo, run: idiolect init`);
    if (o.verbose) process.stderr.write(`collected ${c.files.length} files, ${linesOwned} owned lines, ${c.commits.length} commits${c.agentCommits ? `, ${c.agentCommits} agent commits excluded` : ""} (${Date.now() - t0}ms)\n`);

    const stats: Partial<Record<Language, LanguageStats>> = {};
    const perFile: Partial<Record<Language, LanguageStats[]>> = {};
    const inputs: SampleInput[] = [];
    for (const [i, f] of c.files.entries()) {
      const lang = languageOf(f.path);
      if (!lang) continue;
      reading?.update(`measuring ${i + 1}/${c.files.length} files`);
      const code = await git(repo, ["show", `${c.head}:${f.path}`]);
      const test = isTestPath(f.path);
      inputs.push({ path: f.path, code, ranges: f.ranges, test });
      const st = await analyze(code, lang, f.ranges, { test, path: f.path });
      stats[lang] = mergeStats(stats[lang] ?? emptyStats(), st);
      (perFile[lang] ??= []).push(st);
    }
    reading?.stop("");
    const spread = Object.fromEntries((Object.entries(perFile) as [Language, LanguageStats[]][]).map(([l, xs]) => [l, fileSpread(xs)]));
    const commitStats = analyzeCommits(c.commits);

    const primary = user.emails[0]!;
    const name = user.name ?? primary;
    let profile = upsertSource(await loadProfile(primary) ?? emptyProfile(name, user.emails), {
      repo, head: c.head, headDate: (await git(repo, ["log", "-1", "--format=%cI", c.head])).trim(), scannedAt: new Date().toISOString(), commits: c.commits.length, linesOwned, stats, commitStats, spread,
    });
    profile = { ...profile, developer: { name, emails: user.emails } };
    await saveProfile(profile);

    let provider: ReturnType<typeof createProvider>;
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
    const write = () => writeRules(profile, samples, provider, ruleOpts);
    const rules = provider ? await progress.during(`asking ${provider.name} ${provider.model} (${estimateTokens(buildPrompt(profile, samples, []).user)} tokens)`, write).catch(hinted("scan")) : await write();
    profile = { ...profile, rules };
    await saveProfile(profile);
    await writeStyle(profile, config.confidenceThreshold);
    const project = profile.rules.filter((r) => r.repo === repo).length;
    if (project && o.verbose) process.stderr.write(`${project} rules for this repo only, shown by idiolect show inside it\n`);

    if (!o.verbose) {
      console.log(scanSummary(profile, stats, { commits: c.commits.length, agentCommits: c.agentCommits, llm: !!provider }));
      return;
    }
    const { summarizeLanguage, summarizeCommits } = await import("./summary.js");
    console.log(`\nThis repo`);
    for (const [lang, st] of Object.entries(stats) as [Language, LanguageStats][]) console.log(summarizeLanguage(lang, st));
    console.log(summarizeCommits(commitStats));
    if (profile.sources.length > 1) {
      console.log(`\nYour style across ${profile.sources.length} repos`);
      for (const [lang, st] of Object.entries(profile.stats) as [Language, LanguageStats][]) console.log(summarizeLanguage(lang, st));
      console.log(summarizeCommits(profile.commitStats));
    }
    const by = (st: string) => profile.rules.filter((r) => r.status === st).length;
    console.log(`\nrules: ${profile.rules.length} (${by("auto")} auto, ${by("approved")} approved, ${by("edited")} edited, ${by("pending")} pending, ${by("rejected")} rejected)${provider ? "" : ", metric rules only"}`);
    console.log(`saved: ${profilePath(primary)}`);
    console.log(`next: idiolect show, then idiolect rules list to approve, reject or edit`);
  });

program.command("show")
  .description("print the style your agent reads")
  .option("--repo <path>", "repository path, for the confidence threshold", ".")
  .option("--email <email>", "print the style stored for this email in full, default is the one served here")
  .option("--lang <language>", "only rules for this language")
  .option("--evidence", "append metric and example evidence to each rule")
  .action(async (o: { repo: string; email?: string; lang?: string; evidence?: boolean }) => {
    const repo = (await git(resolve(o.repo), ["rev-parse", "--show-toplevel"]).catch(() => "")).trim() || undefined;
    const profile = o.email ? await loadProfile(o.email) : await loadServedProfile(repo ?? resolve(o.repo));
    if (!profile) throw new Error(o.email ? `no style stored for ${o.email}, run: idiolect scan` : NO_PROFILE);
    const { confidenceThreshold } = await loadRepoConfig(resolve(o.repo));
    console.log(renderStyleMd(profile, { threshold: confidenceThreshold, language: o.lang, evidence: o.evidence, repo }));
  });

program.command("sync")
  .description("write the style into your agent's instruction files, between idiolect markers only")
  .option("--repo <path>", "repository path", ".")
  .option("--target <file...>", "files to write, overrides sync.targets in .idiolect/config.json")
  .action(async (o: { repo: string; target?: string[] }) => {
    const repo = (await git(resolve(o.repo), ["rev-parse", "--show-toplevel"])).trim();
    const profile = await loadServedProfile(repo);
    if (!profile) throw new Error(NO_PROFILE);
    const config = await loadRepoConfig(repo);
    const body = renderStyleMd(profile, { threshold: config.confidenceThreshold, repo });
    const results = await syncTargets(repo, body, o.target ?? config.sync.targets);
    for (const r of results) if (r.status !== "skipped") console.log(`${r.status.padEnd(9)} ${r.file}`);
    console.log(results.some((r) => r.status === "created" || r.status === "updated") ? `\n${FOLLOWS}` : "\nNothing to write, the agent files already hold this style.");
  });

program.addCommand(stylesCommand());
program.addCommand(useCommand());
program.addCommand(removeCommand());
program.addCommand(rulesCommand());
program.addCommand(unbotCommand());
program.addCommand(hooksCommand());
program.addCommand(statusCommand());
program.addCommand(refreshCommand());
program.addCommand(uiCommand());

program.command("eval")
  .description("generate code with and without the style and score which sounds more like you")
  .option("--repo <path>", "repository path, used for reference samples and the rules for this repo only", ".")
  .option("--tasks <dir>", "task directory", DEFAULT_TASKS_DIR)
  .option("--only <ids...>", "run only these task ids")
  .option("--quiz", "after the judge, show pairs blind in your browser and let you pick")
  .option("--tty", "take the quiz in the terminal instead of the browser")
  .option("--from <report.json|latest>", "skip generation, quiz an existing report and update it. latest picks the newest report in this repo")
  .option("--concurrency <n>", "parallel LLM calls", "3")
  .action(async (o: { repo: string; tasks: string; only?: string[]; quiz?: boolean; tty?: boolean; from?: string; concurrency: string }) => {
    const repo = resolve(o.repo);
    const quiz = (report: Report) => (o.tty ? ttyQuiz(report) : webQuiz(report));
    if (o.from) {
      const path = o.from === "latest" ? await latestReport(repo) : resolve(o.from);
      const report = JSON.parse(await readFile(path, "utf8")) as Report;
      process.stderr.write(`report: ${path}\nstyle with ${report.rules} rules, run ${report.generatedAt}\n`);
      report.quiz = await quiz(report);
      await writeFile(path, JSON.stringify(report, null, 2));
      await writeFile(path.replace(/\.json$/, ".md"), renderReport(report));
      console.log(`\nquiz:   you picked the styled output ${Math.round(report.quiz.winRate * 100)}% (${report.quiz.withWins}/${report.quiz.total})`);
      console.log(`judge:  with the style wins ${Math.round(report.judge.winRate * 100)}% (${report.judge.withWins}/${report.judge.total})`);
      console.log(`report: ${path.replace(/\.json$/, ".md")}`);
      return;
    }
    const user = await loadUserConfig();
    if (!user) throw new Error(`no ${userConfigPath()}, run: idiolect init`);
    const profile = await loadServedProfile(repo);
    if (!profile) throw new Error(NO_PROFILE);
    const provider = createProvider(user.llm);
    if (!provider) throw new Error("eval needs an LLM provider, run: idiolect init");
    const config = await loadRepoConfig(repo);
    let tasks = await loadTasks(o.tasks);
    if (o.only) tasks = tasks.filter((t) => o.only!.includes(t.id));
    if (!tasks.length) throw new Error("no tasks");

    // reference samples come from the languages the tasks are written in
    const languages = [...new Set(tasks.map((t) => t.language))];
    const c = await collect({ repo, emails: user.emails, ignore: config.ignore, extensions: languages.flatMap((l) => EXTENSIONS[l]) });
    const inputs: SampleInput[] = [];
    for (const f of c.files.slice(0, 400)) inputs.push({ path: f.path, code: await git(repo, ["show", `${c.head}:${f.path}`]), ranges: f.ranges, test: isTestPath(f.path) });
    const samples = await collectSamples(inputs, c.commits, { maxTokens: 12000, functions: 12, comments: 20, commits: 8 });
    const references = [...samples.functions, ...samples.comments, ...samples.commits];
    // a terminal counts the finished tasks on one line, a pipe keeps one line per task
    let steps = 0;
    const report: Report = await progress.during(`${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}, ${references.length} reference samples, ${provider.name} ${provider.model}, ${tasks.length * 3} LLM calls`, (spin) =>
      runEval({ profile, provider, references, tasks, repo, threshold: config.confidenceThreshold, concurrency: Number(o.concurrency), onProgress: (m) => {
        spin.update(`${++steps}/${tasks.length * 2} steps`);
        if (!progress.interactive) process.stderr.write(`  ${m}\n`);
      } })).catch(hinted("eval"));
    if (o.quiz) report.quiz = await quiz(report);

    const dir = join(await ensureRepoDir(repo), "eval");
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    await writeFile(join(dir, `${stamp}.json`), JSON.stringify(report, null, 2));
    await writeFile(join(dir, `${stamp}.md`), renderReport(report));
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    console.log(`\njudge:  with the style wins ${pct(report.judge.winRate)} (${report.judge.withWins}/${report.judge.total})`);
    if (report.quiz) console.log(`quiz:   you picked the styled output ${pct(report.quiz.winRate)} (${report.quiz.withWins}/${report.quiz.total})`);
    console.log(`metric distance: with ${report.metricDistance.with}, without ${report.metricDistance.without} (lower is closer to you)`);
    console.log(`report: ${join(dir, `${stamp}.md`)}`);
  });

program.command("mcp")
  .description("serve your style to MCP clients over stdio. Install: claude mcp add idiolect -- idiolect mcp")
  .action(async () => {
    const user = () => loadUserConfig();
    const server = createIdiolectServer({
      profile: (repo) => loadServedProfile(repo),
      provider: async () => { const u = await user(); return u && createProvider(u.llm); },
    });
    await server.connect(new StdioServerTransport());
  });

// an LLM failure keeps its message and gains the line saying what to run
const hinted = (command: string) => (e: Error): never => { throw new Error(`${e.message.split("\n")[0]}\n${llmHint(e.message, command)}`); };

async function latestReport(repo: string) {
  const dir = join(repo, ".idiolect", "eval");
  const reports = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
  if (!reports.length) throw new Error(`no reports in ${dir}, run: idiolect eval`);
  return join(dir, reports[reports.length - 1]!);
}

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

// bare idiolect is the guided start, anything else goes to commander
const argv = process.argv.slice(2);
const main = argv.every((a) => a === "--no-prompt") ? start({ repo: ".", prompt: !argv.length }) : program.parseAsync();
main.catch((e: Error) => { console.error(`error: ${e.message}`); process.exit(1); });
