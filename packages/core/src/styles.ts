import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommitStats, LanguageStats } from "./analyzer.js";
import { ruleKind, type Language, type Profile, type Rule } from "./profile.js";
import { monthYear } from "./render.js";

/** A frozen, reviewed style cut from one scanned profile. Ships in the package, names its source project, holds no emails and no code. */
export type Style = {
  version: 1;
  id: string;
  title: string;
  language: Language;
  experimental?: boolean;
  source: { project: string; license: string; commit: string; snapshot?: string; lines: number };
  stats: LanguageStats;
  commitStats: CommitStats;
  rules: Rule[];
};

export const STYLES_DIR = fileURLToPath(new URL("../styles", import.meta.url));
const LANGUAGE_NAMES: Record<Language, string> = { kotlin: "Kotlin", typescript: "TypeScript", python: "Python", go: "Go" };

export async function listStyles(dir = STYLES_DIR): Promise<Style[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as Style));
}

export async function loadStyle(id: string, dir = STYLES_DIR): Promise<Style> {
  const style = (await listStyles(dir)).find((s) => s.id === id);
  if (!style) throw new Error(`no style ${id}, see: idiolect styles`);
  return style;
}

export type BuildOptions = { id: string; title: string; language: Language; project: string; license: string; experimental?: boolean };

/**
 * Metric rules go in as measured. A rule the LLM wrote goes in only once a person approved or edited it,
 * because the same code scanned twice yields different LLM rules.
 */
export function buildStyle(profile: Profile, o: BuildOptions): Style {
  const stats = profile.stats[o.language];
  if (!stats) throw new Error(`the profile has no ${o.language} code`);
  const reviewed = (r: Rule) => (r.evidence.metric ? r.status === "auto" || r.status === "approved" || r.status === "edited" : r.status === "approved" || r.status === "edited");
  const rules = profile.rules
    .filter((r) => r.scope === "personal" && !r.repo && (r.language === o.language || r.language === "any") && reviewed(r))
    .map((r): Rule => ({
      id: r.id, scope: r.scope, language: r.language, category: r.category, kind: ruleKind(r), text: r.text,
      // the citation stays, the code it points at does not ship
      evidence: { ...(r.evidence.metric ? { metric: r.evidence.metric } : {}), examples: r.evidence.examples.map((e) => ({ file: e.file, line: e.line, snippet: "" })) },
      confidence: r.confidence, status: "auto",
    }));
  const newest = profile.sources.map((s) => s.headDate).filter((d): d is string => !!d).sort().at(-1);
  const head = profile.sources.find((s) => s.headDate === newest) ?? profile.sources[0];
  return {
    version: 1, id: o.id, title: o.title, language: o.language, ...(o.experimental ? { experimental: true } : {}),
    source: { project: o.project, license: o.license, commit: head?.head ?? "", ...(newest ? { snapshot: newest } : {}), lines: stats.loc },
    stats, commitStats: profile.commitStats, rules,
  };
}

export type Picked = Partial<Record<Language | "commits", string>>;

/** One profile out of the styles a repo picked: each language from its own style, commit rules from one of them. */
export async function composeStyles(picked: Picked, dir = STYLES_DIR): Promise<Profile> {
  const all = await listStyles(dir);
  const find = (id: string) => {
    const style = all.find((s) => s.id === id);
    if (!style) throw new Error(`no style ${id}, see: idiolect styles`);
    return style;
  };
  const languages = (Object.entries(picked) as [Language | "commits", string][]).filter(([l, id]) => l !== "commits" && id)
    .map(([l, id]) => ({ language: l as Language, style: find(id) }));
  for (const { language, style } of languages) if (style.language !== language) throw new Error(`style ${style.id} is a ${style.language} style, not ${language}`);
  const owner = picked.commits ? find(picked.commits) : languages[0]?.style;
  if (!owner) throw new Error("no styles picked");

  const rules = [...languages.flatMap(({ language, style }) => style.rules.filter((r) => r.language === language)), ...owner.rules.filter((r) => r.language === "any")];
  const used = [...new Map([...languages.map((l) => l.style), owner].map((s) => [s.id, s])).values()];
  const from = (s: Style) => `${s.title} (${s.source.project}${s.source.snapshot ? `, code up to ${monthYear(s.source.snapshot)}` : ""})`;
  const parts = [...languages.map(({ language, style }) => `${LANGUAGE_NAMES[language]} from ${from(style)}`), `commit messages from ${owner.title}`];
  return {
    version: 1,
    developer: { name: used.map((s) => s.title).join(", "), emails: [] },
    generatedAt: used.map((s) => s.source.snapshot ?? "").sort().at(-1) ?? "",
    sources: used.map((s) => ({ repo: s.source.project, head: s.source.commit, headDate: s.source.snapshot, scannedAt: "", commits: s.commitStats.count, linesOwned: s.source.lines, stats: { [s.language]: s.stats }, commitStats: s.commitStats })),
    stats: Object.fromEntries(languages.map(({ language, style }) => [language, style.stats])),
    commitStats: owner.commitStats,
    rules,
    shipped: true,
    provenance: `Learned from open source code: ${parts.join(", ")}.`,
  };
}
