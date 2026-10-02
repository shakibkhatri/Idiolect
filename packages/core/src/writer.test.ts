import { expect, test } from "vitest";
import { analyzeCommits, emptyStats } from "./analyzer.js";
import { baselineRules } from "./baseline.js";
import type { LlmProvider } from "./llm.js";
import { emptyProfile, upsertSource, type Profile, type Source } from "./profile.js";
import { redact } from "./redact.js";
import { renderStyleMd } from "./render.js";
import { collectSamples } from "./sampler.js";
import { reconcile, writeRules } from "./writer.js";

function source(repo: string, tweak: (s: ReturnType<typeof emptyStats>, c: ReturnType<typeof analyzeCommits>) => void): Source {
  const s = emptyStats(); const c = analyzeCommits([]);
  s.loc = 10000; s.functions.count = 300; s.functions.blockBody = 200; s.functions.expressionBody = 100;
  s.functions.lengthLines = { "5": 100, "12": 80, "30": 20 }; s.functions.params = { "1": 150, "3": 50 }; s.functions.maxNesting = { "1": 150, "3": 50 };
  s.comments.line = 100; s.comments.lowercaseStart = 5; s.comments.trailingPeriod = 90; s.comments.chars = 8000;
  s.comments.publicDecls = 100; s.comments.publicDocumented = 90; s.comments.privateDecls = 50; s.comments.privateDocumented = 1;
  s.errors.runCatching = 40; s.errors.tryCatch = 2; s.kotlin.when3 = 50; s.kotlin.ifElseChain3 = 3;
  c.count = 100; c.conventionalPrefix = 2; c.lowercaseStart = 3; c.tense = { past: 60, imperative: 40 };
  tweak(s, c);
  return { repo, head: "h", scannedAt: "t", commits: c.count, linesOwned: s.loc, stats: { kotlin: s }, commitStats: c };
}
const opts = { minSampleSize: 20, confidenceThreshold: 0.6 };

test("baseline rules fire on extreme ratios, with evidence, and detect repo divergence", () => {
  let p: Profile = upsertSource(emptyProfile("me", ["me@x"]), source("/a", () => {}));
  const rules = baselineRules(p, opts);
  const ids = rules.map((r) => r.id);
  expect(ids).toContain("kotlin.comments.trailing-period-ratio.high");
  expect(ids).toContain("kotlin.comments.lowercase-start-ratio.low");
  expect(ids).toContain("kotlin.errors.run-catching-share.high");
  expect(ids).toContain("kotlin.kotlin.when-ratio.high");
  expect(ids).toContain("avoid.kotlin.comments.private-docblocks");
  expect(ids).toContain("avoid.kotlin.errors.force-unwrap");
  expect(ids).toContain("any.commits.conventional-ratio.low");
  expect(ids).not.toContain("kotlin.comments.lowercase-start-ratio.high");
  for (const r of rules) expect(r.evidence.metric?.sampleSize).toBeGreaterThanOrEqual(20);
  // a second repo with the opposite commit convention halves confidence and flags it
  p = upsertSource(p, source("/b", (_, c) => { c.conventionalPrefix = 90; }));
  const conv = baselineRules(p, opts).find((r) => r.id.startsWith("any.commits.conventional-ratio"));
  expect(conv).toBeUndefined(); // merged ratio is 0.46, neither high nor low
  p = upsertSource(p, source("/b", (_, c) => { c.conventionalPrefix = 60; c.count = 100; }));
  const trailing = baselineRules(p, opts).find((r) => r.id === "kotlin.comments.trailing-period-ratio.high")!;
  expect(trailing.text).not.toContain("Varies");
  p = upsertSource(p, source("/b", (s) => { s.comments.trailingPeriod = 10; }));
  const varies = baselineRules(p, opts).find((r) => r.id === "kotlin.comments.trailing-period-ratio.high");
  expect(varies).toBeUndefined(); // merged 0.5
  p = upsertSource(p, source("/b", (s) => { s.comments.trailingPeriod = 65; s.comments.line = 100; }));
  const v2 = baselineRules(p, opts).find((r) => r.id === "kotlin.comments.trailing-period-ratio.high");
  expect(v2).toBeUndefined();
});

