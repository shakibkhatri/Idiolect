import { allExtensions, createProvider, git, languageOf, loadServedProfile, loadRepoConfig, loadUserConfig, rewriteLikeMe, unbot, type Violation } from "@shakibkhatri/idiolect-core";
import { Command } from "commander";
import { NO_PROFILE } from "./rules.js";
import { progress } from "./term.js";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/** No files: changed and untracked source files. --staged: the index. --all: every tracked source file. */
async function pickFiles(repo: string, given: string[], o: { staged?: boolean; all?: boolean }): Promise<string[]> {
  if (given.length) return given.map((f) => relative(repo, resolve(f)));
  const out = o.all ? await git(repo, ["ls-files", ...allExtensions().map((e) => `*${e}`)])
    : o.staged ? await git(repo, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    : `${await git(repo, ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"])}\n${await git(repo, ["ls-files", "--others", "--exclude-standard"])}`;
  return [...new Set(out.split("\n").filter((f) => languageOf(f)))].sort();
}

// metric messages repeat the numbers, so only the LLM's explanation of a located line is worth printing before the suggestion
const isMetricMessage = (m: string) => /\(n = \d+\)/.test(m);
const show = (v: Violation) => `  ${String(v.line ?? "-").padStart(5)}  ${v.line && !isMetricMessage(v.message) ? `${v.message} Try: ${v.suggestion}` : v.suggestion}${v.line ? "" : ` ${v.message}`}  [${v.ruleId}]`;

export function unbotCommand(): Command {
  return new Command("unbot").description("flag code that breaks the style or sounds like AI. Warns only, --strict fails")
    .argument("[files...]", "source files, default is what changed since HEAD")
    .option("--repo <path>", "repository path", ".")
    .option("--staged", "check the files staged for commit, for hooks")
    .option("--all", "check every tracked source file")
    .option("--llm", "deep mode: the LLM also checks the voice rules")
    .option("--fix", "rewrite each flagged file in the style with the LLM and write it back")
    .option("--strict", "exit 1 when anything is flagged")
    .action(async (files: string[], o: { repo: string; staged?: boolean; all?: boolean; llm?: boolean; fix?: boolean; strict?: boolean }) => {
      const repo = (await git(resolve(o.repo), ["rev-parse", "--show-toplevel"])).trim();
      const user = await loadUserConfig();
      const profile = await loadServedProfile(repo);
      if (!profile) throw new Error(NO_PROFILE);
      const { confidenceThreshold: threshold, check: floors } = await loadRepoConfig(repo);
      const provider = (o.llm || o.fix) && user ? createProvider(user.llm) : undefined;
      if ((o.llm || o.fix) && !provider) throw new Error("--llm and --fix need an LLM provider, run: idiolect init");

      const picked = await pickFiles(repo, files, o);
      if (!picked.length) { console.log("no source files to check"); return; }
      let total = 0, flagged = 0, fixed = 0;
      // only the LLM modes wait, the fast check and the hooks print nothing extra
      const spin = provider ? progress.spinner(`${o.fix ? "checking and rewriting" : "checking"} ${picked.length} ${picked.length === 1 ? "file" : "files"} with ${provider.name} ${provider.model}`) : undefined;
      const say = (text: string) => { spin?.clear(); console.log(text); };
      try {
        for (const [i, file] of picked.entries()) {
          spin?.update(`${i + 1}/${picked.length} ${file}`);
          const abs = join(repo, file);
          const language = languageOf(file);
          let code = await readFile(abs, "utf8").catch(() => undefined);
          if (code === undefined || !language) continue;
          const opts = { language, threshold, repo, file, floors };
          let found = await unbot(profile, code, opts, o.llm ? provider : undefined);
          if (!found.length) continue;
          flagged++;
          say(`${file}\n${found.map(show).join("\n")}`);
          if (o.fix) {
            const out = await rewriteLikeMe(profile, code, opts, provider!);
            await writeFile(abs, out.code.endsWith("\n") ? out.code : `${out.code}\n`);
            code = out.code;
            const before = found.length;
            found = await unbot(profile, code, opts, o.llm ? provider : undefined);
            fixed += before - found.length;
            say(`  rewrote the file:${out.changes.map((c) => `\n    - ${c}`).join("") || " nothing changed"}\n  ${found.length} left after the rewrite`);
          }
          total += found.length;
        }
      } catch (e) { spin?.fail(); throw e; }
      spin?.stop();
      const count = `${picked.length} ${picked.length === 1 ? "file" : "files"}`;
      const where = `${flagged} of ${count}`;
      console.log(o.fix ? `\n${fixed} fixed, ${total} left in ${where}` : total ? `\n${total} ${total === 1 ? "violation" : "violations"} in ${where}` : `\n${count}, nothing flagged`);
      if (total && o.strict) process.exit(1);
    });
}

const HOOKS = { "pre-commit": "idiolect unbot --staged", "post-commit": "idiolect refresh" };

/** Writes or appends one hook. Husky owns .husky/<name> when it exists, lefthook has its own yaml so only print the line. */
export async function installHook(repo: string, name: keyof typeof HOOKS): Promise<string> {
  const line = HOOKS[name];
  if (await access(join(repo, "lefthook.yml")).then(() => true, () => false)) return `lefthook.yml found. Add a ${name} command that runs: ${line}`;
  const husky = join(repo, ".husky", name);
  const target = (await access(husky).then(() => true, () => false)) ? husky : join(repo, (await git(repo, ["rev-parse", "--git-path", "hooks"])).trim(), name);
  const existing = await readFile(target, "utf8").catch(() => undefined);
  if (existing?.includes(line)) return `already installed in ${relative(repo, target)}`;
  await writeFile(target, `${existing ?? "#!/bin/sh\n"}\n# idiolect: ${name === "pre-commit" ? "check staged files against your style, warn only" : "rescan in the background every refresh.everyCommits commits"}\n${line}\n`, { mode: 0o755 });
  return `${existing ? "appended to" : "created"} ${relative(repo, target)}`;
}

/**
 * Takes out the comment line idiolect wrote and the command under it, with the blank line before them.
 * Undefined when only a shebang is left, so the file can be deleted. Null when the hook holds no idiolect line.
 */
export function removeHook(existing: string): string | undefined | null {
  const commands = Object.values(HOOKS).map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const ours = new RegExp(`\\n?# idiolect:[^\\n]*\\n(?:${commands})(?:\\n|$)`, "g");
  if (!ours.test(existing)) return null;
  const rest = existing.replace(ours, "");
  return /^(#![^\n]*)?\s*$/.test(rest) ? undefined : rest;
}

/** Every hook file idiolect may have written into: .husky and the git hooks folder, for both hooks. */
export async function hookFiles(repo: string): Promise<string[]> {
  const gitHooks = (await git(repo, ["rev-parse", "--git-path", "hooks"]).catch(() => "")).trim();
  return (Object.keys(HOOKS) as (keyof typeof HOOKS)[]).flatMap((name) => [join(repo, ".husky", name), ...(gitHooks ? [resolve(repo, gitHooks, name)] : [])]);
}

export function hooksCommand(): Command {
  const hooks = new Command("hooks").description("git hooks that run unbot and the background refresh");
  hooks.command("install").description("pre-commit runs unbot on staged files, warn only. post-commit rescans every N commits. Uses .husky when present")
    .option("--repo <path>", "repository path", ".")
    .action(async (o: { repo: string }) => {
      const repo = (await git(resolve(o.repo), ["rev-parse", "--show-toplevel"])).trim();
      for (const name of Object.keys(HOOKS) as (keyof typeof HOOKS)[]) console.log(`${name.padEnd(12)} ${await installHook(repo, name)}`);
    });
  return hooks;
}
