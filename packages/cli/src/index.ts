#!/usr/bin/env node
import { analyzeKotlin, isTestPath, collect, detectEmail, emptyProfile, emptyStats, git, loadConfig, loadProfile, mergeStats, profilePath, saveConfig, saveProfile, upsertSource, analyzeCommits, configPath, collectSamples, createProvider, writeRules, buildPrompt, baselineRules, renderStyleMd, estimateTokens, type Config, type SampleInput } from "@idiolect/core";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const program = new Command().name("idiolect").description("Learn your coding style and feed it to AI agents");

program.command("init")
  .description("detect your author emails and languages, write .idiolect/config.json")
  .option("--repo <path>", "repository path", ".")
  .option("--email <email...>", "your author emails (skips the prompt)")
  .option("--provider <name>", "LLM provider: anthropic, openai, gemini, openai-compatible, none")
  .option("-y, --yes", "accept detected defaults without prompting")
  .action(async (o: { repo: string; email?: string[]; yes?: boolean; provider?: string }) => {
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
    const providers = ["anthropic", "openai", "gemini", "openai-compatible", "none"] as const;
    let provider = o.provider as Config["llm"]["provider"] | undefined;
    if (!provider) {
      console.log(`\nLLM provider. Samples of your code are sent to it to phrase the rules; "none" keeps everything local with metric rules only.`);
      console.log(`  ${providers.join(", ")}  (openai-compatible covers Ollama, LM Studio, vLLM)`);
      const answer = o.yes ? "" : (await ask(`Provider [anthropic]: `)).trim();
      provider = (answer || "anthropic") as Config["llm"]["provider"];
    }
    if (!providers.includes(provider)) throw new Error(`unknown provider ${provider}`);
    const previous = await loadConfig(repo);
    const config: Config = { ...previous, emails, languages, llm: { ...previous?.llm, provider } } as Config;
    await saveConfig(repo, config);
    console.log(`\nwrote ${configPath(repo)}`);
    console.log(`  emails:    ${emails.join(", ")}`);
    console.log(`  languages: ${languages.join(", ") || "none supported yet (kotlin only for now)"}`);
    console.log(`  llm:       ${provider}${provider === "anthropic" ? " (needs ANTHROPIC_API_KEY)" : provider === "openai" ? " (needs OPENAI_API_KEY and llm.model)" : provider === "gemini" ? " (needs GEMINI_API_KEY and llm.model)" : provider === "openai-compatible" ? " (needs llm.model, default base url is Ollama)" : ""}`);
    console.log(`\nnext: idiolect scan`);
  });

program.command("scan")
  .description("collect your code, analyze it, merge into your personal profile")
  .option("--repo <path>", "repository path", ".")
  .option("--no-cache", "ignore the blame cache")
  .option("--no-llm", "baseline rules only, no LLM call")
  .option("--dry-run", "print what would be sent to the LLM and stop")
  .action(async (o: { repo: string; cache: boolean; llm: boolean; dryRun?: boolean }) => {
    const repo = resolve(o.repo);
    const config = await loadConfig(repo);
    if (!config) throw new Error(`no ${configPath(repo)}, run: idiolect init`);
    const t0 = Date.now();
    const c = await collect({ repo, emails: config.emails, ignore: config.ignore, cache: o.cache });
    const linesOwned = c.files.reduce((n, f) => n + f.ownedLines, 0);
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

    const primary = config.emails[0]!;
    const name = (await git(repo, ["config", "user.name"]).catch(() => "")).trim() || primary;
    let profile = upsertSource(await loadProfile(primary) ?? emptyProfile(name, config.emails), {
      repo, head: c.head, scannedAt: new Date().toISOString(), commits: c.commits.length, linesOwned, stats: { kotlin }, commitStats,
    });
    await saveProfile(profile);

    let provider;
    try { provider = o.llm ? createProvider(config.llm) : undefined; }
    catch (e) { process.stderr.write(`warning: ${(e as Error).message}, writing metric rules only\n`); }
    const samples = await collectSamples(inputs, c.commits, { maxTokens: config.sampling.maxTokens });
    const ruleOpts = { minSampleSize: config.minSampleSize, confidenceThreshold: config.confidenceThreshold };
    if (o.dryRun) {
      const prompt = buildPrompt(profile, samples, baselineRules(profile, ruleOpts));
      console.log(`--- system (${estimateTokens(prompt.system)} tokens)\n${prompt.system}\n\n--- user (${estimateTokens(prompt.user)} tokens, ${samples.functions.length} functions, ${samples.comments.length} comments, ${samples.commits.length} commits)\n${prompt.user}`);
      console.log(`\nprovider: ${provider ? `${provider.name} ${provider.model}` : "none (baseline only)"}. Nothing was sent.`);
      return;
    }
    if (provider) process.stderr.write(`asking ${provider.name} ${provider.model} (${estimateTokens(buildPrompt(profile, samples, []).user)} tokens)...\n`);
    profile = { ...profile, rules: await writeRules(profile, samples, provider, ruleOpts) };
    await saveProfile(profile);
    const styleMd = renderStyleMd(profile, { threshold: config.confidenceThreshold });
    await writeFile(profilePath(primary).replace(/\.json$/, ".STYLE.md"), styleMd);

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
    console.log(`\nrules: ${profile.rules.length} (${by("auto")} auto, ${by("approved")} approved, ${by("pending")} pending, ${by("rejected")} rejected)${provider ? "" : ", baseline only, set llm.provider in config for more"}`);
    console.log(`profile: ${profilePath(primary)}`);
    console.log(`next: idiolect show`);
  });

program.command("show")
  .description("print your style profile as STYLE.md")
  .option("--repo <path>", "repository path, used to find your email", ".")
  .option("--email <email>", "profile to show")
  .option("--lang <language>", "only rules for this language")
  .option("--evidence", "append metric and example evidence to each rule")
  .action(async (o: { repo: string; email?: string; lang?: string; evidence?: boolean }) => {
    const repo = resolve(o.repo);
    const email = o.email ?? (await loadConfig(repo))?.emails[0] ?? (await detectEmail(repo));
    if (!email) throw new Error("no email found, pass --email");
    const profile = await loadProfile(email);
    if (!profile) throw new Error(`no profile for ${email}, run: idiolect scan`);
    const threshold = (await loadConfig(repo))?.confidenceThreshold ?? 0.6;
    console.log(renderStyleMd(profile, { threshold, language: o.lang, evidence: o.evidence }));
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