test("writer keeps only LLM rules whose examples were actually sent, and reconcile preserves decisions", async () => {
  const p = upsertSource(emptyProfile("me", ["me@x"]), source("/a", () => {}));
  const samples = await collectSamples([{ path: "A.kt", code: "// keep it simple\nfun a(x: Int): Int {\n    val y = x + 1\n    return y\n}\n" }], [{ hash: "h", email: "e", date: "d", subject: "Added login", body: "" }], { maxTokens: 5000 });
  expect(samples.functions).toHaveLength(1);
  expect(samples.comments).toHaveLength(1);
  const mock: LlmProvider = {
    name: "mock", model: "m",
    complete: async () => ({ rules: [
      { id: "comments.terse", scope: "personal", language: "kotlin", category: "comments", text: "Keep comments to a few lowercase words.", examples: [{ file: "A.kt", line: 1 }], confidence: 0.8 },
      { id: "kotlin.made-up", scope: "personal", language: "kotlin", category: "naming", text: "A rule with a fake citation that must be dropped.", examples: [{ file: "Nope.kt", line: 9 }], confidence: 0.9 },
      { id: "framework.crew", scope: "project", language: "kotlin", category: "framework", text: "Call the user the crew in comments.", examples: [{ file: "A.kt", line: 1 }], confidence: 0.9 },
    ], confirms: [] }) as never,
  };
  const rules = await writeRules(p, samples, mock, { ...opts, repo: "/a" });
  const llm = rules.filter((r) => r.evidence.examples.length);
  expect(llm.map((r) => r.id)).toEqual(["kotlin.comments.terse", "kotlin.framework.crew"]);
  expect(llm[0]!.evidence.examples[0]!.snippet).toBe("// keep it simple");
  expect(llm[0]).toMatchObject({ learnedIn: "/a" });
  expect(llm[0]!.repo).toBeUndefined();
  expect(llm[1]).toMatchObject({ learnedIn: "/a", repo: "/a" });

  const again = await writeRules({ ...p, rules }, samples, undefined, opts);
  expect(again.map((r) => r.id)).toContain("kotlin.comments.terse"); // no provider keeps earlier LLM rules
  const other = await writeRules({ ...p, rules }, samples, { ...mock, complete: async () => ({ rules: [], confirms: ["kotlin.comments.terse"] }) as never }, { ...opts, repo: "/b" });
  expect(other.find((r) => r.id === "kotlin.comments.terse")).toMatchObject({ confidence: 0.9 }); // another repo confirming raises confidence
  const relearn = await writeRules({ ...p, rules }, samples, { ...mock, complete: async () => ({ rules: [], confirms: [] }) as never }, { ...opts, repo: "/a" });
  expect(relearn.map((r) => r.id)).not.toContain("kotlin.comments.terse"); // re-learning /a replaces them

  const home = renderStyleMd({ ...p, rules }, { threshold: 0.6 });
  expect(home).not.toContain("the crew");
  const inRepo = renderStyleMd({ ...p, rules }, { threshold: 0.6, repo: "/a" });
  expect(inRepo).toContain("## Project conventions (a)");
  expect(inRepo).toContain("the crew");

  const prev = [
    { ...llm[0]!, status: "approved" as const },
    { ...rules.find((r) => r.id === "kotlin.comments.trailing-period-ratio.high")!, status: "edited" as const, text: "My own wording." },
    { ...rules.find((r) => r.id === "avoid.kotlin.errors.force-unwrap")!, status: "rejected" as const },
  ];
  const next = reconcile(prev, rules.map((r) => (r.id === "kotlin.comments.terse" ? { ...r, text: "changed" } : r)));
  expect(next.find((r) => r.id === "kotlin.comments.terse")!.status).toBe("pending");
  expect(next.find((r) => r.id === "kotlin.comments.trailing-period-ratio.high")).toMatchObject({ status: "edited", text: "My own wording." });
  expect(next.find((r) => r.id === "avoid.kotlin.errors.force-unwrap")!.status).toBe("rejected");

  const md = renderStyleMd({ ...p, rules: next }, { threshold: 0.6 });
  expect(md).toContain("## Comments");
  expect(md).toContain("- My own wording.");
  expect(md).not.toContain("changed"); // pending is not served
  expect(md).not.toContain("force-unwrap");
  expect(md).toContain("## Avoid");
});

test("redact strips key-like strings and keeps the rest", () => {
  expect(redact('val key = "sk-ant-abcdefghijklmnopqrstuvwxyz0123"')).toBe('val key = "[REDACTED]"');
  expect(redact("password = hunter2!!x")).toBe("password = [REDACTED]");
  expect(redact("https://user:pa55word@host/x")).toBe("https://user:[REDACTED]@host/x");
  expect(redact("fun getUser(id: String)")).toBe("fun getUser(id: String)");
});

test("sampler respects the token budget", async () => {
  const code = Array.from({ length: 50 }, (_, i) => `fun f${i}(x: Int): Int {\n    val y = x * ${i}\n    return y + 1\n}\n`).join("");
  const s = await collectSamples([{ path: "B.kt", code }], [], { maxTokens: 200 });
  expect(s.functions.length).toBeGreaterThan(0);
  expect(s.functions.length).toBeLessThan(50);
});
