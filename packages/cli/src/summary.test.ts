import { emptyProfile, emptyStats, type Rule } from "@shakibkhatri/idiolect-core";
import { expect, test } from "vitest";
import { llmHint, scanSummary } from "./summary.js";

const rule = (id: string, language: Rule["language"], metric: boolean): Rule =>
  ({ id, scope: "personal", language, category: "naming", text: id, evidence: { examples: [], ...(metric ? { metric: { name: "m", value: 1, sampleSize: 30 } } : {}) }, confidence: 0.9, status: metric ? "auto" : "pending" });

test("a scan ends with one line per language, the total and the next step", () => {
  const profile = { ...emptyProfile("Shakib", ["shakib@example.com"]), rules: [rule("a", "kotlin", true), rule("b", "kotlin", false), rule("c", "typescript", true), rule("d", "any", true)] };
  const stats = { kotlin: { ...emptyStats(), files: 794, loc: 95536 }, typescript: { ...emptyStats(), files: 1, loc: 8210 } };
  expect(scanSummary(profile, stats, { commits: 523, agentCommits: 42, llm: true }).split("\n")).toEqual([
    "Kotlin      794 files, 95536 lines, 2 rules",
    "TypeScript     1 file,  8210 lines, 1 rule",
    "Commits     523 commits, 1 rule, 42 written by an agent left out",
    "",
    "Learned 4 rules, 1 of them from examples of your code.",
    "1 rule changed and waits for your decision: idiolect rules list --status pending",
    "Next: idiolect show to read them, idiolect sync to give them to your agent.",
  ]);
  expect(scanSummary(profile, stats, { commits: 1, llm: false })).toContain("Learned 4 rules from measurements alone, no LLM was used.");
});

test("a failed LLM call is followed by what to run, with the sign-in step for a lapsed login", () => {
  expect(llmHint("claude CLI: Failed to authenticate: OAuth session expired and could not be refreshed", "scan"))
    .toBe("run: claude, sign in with /login, then idiolect scan again, or idiolect scan --no-llm for metric rules alone");
  expect(llmHint("fetch failed", "scan")).toMatch(/^run: idiolect scan --no-llm/);
  expect(llmHint("fetch failed", "eval")).toBe("run: idiolect init to check or change the LLM provider");
});
