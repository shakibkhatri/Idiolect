import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CommitStats, LanguageStats } from "./analyzer.js";
import { metric, type Metric } from "./metrics.js";
import type { Language, Profile, Rule } from "./profile.js";

type Kind = "high" | "low" | "value";
type Def = { metric: string; category: Rule["category"]; kind: Kind; min?: number; text: (m: Metric, s: LanguageStats) => string };

const n = (x: number) => Math.round(x * 10) / 10;

/** Deterministic rules, one per metric, phrased from the number itself. "high" fires at >= 0.8, "low" at <= 0.2, "value" always. */
const KOTLIN_DEFS: Def[] = [
  { metric: "functions.expression-body-ratio", category: "structure", kind: "high", text: () => "Use expression bodies for single-expression functions." },
  { metric: "functions.expression-body-ratio", category: "structure", kind: "low", text: () => "Use block bodies, even for short functions." },
  { metric: "functions.early-return-ratio", category: "structure", kind: "high", text: () => "Prefer guard clauses and early returns over nested conditionals." },
  { metric: "functions.length-p50", category: "structure", kind: "value", text: (m, s) => `Keep functions short. Typical length is ${m.value} lines, 90% are under ${metric("functions.length-p90", s).value} lines.` },
  { metric: "functions.params-p90", category: "structure", kind: "value", text: (m) => `Functions take at most ${m.value} parameters in 90% of cases.` },
  { metric: "functions.nesting-p90", category: "structure", kind: "value", text: (m) => `Keep nesting shallow. 90% of functions nest at most ${m.value} levels deep.` },
  { metric: "naming.constant-screaming-ratio", category: "naming", kind: "high", text: () => "Constants are SCREAMING_SNAKE_CASE." },
  { metric: "naming.constant-screaming-ratio", category: "naming", kind: "low", text: () => "Constants are PascalCase or camelCase, not SCREAMING_SNAKE_CASE." },
  { metric: "naming.abbreviation-ratio", category: "naming", kind: "low", text: () => "Spell names out. Avoid abbreviations." },
  { metric: "naming.boolean-is-has-ratio", category: "naming", kind: "high", text: () => "Prefix boolean names with is, has, can or should." },
  { metric: "naming.test-backtick-ratio", category: "naming", kind: "high", text: () => "Name tests as backtick sentences: fun `shows error when offline`()." },
  { metric: "naming.test-camel-sentence-ratio", category: "naming", kind: "high", text: () => "Name tests as camelCase sentences: fun aDeviceWithoutPowerIsRejected()." },
  { metric: "comments.per-100-loc", category: "comments", kind: "value", text: (m) => `Comment sparingly. About ${n(m.value)} comments per 100 lines of code.` },
  { metric: "comments.doc-ratio", category: "comments", kind: "high", text: () => "Most comments are KDoc blocks on declarations, not inline comments." },
  { metric: "comments.doc-ratio", category: "comments", kind: "low", text: () => "Use inline // comments. KDoc is rare." },
  { metric: "comments.lowercase-start-ratio", category: "comments", kind: "high", text: () => "Start comments in lowercase." },
  { metric: "comments.lowercase-start-ratio", category: "comments", kind: "low", text: () => "Start comments with a capital letter." },
  { metric: "comments.trailing-period-ratio", category: "comments", kind: "high", text: () => "End comments with a period." },
  { metric: "comments.trailing-period-ratio", category: "comments", kind: "low", text: () => "No trailing period on comments." },
  { metric: "comments.avg-chars", category: "comments", kind: "value", text: (m) => `Comments average ${m.value} characters.` },
  { metric: "comments.public-doc-ratio", category: "comments", kind: "high", text: () => "Document public declarations with KDoc." },
  { metric: "comments.public-doc-ratio", category: "comments", kind: "low", text: () => "Do not add KDoc to public declarations by default. The name should carry the meaning." },
  { metric: "errors.run-catching-share", category: "errors", kind: "high", text: () => "Wrap failures with runCatching and return Result instead of try/catch." },
  { metric: "errors.run-catching-share", category: "errors", kind: "low", text: () => "Use try/catch. runCatching and Result are rare." },
  { metric: "kotlin.when-ratio", category: "structure", kind: "high", text: () => "Use when instead of if/else chains with three or more branches." },
  { metric: "kotlin.sealed-interface-ratio", category: "structure", kind: "high", text: () => "Prefer sealed interface over sealed class." },
  { metric: "kotlin.sealed-interface-ratio", category: "structure", kind: "low", text: () => "Prefer sealed class over sealed interface." },
  { metric: "kotlin.extension-per-kloc", category: "structure", kind: "value", min: 2, text: (m) => `Extension functions are common, about ${n(m.value)} per 1000 lines.` },
  { metric: "kotlin.data-class-ratio", category: "structure", kind: "high", text: () => "Model data with data classes." },
];

