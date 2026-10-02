import { z } from "zod";
import { baselineRules } from "./baseline.js";
import type { LlmProvider } from "./llm.js";
import { COMMIT_METRICS, METRICS } from "./metrics.js";
import type { Language, Profile, Rule } from "./profile.js";
import type { Samples } from "./sampler.js";

export type WriteOptions = { minSampleSize: number; confidenceThreshold: number; repo?: string };

const LlmRules = z.object({
  rules: z.array(z.object({
    id: z.string().regex(/^[a-z0-9.-]+$/),
    scope: z.enum(["personal", "project"]),
    language: z.enum(["kotlin", "typescript", "python", "go", "any"]),
    category: z.enum(["naming", "comments", "structure", "errors", "framework", "commits", "avoid"]),
    text: z.string().min(10).max(400),
    examples: z.array(z.object({ file: z.string(), line: z.number().int() })).min(1).max(3),
    confidence: z.number().min(0).max(1),
  })),
  confirms: z.array(z.string()).describe("ids of existing personal rules that these samples also show"),
});

export const SYSTEM_PROMPT = `You write a coding style profile for one developer. AI coding agents will read it before writing code for them.
You receive: metrics computed from the developer's own code, rules already derived from those metrics, and samples of the developer's functions, comments and commit messages.
Write additional rules that capture how this developer writes: naming habits, comment voice and content, structure, error handling, framework idioms, commit message style.
Rules:
- Do not repeat or rephrase the metric rules you are given.
- Every rule must be backed by one to three example samples, cited by their exact file and line as given. A rule you cannot cite does not exist.
- Only state what the samples show. No generic best practices, nothing you would say about any developer.
- Rule text is one or two sentences, imperative, written as an instruction to an agent. Quote a short pattern from the samples when it helps.
- Write at most twelve rules, at most three per category. Pick the habits that show in most of the samples, not the ones that show in a few.
- Never write a rule that would make an agent add a comment, doc block or structure the samples mostly lack. Describe how the developer writes when they do write, never where to add more.
- scope is "personal" when the habit would hold in any codebase this developer works in: voice, phrasing, structure, error handling style, how they name and comment.
  scope is "project" when the rule depends on this codebase: its domain vocabulary, product or company names, specific libraries, wrappers, tokens, ticket formats, stakeholder names, team commit conventions. Project rules are only shown inside this repo, so be strict: anything naming a project-specific symbol, product or person is "project".
- You may be given personal rules already learned from the developer's other repos. Never rewrite or duplicate one. If the samples show the same habit, put its id in "confirms" instead. Only write a new rule for a habit not already covered.
- confidence is 0 to 1: the share of relevant samples that show the habit. 0.9 means nearly every relevant sample does it, 0.6 means some do.
- id is lowercase dotted, like kotlin.comments.explain-why or any.commits.mention-screen. language is the language the samples are in, or "any" for commits and habits that hold across languages.
Return JSON only.`;

export function buildPrompt(profile: Profile, samples: Samples, baseline: Rule[], existing: Rule[] = []): { system: string; user: string } {
  const metrics: Record<string, unknown> = {};
  for (const [lang, stats] of Object.entries(profile.stats)) for (const [id, fn] of Object.entries(METRICS)) { const m = fn(stats!); if (m.sampleSize) metrics[`${lang}.${id}`] = { value: Math.round(m.value * 100) / 100, n: m.sampleSize }; }
  for (const [id, fn] of Object.entries(COMMIT_METRICS)) { const m = fn(profile.commitStats); if (m.sampleSize) metrics[id] = { value: Math.round(m.value * 100) / 100, n: m.sampleSize }; }
  const block = (title: string, xs: { file: string; line: number; text: string }[]) =>
    `## ${title} (${xs.length})\n` + xs.map((s) => `[${s.file}:${s.line}]\n${s.text}`).join("\n\n");
  const user = [
    `# Developer: ${profile.developer.name}`,
    `# Metrics\n${JSON.stringify(metrics)}`,
    `# Rules already derived from metrics (do not repeat)\n${baseline.map((r) => `- ${r.text}`).join("\n")}`,
    existing.length ? `# Personal rules already learned from other repos (do not duplicate, confirm by id instead)\n${existing.map((r) => `- [${r.id}] ${r.text}`).join("\n")}` : "",
    block("Function samples", samples.functions),
    block("Comment samples", samples.comments),
    block("Commit message samples", samples.commits),
  ].join("\n\n");
  return { system: SYSTEM_PROMPT, user };
}

/** Baseline rules always. LLM rules only with a provider, and only when every cited example is one we actually sent. */
export async function writeRules(profile: Profile, samples: Samples, provider: LlmProvider | undefined, opts: WriteOptions): Promise<Rule[]> {
  const baseline = baselineRules(profile, opts);
  const fresh = [...baseline];
  // earlier example-backed rules survive unless this scan re-learns the same repo with a provider
  for (const r of profile.rules) {
    if (!r.evidence.examples.length) continue;
    if (provider && opts.repo && (r.learnedIn ?? opts.repo) === opts.repo) continue;
    if (!fresh.some((f) => f.id === r.id)) fresh.push(r);
  }
  if (provider) {
    const existing = fresh.filter((r) => r.evidence.examples.length && !r.repo);
    const prompt = buildPrompt(profile, samples, baseline, existing);
    const out = await provider.complete({ ...prompt, schema: LlmRules });
    for (const id of out.confirms) {
      const r = existing.find((e) => e.id === id);
      if (r) r.confidence = Math.min(1, Math.round((r.confidence + 0.1) * 100) / 100);
    }
    const sent = new Map([...samples.functions, ...samples.comments, ...samples.commits].map((s) => [`${s.file}:${s.line}`, s]));
    const ids = new Set(fresh.map((r) => r.id));
    for (const r of out.rules) {
      const examples = r.examples.map((e) => sent.get(`${e.file}:${e.line}`)).filter((s): s is NonNullable<typeof s> => !!s)
        .map((s) => ({ file: s.file, line: s.line, snippet: s.text.length > 240 ? s.text.slice(0, 240) + "…" : s.text }));
      if (!examples.length) continue;
      const id = r.id.startsWith(`${r.language}.`) ? r.id : `${r.language}.${r.id}`;
      if (ids.has(id)) continue;
      ids.add(id);
      fresh.push({ id, scope: "personal", language: r.language as Language | "any", category: r.category, text: r.text, evidence: { examples }, confidence: Math.round(r.confidence * 100) / 100, status: "auto", learnedIn: opts.repo, ...(r.scope === "project" && opts.repo ? { repo: opts.repo } : {}) });
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
