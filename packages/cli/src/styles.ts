import { buildStyle, composeStyles, git, listStyles, loadProfile, loadRepoConfig, loadServedProfile, loadStyle, monthYear, renderStyleMd, STYLES_DIR, updateRepoConfig, type Language, type Picked, type Style } from "@shakibkhatri/idiolect-core";
import { Command } from "commander";
import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { syncTargets } from "./sync.js";

const LANGUAGES = ["kotlin", "typescript", "python", "go"] as const;
const LANGUAGE_NAMES: Record<Language, string> = { kotlin: "Kotlin", typescript: "TypeScript", python: "Python", go: "Go" };

/** One short line per style under its language, so a long catalogue stays readable in a narrow terminal. */
export function renderList(all: Style[]): string {
  if (!all.length) return "no styles ship with this build";
  const width = Math.max(...all.map((s) => s.id.length));
  const out: string[] = [];
  for (const l of LANGUAGES) {
    const styles = all.filter((s) => s.language === l);
    if (!styles.length) continue;
    out.push(LANGUAGE_NAMES[l]);
    for (const s of styles) out.push(`  ${s.id.padEnd(width)}  ${s.summary}${s.experimental ? "  (experimental)" : ""}`);
    out.push("");
  }
  out.push("details: idiolect styles show <style>", "pick one per language: idiolect use <style...>");
  return out.join("\n");
}
const toplevel = async (path: string) => (await git(resolve(path), ["rev-parse", "--show-toplevel"]).catch(() => resolve(path))).trim();

export function stylesCommand(): Command {
  const styles = new Command("styles").description("list the styles that ship with idiolect, learned from open source code and reviewed")
    .action(async () => console.log(renderList(await listStyles())));

  styles.command("show <id>").description("where a style comes from and the rules it serves")
    .action(async (id: string) => {
      const s = await loadStyle(id);
      const md = renderStyleMd({ ...(await composeStyles({ [s.language]: s.id })), borrowed: ["voice", "layout"] }, { threshold: 0.6 });
      const held = s.rules.filter((r) => r.kind === "idiom").length;
      console.log([
        `${s.id}  ${LANGUAGE_NAMES[s.language]}${s.experimental ? "  experimental: nobody who writes the language has reviewed it" : ""}`,
        s.summary, "",
        `source    ${s.title}, ${s.source.project}, ${s.source.license}`,
        `snapshot  ${s.source.snapshot ? `code up to ${monthYear(s.source.snapshot)}, ` : ""}commit ${s.source.commit.slice(0, 8)}, ${s.source.lines} lines`,
        `rules     ${s.rules.length - held} served${held ? `, ${held} on language features held back` : ""}`, "",
        md.slice(md.indexOf("## ")).trimEnd(),
      ].join("\n"));
    });

  styles.command("build").description("maintainers: cut a shippable style from a scanned and reviewed profile")
    .requiredOption("--email <email>", "the scanned profile in ~/.idiolect/profiles")
    .requiredOption("--id <id>", "style id, like kotlin-tivi")
    .requiredOption("--title <title>", "the project the style is named after")
    .requiredOption("--summary <text>", "one short line on what the style feels like, shown in the list")
    .requiredOption("--language <language>", LANGUAGES.join(" | "))
    .requiredOption("--project <url>", "where the code lives, like github.com/chrisbanes/tivi")
    .requiredOption("--license <license>", "license of the source project")
    .option("--experimental", "nobody who writes the language has reviewed it")
    .option("--out <dir>", "where to write the style", STYLES_DIR)
    .action(async (o: { email: string; id: string; title: string; summary: string; language: string; project: string; license: string; experimental?: boolean; out: string }) => {
      if (!(LANGUAGES as readonly string[]).includes(o.language)) throw new Error(`unknown language ${o.language}`);
      if (o.summary.length > 60) throw new Error(`the summary is ${o.summary.length} characters, keep it to 60 so the list fits a terminal line`);
      const profile = await loadProfile(o.email);
      if (!profile) throw new Error(`no profile for ${o.email}`);
      const style = buildStyle(profile, { id: o.id, title: o.title, summary: o.summary, language: o.language as Language, project: o.project, license: o.license, experimental: o.experimental });
      const unreviewed = profile.rules.filter((r) => !r.evidence.metric && !r.repo && r.status === "auto").length;
      await mkdir(o.out, { recursive: true });
      await writeFile(join(o.out, `${o.id}.json`), JSON.stringify(style, null, 2) + "\n");
      console.log(`wrote ${join(o.out, `${o.id}.json`)}: ${style.rules.length} rules, ${style.rules.filter((r) => !r.evidence.metric).length} of them reviewed voice rules`);
      if (unreviewed) console.log(`${unreviewed} example-backed rules were left out because nobody approved or edited them, see: idiolect rules list --status auto`);
    });
  return styles;
}

const isDir = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);
const onPath = (cmd: string) => new Promise<boolean>((res) => execFile("which", [cmd], (err) => res(!err)));

/** AGENTS.md always. An agent's own file only when that agent is in use: Claude Code installed or a .claude folder, a .cursor folder. */
export async function filesToCreate(repo: string, claudeInstalled: boolean): Promise<Set<string>> {
  const create = new Set(["AGENTS.md"]);
  if (claudeInstalled || (await isDir(join(repo, ".claude")))) create.add("CLAUDE.md");
  if (await isDir(join(repo, ".cursor"))) create.add(".cursor/rules/idiolect.mdc");
  return create;
}

export function useCommand(): Command {
  return new Command("use").description("serve shipped styles in this repo, one per language, and write them into the agent files")
    .argument("<style...>", "style ids from idiolect styles")
    .option("--repo <path>", "repository path", ".")
    .option("--target <file...>", "agent files to write, overrides sync.targets in .idiolect/config.json")
    .option("--no-sync", "only record the choice, do not write agent files")
    .action(async (ids: string[], o: { repo: string; target?: string[]; sync: boolean }) => {
      const repo = await toplevel(o.repo);
      const chosen = await Promise.all(ids.map((id) => loadStyle(id)));
      const picked: Picked = { ...(await loadRepoConfig(repo)).styles };
      for (const s of chosen) picked[s.language] = s.id;
      // commit rules come from one style: keep the owner while it is still picked, else the first one named now
      const inUse = new Set(LANGUAGES.map((l) => picked[l]).filter(Boolean));
      if (!picked.commits || !inUse.has(picked.commits)) picked.commits = chosen[0]!.id;
      await updateRepoConfig(repo, { styles: picked });
      for (const l of LANGUAGES) if (picked[l]) console.log(`${l.padEnd(10)} ${picked[l]}`);
      console.log(`${"commits".padEnd(10)} ${picked.commits}`);
      if (!o.sync) return;
      const config = await loadRepoConfig(repo);
      const profile = (await loadServedProfile(repo))!;
      const create = await filesToCreate(repo, await onPath("claude"));
      const results = await syncTargets(repo, renderStyleMd(profile, { threshold: config.confidenceThreshold, repo }), o.target ?? config.sync.targets, create);
      for (const r of results) console.log(`${r.status.padEnd(9)} ${r.file}${r.status === "skipped" ? "  (not present, pass --target to create it)" : ""}`);
    });
}
