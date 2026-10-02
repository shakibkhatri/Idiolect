import type { Profile, Rule } from "./profile.js";
import { isServed } from "./writer.js";

const SECTIONS: [Rule["category"], string][] = [
  ["naming", "Naming"], ["comments", "Comments"], ["structure", "Structure"], ["errors", "Errors"],
  ["framework", "Framework"], ["commits", "Commits"], ["avoid", "Avoid"],
];

export type RenderOptions = { threshold: number; language?: string; evidence?: boolean };

export function renderStyleMd(profile: Profile, opts: RenderOptions): string {
  const rules = profile.rules.filter((r) => isServed(r, opts.threshold) && (!opts.language || r.language === "any" || r.language === opts.language));
  const out = [`# Code style: ${profile.developer.name}`, ""];
  out.push(`Learned from ${profile.sources.length} ${profile.sources.length === 1 ? "repo" : "repos"}, ${profile.sources.reduce((n, s) => n + s.linesOwned, 0)} lines of the developer's own code. Follow these when writing code, comments and commits for them.`, "");
  for (const [category, title] of SECTIONS) {
    const own = rules.filter((r) => r.category === category && r.scope === "personal").sort((a, b) => b.confidence - a.confidence);
    if (!own.length) continue;
    out.push(`## ${title}`, "");
    for (const r of own) out.push(`- ${r.text}${opts.evidence ? evidence(r) : ""}`);
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
