import { createProvider, git, loadProfile, loadRepoConfig, loadUserConfig, rewriteLikeMe, unbot, userConfigPath, type Violation } from "@idiolect/core";
import { Command } from "commander";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const KOTLIN = /\.kts?$/;

/** No files: changed and untracked Kotlin files. --staged: the index. --all: every tracked Kotlin file. */
async function pickFiles(repo: string, given: string[], o: { staged?: boolean; all?: boolean }): Promise<string[]> {
  if (given.length) return given.map((f) => relative(repo, resolve(f)));
  const out = o.all ? await git(repo, ["ls-files", "*.kt", "*.kts"])
    : o.staged ? await git(repo, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    : `${await git(repo, ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"])}\n${await git(repo, ["ls-files", "--others", "--exclude-standard"])}`;
  return [...new Set(out.split("\n").filter((f) => KOTLIN.test(f)))].sort();
}

const show = (v: Violation) => `  ${String(v.line ?? "-").padStart(5)}  ${v.suggestion}${v.line ? "" : ` ${v.message}`}  [${v.ruleId}]`;

export function unbotCommand(): Command {
  return new Command("unbot").description("flag code that breaks your measured habits or sounds like AI. Warns only, --strict fails")
    .argument("[files...]", "Kotlin files, default is what changed since HEAD")
    .option("--repo <path>", "repository path", ".")
    .option("--staged", "check the files staged for commit, for hooks")
    .option("--all", "check every tracked Kotlin file")
    .option("--llm", "deep mode: the LLM also checks the voice rules")
    .option("--fix", "rewrite each flagged file in your style with the LLM and write it back")
    .option("--strict", "exit 1 when anything is flagged")
    .action(async (files: string[], o: { repo: string; staged?: boolean; all?: boolean; llm?: boolean; fix?: boolean; strict?: boolean }) => {
      const repo = (await git(resolve(o.repo), ["rev-parse", "--show-toplevel"])).trim();
      const user = await loadUserConfig();
      if (!user) throw new Error(`no ${userConfigPath()}, run: idiolect init`);
      const profile = await loadProfile(user.emails[0]!);
      if (!profile) throw new Error("no profile, run: idiolect scan");
      const { confidenceThreshold: threshold } = await loadRepoConfig(repo);
      const provider = o.llm || o.fix ? createProvider(user.llm) : undefined;
      if ((o.llm || o.fix) && !provider) throw new Error("--llm and --fix need an LLM provider, run: idiolect init");

      const picked = await pickFiles(repo, files, o);
      if (!picked.length) { console.log("no Kotlin files to check"); return; }
      let total = 0, flagged = 0, fixed = 0;
      for (const file of picked) {
        const abs = join(repo, file);
        let code = await readFile(abs, "utf8").catch(() => undefined);
        if (code === undefined) continue;
        const opts = { language: "kotlin" as const, threshold, repo, file };
        let found = await unbot(profile, code, opts, o.llm ? provider : undefined);
        if (!found.length) continue;
        flagged++;
        console.log(`${file}\n${found.map(show).join("\n")}`);
        if (o.fix) {
          const out = await rewriteLikeMe(profile, code, opts, provider!);
          await writeFile(abs, out.code.endsWith("\n") ? out.code : `${out.code}\n`);
          code = out.code;
          const before = found.length;
          found = await unbot(profile, code, opts, o.llm ? provider : undefined);
          fixed += before - found.length;
          console.log(`  rewrote the file:${out.changes.map((c) => `\n    - ${c}`).join("") || " nothing changed"}\n  ${found.length} left after the rewrite`);
        }
        total += found.length;
      }
      const where = `${flagged} of ${picked.length} files`;
      console.log(o.fix ? `\n${fixed} fixed, ${total} left in ${where}` : total ? `\n${total} ${total === 1 ? "violation" : "violations"} in ${where}` : `\n${picked.length} files, nothing flagged`);
      if (total && o.strict) process.exit(1);
    });
}

const HOOK_LINE = "idiolect unbot --staged";

export function hooksCommand(): Command {
  const hooks = new Command("hooks").description("git hooks that run unbot");
  hooks.command("install").description("pre-commit hook that runs unbot on staged Kotlin, warn only. Uses .husky/pre-commit when present")
    .option("--repo <path>", "repository path", ".")
    .action(async (o: { repo: string }) => {
      const repo = (await git(resolve(o.repo), ["rev-parse", "--show-toplevel"])).trim();
      const husky = join(repo, ".husky", "pre-commit");
      const target = (await access(husky).then(() => true, () => false)) ? husky : join(repo, (await git(repo, ["rev-parse", "--git-path", "hooks"])).trim(), "pre-commit");
      const existing = await readFile(target, "utf8").catch(() => undefined);
      if (existing?.includes(HOOK_LINE)) { console.log(`already installed in ${relative(repo, target)}`); return; }
      // lefthook has its own yaml, so point at it instead of guessing the format
      if (await access(join(repo, "lefthook.yml")).then(() => true, () => false)) { console.log(`lefthook.yml found. Add a pre-commit command that runs: ${HOOK_LINE}`); return; }
      await writeFile(target, `${existing ?? "#!/bin/sh\n"}\n# idiolect: lint staged Kotlin against your style profile, warn only\n${HOOK_LINE}\n`, { mode: 0o755 });
      console.log(`${existing ? "appended to" : "created"} ${relative(repo, target)}`);
    });
  return hooks;
}