const COMMIT_DEFS: Def[] = [
  { metric: "commits.conventional-ratio", category: "commits", kind: "high", text: () => "Use conventional commit prefixes: feat:, fix:, refactor:." },
  { metric: "commits.conventional-ratio", category: "commits", kind: "low", text: () => "No conventional commit prefixes. Plain sentences." },
  { metric: "commits.lowercase-ratio", category: "commits", kind: "high", text: () => "Commit subjects start lowercase." },
  { metric: "commits.lowercase-ratio", category: "commits", kind: "low", text: () => "Commit subjects start with a capital letter." },
  { metric: "commits.imperative-ratio", category: "commits", kind: "high", text: () => "Write commit subjects in the imperative: Add, Fix, Remove." },
  { metric: "commits.past-ratio", category: "commits", kind: "high", text: () => "Write commit subjects in past tense: Added, Fixed, Removed." },
  { metric: "commits.trailing-period-ratio", category: "commits", kind: "low", text: () => "No period at the end of a commit subject." },
  { metric: "commits.body-ratio", category: "commits", kind: "high", text: () => "Commits have a body explaining why." },
  { metric: "commits.body-ratio", category: "commits", kind: "low", text: () => "Subject line only. Commit bodies are rare." },
  { metric: "commits.subject-p50", category: "commits", kind: "value", text: (m) => `Commit subjects are about ${m.value} characters.` },
];

type Tell = { id: string; metric: string; text: string };
const TELLS: Tell[] = JSON.parse(readFileSync(fileURLToPath(new URL("../../../data/ai-tells.json", import.meta.url)), "utf8"));

export type BaselineOptions = { minSampleSize: number };

export function baselineRules(profile: Profile, opts: BaselineOptions): Rule[] {
  const rules: Rule[] = [];
  for (const lang of Object.keys(profile.stats) as Language[]) {
    const stats = profile.stats[lang]!;
    for (const def of KOTLIN_DEFS) {
      const r = ruleFromDef(def, lang, metric(def.metric, stats), stats, opts, profile.sources.map((s) => s.stats[lang]).filter((x): x is LanguageStats => !!x).map((s) => metric(def.metric, s)));
      if (r) rules.push(r);
    }
    for (const tell of TELLS) {
      const m = metric(tell.metric, stats);
      if (m.sampleSize < opts.minSampleSize) continue;
      const never = tell.metric.endsWith("per-kloc") ? m.value <= 0.5 : m.value <= 0.05;
      if (!never) continue;
      rules.push(mk(`avoid.${tell.id}`, "avoid", lang, tell.text, tell.metric, m, wilsonLower(1 - Math.min(1, m.value), m.sampleSize)));
    }
  }
  const c = profile.commitStats;
  for (const def of COMMIT_DEFS) {
    const r = ruleFromDef(def, "any", metric(def.metric, undefined, c), undefined, opts, profile.sources.map((s) => metric(def.metric, undefined, s.commitStats)));
    if (r) rules.push(r);
  }
  return rules;
}

function ruleFromDef(def: Def, lang: Language | "any", m: Metric, stats: LanguageStats | undefined, opts: BaselineOptions, perSource: Metric[]): Rule | undefined {
  if (m.sampleSize < opts.minSampleSize) return;
  let confidence: number;
  if (def.kind === "high") { if (m.value < 0.8) return; confidence = wilsonLower(m.value, m.sampleSize); }
  else if (def.kind === "low") { if (m.value > 0.2) return; confidence = wilsonLower(1 - m.value, m.sampleSize); }
  else { if (def.min !== undefined && m.value < def.min) return; confidence = 0.3 + 0.5 * Math.min(1, m.sampleSize / 100); }
  let text = def.text(m, stats ?? ({} as LanguageStats));
  // a metric that disagrees strongly between repos is probably a team convention, not the developer's own
  const strong = perSource.filter((p) => p.sampleSize >= opts.minSampleSize);
  if (def.kind !== "value" && strong.length >= 2 && Math.max(...strong.map((p) => p.value)) - Math.min(...strong.map((p) => p.value)) >= 0.4) {
    confidence *= 0.5;
    text += " Varies by repo, follow the repo you are in.";
  }
  return mk(`${lang}.${def.metric}.${def.kind}`, def.category, lang, text, def.metric, m, confidence);
}

/** 95% Wilson lower bound: "the true rate is at least this, with 95% confidence". Honest about small samples without killing them. */
export function wilsonLower(p: number, n: number): number {
  if (!n) return 0;
  const z = 1.96, z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - spread) / (1 + z2 / n));
}

const mk = (id: string, category: Rule["category"], language: Language | "any", text: string, name: string, m: Metric, confidence: number): Rule => ({
  id, scope: "personal", language, category, text,
  evidence: { metric: { name, value: Math.round(m.value * 1000) / 1000, sampleSize: m.sampleSize }, examples: [] },
  confidence: Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100,
  status: "auto",
});
