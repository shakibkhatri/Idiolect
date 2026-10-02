import { matchesGlob } from "node:path";
import type { Profile, Rule } from "./profile.js";
import { isServed } from "./writer.js";

const LANGUAGE_NAMES: Record<string, string> = { kotlin: "Kotlin", typescript: "TypeScript" };
const SECTIONS: [Rule["category"], string][] = [
  ["naming", "Naming"], ["comments", "Comments"], ["structure", "Structure"], ["errors", "Errors"],
  ["framework", "Framework"], ["commits", "Commits"], ["avoid", "Avoid"],
];

/** `file` is relative to the repo and narrows path-scoped rules. */
export type RenderOptions = { threshold: number; language?: string; evidence?: boolean; repo?: string; file?: string };

export const appliesTo = (r: Rule, opts: { language?: string; file?: string }) =>
  (!opts.language || r.language === "any" || r.language === opts.language) && (!opts.file || !r.paths?.length || r.paths.some((g) => matchesGlob(opts.file!, g)));

/** Personal rules always. Project rules only when rendering for the repo they were learned in. */
export function renderStyleMd(profile: Profile, opts: RenderOptions): string {
  const served = profile.rules.filter((r) => isServed(r, opts.threshold) && appliesTo(r, opts));
  const rules = served.filter((r) => !r.repo);
  const project = opts.repo ? served.filter((r) => r.repo === opts.repo) : [];
  const langs = new Set(served.map((r) => r.language).filter((l) => l !== "any"));
  const label = (r: Rule) => (langs.size > 1 && r.language !== "any" ? `${LANGUAGE_NAMES[r.language] ?? r.language}: ` : "");
  const out = [`# Code style: ${profile.developer.name}`, ""];
  out.push(`Learned from ${profile.sources.length} ${profile.sources.length === 1 ? "repo" : "repos"}, ${profile.sources.reduce((n, s) => n + s.linesOwned, 0)} lines of the developer's own code. Follow these when writing code, comments and commits for them.`, "");
  out.push(`Rules with numbers say how much. Match those quantities first: do not add comments, docs or structure beyond them. The other rules describe voice and apply only where you would write something anyway. Plain code with no comment is often the right answer.`, "");
  for (const [category, title] of SECTIONS) {
    // metric-backed rules first: they bound how much, the example-backed ones describe how
    const own = rules.filter((r) => r.category === category && r.scope === "personal").sort((a, b) => Number(!!b.evidence.metric) - Number(!!a.evidence.metric) || b.confidence - a.confidence);
    if (!own.length) continue;
    out.push(`## ${title}`, "");
    // the same text learned for two languages, like an avoid rule, is one line without a language label
    const byText = new Map<string, Rule[]>();
    for (const r of own) byText.set(r.text, [...(byText.get(r.text) ?? []), r]);
    for (const [text, rs] of byText) out.push(`- ${rs.length > 1 ? "" : label(rs[0]!)}${text}${opts.evidence ? evidence(rs[0]!) : ""}`);
    out.push("");
  }
  if (project.length) {
    out.push(`## Project conventions (${opts.repo!.split("/").pop()})`, "", "These hold in this repo only. They come from its vocabulary, libraries and team habits.", "");
    for (const r of project.sort((a, b) => b.confidence - a.confidence)) out.push(`- ${label(r)}${r.text}${opts.evidence ? evidence(r) : ""}`);
    out.push("");
  }
  const team = rules.filter((r) => r.scope === "team");
  if (team.length) {
    out.push("## Team rules", "");
    for (const r of team) out.push(`- ${r.text}${r.evidence.count ? ` (flagged ${r.evidence.count}x)` : ""}`);
    out.push("");
  }
  return out.join("\n");
}

function evidence(r: Rule): string {
  const parts: string[] = [];
  if (r.evidence.metric) parts.push(`${r.evidence.metric.name} = ${r.evidence.metric.value}, n = ${r.evidence.metric.sampleSize}`);
  if (r.evidence.examples.length) parts.push(r.evidence.examples.map((e) => (e.file.startsWith("commit:") ? e.file : `${e.file}:${e.line}`)).join(", "));
  return `  _(${parts.join("; ")}; confidence ${r.confidence})_`;
}
