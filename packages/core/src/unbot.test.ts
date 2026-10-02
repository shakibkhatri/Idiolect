import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { LlmProvider } from "./llm.js";
import { emptyProfile, type Profile, type Rule } from "./profile.js";
import { deepCheck, unbot } from "./unbot.js";

const ai = readFileSync(fileURLToPath(new URL("../../../fixtures/kotlin/AiWritten.kt", import.meta.url)), "utf8");
const human = readFileSync(fileURLToPath(new URL("../../../fixtures/kotlin/Sample.kt", import.meta.url)), "utf8");

const avoid = (id: string, name: string, text = id): Rule => ({ id: `avoid.${id}`, scope: "personal", language: "kotlin", category: "avoid", text, confidence: 1, status: "auto", evidence: { metric: { name, value: 0, sampleSize: 5000 }, examples: [] } });
const profile: Profile = {
  ...emptyProfile("me", ["me@x"]),
  rules: [
    avoid("comments.buzzwords", "comments.buzzword-ratio"), avoid("comments.restating", "comments.restates-ratio"), avoid("comments.emoji", "comments.emoji-ratio"),
    avoid("comments.private-docblocks", "comments.private-doc-ratio"), avoid("naming.generic", "naming.generic-ratio"), avoid("errors.try-everything", "errors.try-per-kloc"),
    avoid("errors.force-unwrap", "errors.force-unwrap-per-kloc"), avoid("comments.todo", "comments.todo-ratio"),
    { id: "kotlin.comments.why", scope: "personal", language: "kotlin", category: "comments", text: "Comments say why, never what.", confidence: 0.9, status: "auto", evidence: { examples: [{ file: "A.kt", line: 1, snippet: "// cache by id" }] } },
    { id: "kotlin.structure.rejected", scope: "personal", language: "kotlin", category: "structure", text: "Never served.", confidence: 0.9, status: "rejected", evidence: { examples: [{ file: "A.kt", line: 1, snippet: "x" }] } },
  ],
};
const opts = { language: "kotlin" as const, threshold: 0.6 };

test("fast mode flags every AI tell in the fixture with lines where they can be located, and nothing in the human sample", async () => {
  const v = await unbot(profile, ai, opts);
  const byRule = (id: string) => v.filter((x) => x.ruleId === `avoid.${id}`);
  expect(byRule("comments.buzzwords").map((x) => x.line)).toEqual([3]);
  expect(byRule("comments.restating").map((x) => x.line)).toEqual([3]);
  expect(byRule("comments.emoji").map((x) => x.line)).toEqual([30]);
  expect(byRule("comments.todo").map((x) => x.line)).toEqual([25]);
  expect(byRule("errors.force-unwrap").map((x) => x.line)).toEqual([18]);
  expect(byRule("comments.private-docblocks").map((x) => x.line)).toEqual([21, 36]);
  expect(byRule("naming.generic")).toHaveLength(1);
  expect(byRule("errors.try-everything")).toHaveLength(1);
  expect(await unbot(profile, human, opts)).toEqual([]);
});

test("repo config floors decide when a quantity rule has enough data to fire", async () => {
  const high: Rule = { id: "kotlin.functions.expression-body-ratio.high", scope: "personal", language: "kotlin", category: "structure", text: "Use expression bodies.", confidence: 0.9, status: "auto", evidence: { metric: { name: "functions.expression-body-ratio", value: 0.9, sampleSize: 500 }, examples: [] } };
  const p = { ...profile, rules: [high] };
  expect(await unbot(p, ai, opts)).toEqual([]); // the fixture has fewer than ten functions
  const loose = await unbot(p, ai, { ...opts, floors: { minItems: 1, minLines: 1, minLocated: 1, excess: 1 } });
  expect(loose.map((v) => v.ruleId)).toEqual(["kotlin.functions.expression-body-ratio.high"]);
});

test("deep mode keeps only known rule ids and lines inside the code", async () => {
  const provider: LlmProvider = { name: "fake", model: "m", complete: async () => ({ violations: [
    { rule_id: "kotlin.comments.why", line: 15, message: "restates the call", suggestion: "drop it" },
    { rule_id: "kotlin.structure.rejected", line: 2, message: "x", suggestion: "x" },
    { rule_id: "made.up", line: 2, message: "x", suggestion: "x" },
    { rule_id: "kotlin.comments.why", line: 999, message: "x", suggestion: "x" },
  ] }) as never };
  const v = await deepCheck(profile, ai, opts, provider);
  expect(v).toEqual([{ ruleId: "kotlin.comments.why", line: 15, message: "restates the call", suggestion: "drop it" }]);
  expect(await deepCheck({ ...profile, rules: profile.rules.filter((r) => r.evidence.metric) }, ai, opts, provider)).toEqual([]);
});
