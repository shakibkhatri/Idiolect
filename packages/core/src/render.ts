import { matchesGlob } from "node:path";
import type { Profile, Rule } from "./profile.js";
import { isServed } from "./writer.js";

const LANGUAGE_NAMES: Record<string, string> = { kotlin: "Kotlin", typescript: "TypeScript", python: "Python", go: "Go" };
export const SECTIONS: [Rule["category"], string][] = [
  ["naming", "Naming"], ["comments", "Comments"], ["structure", "Structure"], ["errors", "Errors"],
  ["framework", "Framework"], ["commits", "Commits"], ["avoid", "Avoid"],
];

/** Example-backed rules served per section. The first quiz showed that more voice rules get applied everywhere, so fewer wins. */
const VOICE_RULES_PER_SECTION = 3;

/** `file` is relative to the repo and narrows path-scoped rules. */
export type RenderOptions = { threshold: number; language?: string; evidence?: boolean; repo?: string; file?: string };

export const appliesTo = (r: Rule, opts: { language?: string; file?: string }) =>
  (!opts.language || r.language === "any" || r.language === opts.language) && (!opts.file || !r.paths?.length || r.paths.some((g) => matchesGlob(opts.file!, g)));

/** Personal rules always. Project rules only when rendering for the repo they were learned in. */
export function renderStyleMd(profile: Profile, opts: RenderOptions): string {
  // a language under 5% of the developer's lines only shows up when asked for, so six scripts do not pad a Kotlin profile
  const total = Object.values(profile.stats).reduce((n, s) => n + (s?.loc ?? 0), 0);
  // borrowed styles come from repos of unrelated sizes, so a share of lines says nothing there
  const minor = new Set(profile.borrowed ? [] : Object.entries(profile.stats).filter(([, s]) => total && (s?.loc ?? 0) / total < 0.05).map(([l]) => l));
  const served = profile.rules.filter((r) => isServed(r, opts.threshold, profile.borrowed) && appliesTo(r, opts) && (opts.language || !minor.has(r.language)));
  const rules = served.filter((r) => !r.repo);
  const project = opts.repo ? served.filter((r) => r.repo === opts.repo) : [];
  const langs = new Set(served.map((r) => r.language).filter((l) => l !== "any"));
  // a text shared by every served language needs no label, one shared by some names exactly those
  const label = (...rs: Rule[]) => {
    const own = [...new Set(rs.map((r) => r.language))];
    if (own.includes("any")) return "";
    // a borrowed style lands in a repo with other languages, so its language rules always say which one they are for
    if (!profile.borrowed && (langs.size < 2 || own.length === langs.size)) return "";
    return `${own.map((l) => LANGUAGE_NAMES[l] ?? l).join(", ")}: `;
  };
  const learned = `${profile.sources.length} ${profile.sources.length === 1 ? "repo" : "repos"}, ${profile.sources.reduce((n, s) => n + s.linesOwned, 0)} lines`;
  const out = [`# Code style: ${profile.borrowed ? "borrowed from " : ""}${profile.developer.name}`, ""];
  if (profile.borrowed) {
    out.push(`${profile.provenance ?? `Learned from ${learned} of ${profile.developer.name}'s own code${snapshot(profile)}.`} It is a borrowed style, not the style of the developer you are working for. It shapes ${shapes(profile.borrowed)}.`, "");
    out.push(`The code already in this repo, its formatter and current language practice win over any rule here.`, "");
  } else {
    out.push(`Learned from ${learned} of the developer's own code. Follow these when writing code, comments and commits for them.`, "");
  }
  out.push(`Rules with numbers say how much. Match those quantities first: do not add comments, docs or structure beyond them. The other rules describe voice and apply only where you would write something anyway. Plain code with no comment is often the right answer.`, "");
  for (const [category, title] of SECTIONS) {
    // metric-backed rules first: they bound how much, the example-backed ones describe how
    const own = capVoice(rules.filter((r) => r.category === category && r.scope === "personal").sort((a, b) => Number(!!b.evidence.metric) - Number(!!a.evidence.metric) || b.confidence - a.confidence));
    if (!own.length) continue;
    out.push(`## ${title}`, "");
    // the same text learned for two languages, like an avoid rule, is one line
    const byText = new Map<string, Rule[]>();
    for (const r of own) byText.set(r.text, [...(byText.get(r.text) ?? []), r]);
    // comment voice rules are the ones agents over-apply, so they get a lead-in that ties them to the quantities above
    let leadIn = category === "comments" && !!own[0]!.evidence.metric;
    for (const [text, rs] of byText) {
      if (leadIn && !rs[0]!.evidence.metric) { out.push("", "Those numbers bound how many. When a comment is warranted, it reads like this:", ""); leadIn = false; }
      out.push(`- ${label(...rs)}${text}${opts.evidence ? evidence(rs[0]!) : ""}`);
    }
    out.push("");
  }
  if (project.length) {
    out.push(`## Project conventions (${opts.repo!.split("/").pop()})`, "", "These hold in this repo only. They come from its vocabulary, libraries and team habits.", "");
    for (const r of capVoice(project.sort((a, b) => b.confidence - a.confidence))) out.push(`- ${label(r)}${r.text}${opts.evidence ? evidence(r) : ""}`);
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

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The newest commit the profile was learned from, so a reader can tell how old a borrowed style is. */
function snapshot(profile: Profile): string {
  const newest = profile.sources.map((s) => s.headDate).filter((d): d is string => !!d).sort().at(-1);
  return newest ? `, written up to ${monthYear(newest)}` : "";
}
export const monthYear = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

const KIND_SHAPES = { voice: "naming, comments, commit messages", layout: "layout", idiom: "the choice of language features" };
const shapes = (kinds: NonNullable<Profile["borrowed"]>) => {
  const parts = (["voice", "layout", "idiom"] as const).filter((k) => kinds.includes(k)).map((k) => KIND_SHAPES[k]);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "nothing";
};

/** Keeps every metric rule and every rule the developer approved or edited, then the top voice rules by confidence. */
function capVoice(sorted: Rule[]): Rule[] {
  let voice = 0;
  return sorted.filter((r) => r.evidence.metric || r.status !== "auto" || ++voice <= VOICE_RULES_PER_SECTION);
}

function evidence(r: Rule): string {
  const parts: string[] = [];
  if (r.evidence.metric) parts.push(`${r.evidence.metric.name} = ${r.evidence.metric.value}, n = ${r.evidence.metric.sampleSize}`);
  if (r.evidence.examples.length) parts.push(r.evidence.examples.map((e) => (e.file.startsWith("commit:") ? e.file : `${e.file}:${e.line}`)).join(", "));
  return `  _(${parts.join("; ")}; confidence ${r.confidence})_`;
}
