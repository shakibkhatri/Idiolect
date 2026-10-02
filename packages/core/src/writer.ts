import { z } from "zod";
import { baselineRules } from "./baseline.js";
import type { LlmProvider } from "./llm.js";
import { COMMIT_METRICS, METRICS } from "./metrics.js";
import type { Language, Profile, Rule } from "./profile.js";
import type { Samples } from "./sampler.js";

export type WriteOptions = { minSampleSize: number; confidenceThreshold: number };

const LlmRules = z.object({
  rules: z.array(z.object({
    id: z.string().regex(/^[a-z0-9.-]+$/),
    language: z.enum(["kotlin", "any"]),
    category: z.enum(["naming", "comments", "structure", "errors", "framework", "commits", "avoid"]),
    text: z.string().min(10).max(400),
    examples: z.array(z.object({ file: z.string(), line: z.number().int() })).min(1).max(3),
    confidence: z.number().min(0).max(1),
  })),
});

export const SYSTEM_PROMPT = `You write a coding style profile for one developer. AI coding agents will read it before writing code for them.
You receive: metrics computed from the developer's own code, rules already derived from those metrics, and samples of the developer's functions, comments and commit messages.
Write additional rules that capture how this developer writes: naming habits, comment voice and content, structure, error handling, framework idioms, commit message style.
Rules:
- Do not repeat or rephrase the metric rules you are given.
- Every rule must be backed by one to three example samples, cited by their exact file and line as given. A rule you cannot cite does not exist.
- Only state what the samples show. No generic best practices, nothing you would say about any developer.
- Rule text is one or two sentences, imperative, written as an instruction to an agent. Quote a short pattern from the samples when it helps.
- Prefer a few specific rules over many vague ones. Ten to twenty rules is typical.
- confidence is 0 to 1: how consistently the samples show the habit.
- id is lowercase dotted, like kotlin.comments.explain-why or any.commits.mention-screen.
Return JSON only.`;

export function buildPrompt(profile: Profile, samples: Samples, baseline: Rule[]): { system: string; user: string } {
  const metrics: Record<string, unknown> = {};
  for (const [lang, stats] of Object.entries(profile.stats)) for (const [id, fn] of Object.entries(METRICS)) { const m = fn(stats!); if (m.sampleSize) metrics[`${lang}.${id}`] = { value: Math.round(m.value * 100) / 100, n: m.sampleSize }; }
  for (const [id, fn] of Object.entries(COMMIT_METRICS)) { const m = fn(profile.commitStats); if (m.sampleSize) metrics[id] = { value: Math.round(m.value * 100) / 100, n: m.sampleSize }; }
  const block = (title: string, xs: { file: string; line: number; text: string }[]) =>
    `## ${title} (${xs.length})\n` + xs.map((s) => `[${s.file}:${s.line}]\n${s.text}`).join("\n\n");
  const user = [
    `# Developer: ${profile.developer.name}`,
    `# Metrics\n${JSON.stringify(metrics)}`,
    `# Rules already derived from metrics (do not repeat)\n${baseline.map((r) => `- ${r.text}`).join("\n")}`,
    block("Function samples", samples.functions),
    block("Comment samples", samples.comments),
    block("Commit message samples", samples.commits),
  ].join("\n\n");
  return { system: SYSTEM_PROMPT, user };
}

/** Baseline rules always. LLM rules only with a provider, and only when every cited example is one we actually sent. */
export async function writeRules(profile: Profile, samples: Samples, provider: LlmProvider | undefined, opts: WriteOptions): Promise<Rule[]> {
  const baseline = baselineRules(profile, opts);
  let fresh = baseline;
  if (provider) {
    const prompt = buildPrompt(profile, samples, baseline);
    const out = await provider.complete({ ...prompt, schema: LlmRules });
    const sent = new Map([...samples.functions, ...samples.comments, ...samples.commits].map((s) => [`${s.file}:${s.line}`, s]));
    const ids = new Set(baseline.map((r) => r.id));
    for (const r of out.rules) {
      const examples = r.examples.map((e) => sent.get(`${e.file}:${e.line}`)).filter((s): s is NonNullable<typeof s> => !!s)
        .map((s) => ({ file: s.file, line: s.line, snippet: s.text.length > 240 ? s.text.slice(0, 240) + "…" : s.text }));
      if (!examples.length) continue;
      const id = r.id.startsWith(`${r.language}.`) ? r.id : `${r.language}.${r.id}`;
      if (ids.has(id)) continue;
      ids.add(id);
      fresh.push({ id, scope: "personal", language: r.language as Language | "any", category: r.category, text: r.text, evidence: { examples }, confidence: Math.round(r.confidence * 100) / 100, status: "auto" });
    }
  }
  return reconcile(profile.rules, fresh);
}

/** Keeps the user's decisions across rescans. Approved text that changed becomes pending, edited text wins, rejected stays rejected. */
export function reconcile(previous: Rule[], fresh: Rule[]): Rule[] {
  const prev = new Map(previous.map((r) => [r.id, r]));
  return fresh.map((r) => {
    const p = prev.get(r.id);
    if (!p) return r;
    if (p.status === "edited") return { ...r, text: p.text, status: "edited" };
    if (p.status === "rejected") return { ...r, status: "rejected" };
    if (p.status === "approved") return p.text === r.text ? { ...r, status: "approved" } : { ...r, status: "pending" };
    if (p.status === "pending") return { ...r, status: "pending" };
    return r;
  });
}

export const isServed = (r: Rule, threshold: number) => (r.status === "auto" || r.status === "approved" || r.status === "edited") && r.confidence >= threshold;
