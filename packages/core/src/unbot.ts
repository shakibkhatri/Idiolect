import { z } from "zod";
import { checkStyle, type CheckOptions, type Violation } from "./check.js";
import type { LlmProvider } from "./llm.js";
import type { Profile, Rule } from "./profile.js";
import { appliesTo, renderStyleMd } from "./render.js";
import { isServed } from "./writer.js";

/** Served rules backed only by examples. checkStyle cannot measure these, so the LLM judges them. */
export function voiceRules(profile: Profile, opts: CheckOptions): Rule[] {
  return profile.rules.filter((r) => isServed(r, opts.threshold, profile.borrowed) && appliesTo(r, opts) && (!r.repo || r.repo === opts.repo) && !r.evidence.metric && r.category !== "commits");
}

const Found = z.object({ violations: z.array(z.object({
  rule_id: z.string(), line: z.number().int().describe("1-based line in the code"),
  message: z.string().describe("what in the code breaks the rule, one sentence"), suggestion: z.string().describe("how that line should read instead"),
})) });

/** Deep mode: the LLM checks voice rules and returns line-level violations. Unknown rule ids and lines outside the code are dropped. */
export async function deepCheck(profile: Profile, code: string, opts: CheckOptions, provider: LlmProvider): Promise<Violation[]> {
  const rules = voiceRules(profile, opts);
  if (!rules.length) return [];
  const list = rules.map((r) => `- [${r.id}] ${r.text}${r.evidence.examples[0] ? `\n  example from their code: ${r.evidence.examples[0].snippet.split("\n").slice(0, 3).join(" ").slice(0, 200)}` : ""}`).join("\n");
  const out = await provider.complete({
    system: `You lint code against one developer's voice rules. Each rule has an id. Report only clear violations of the listed rules, with the 1-based line number. Do not invent rules, do not judge correctness, do not report style the rules do not mention. Return JSON.\n\n# Rules\n${list}`,
    user: numbered(code), schema: Found,
  });
  const ids = new Set(rules.map((r) => r.id));
  const max = code.split("\n").length;
  return out.violations.filter((v) => ids.has(v.rule_id) && v.line >= 1 && v.line <= max).map((v) => ({ ruleId: v.rule_id, line: v.line, message: v.message, suggestion: v.suggestion }));
}

const numbered = (code: string) => code.split("\n").map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join("\n");

/** Fast metric check, plus the LLM voice check when a provider is given. */
export async function unbot(profile: Profile, code: string, opts: CheckOptions, provider?: LlmProvider): Promise<Violation[]> {
  const fast = await checkStyle(profile, code, opts);
  const deep = provider ? await deepCheck(profile, code, opts, provider) : [];
  return [...fast, ...deep].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

export const Rewrite = z.object({ code: z.string().describe("the rewritten code, nothing else"), changes: z.array(z.string()).describe("one line per change, what and why") });
export type RewriteScope = "comments" | "names" | "all";
const SCOPE: Record<RewriteScope, string> = {
  comments: "Change only comments and doc comments: add, remove, reword or recase them. Leave the code itself untouched.",
  names: "Change only identifier names. Leave logic, comments and structure untouched.",
  all: "Change comments, names and structure where the profile asks for it.",
};

/** Rewrites code in the developer's voice with behaviour unchanged. Shared by the MCP tool and unbot --fix. */
export async function rewriteLikeMe(profile: Profile, code: string, opts: CheckOptions & { scope?: RewriteScope }, provider: LlmProvider): Promise<z.infer<typeof Rewrite>> {
  const style = renderStyleMd(profile, { threshold: opts.threshold, repo: opts.repo, file: opts.file, language: opts.language });
  return provider.complete({
    system: `You rewrite code so it reads as if one developer wrote it. Behaviour must stay identical. ${SCOPE[opts.scope ?? "all"]} Do not add anything the profile does not ask for.\n\n${style}`,
    user: code, schema: Rewrite,
  });
}
