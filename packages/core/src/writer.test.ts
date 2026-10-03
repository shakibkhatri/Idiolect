import { expect, test } from "vitest";
import { analyzeCommits, emptyStats } from "./analyzer.js";
import { baselineRules } from "./baseline.js";
import type { LlmProvider } from "./llm.js";
import { emptyProfile, upsertSource, type Profile, type Source } from "./profile.js";
import { redact } from "./redact.js";
import { renderStyleMd } from "./render.js";
import { collectSamples } from "./sampler.js";
import { isServed, reconcile, writeRules } from "./writer.js";

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
  expect(next.find((r) => r.id === "kotlin.comments.terse")).toMatchObject({ status: "pending", previousText: "Keep comments to a few lowercase words." });
  expect(next.find((r) => r.id === "kotlin.comments.trailing-period-ratio.high")).toMatchObject({ status: "edited", text: "My own wording." });
  expect(next.find((r) => r.id === "avoid.kotlin.errors.force-unwrap")!.status).toBe("rejected");

  const md = renderStyleMd({ ...p, rules: next }, { threshold: 0.6 });
  expect(md).toContain("## Comments");
  expect(md).toContain("- My own wording.");
  expect(md).not.toContain("changed"); // pending is not served
  expect(md).not.toContain("force-unwrap");
  expect(md).toContain("## Avoid");
});

test("render serves every metric rule but only the top voice rules per section, plus the developer's decisions", () => {
  const p = upsertSource(emptyProfile("me", ["me@x"]), source("/a", () => {}));
  const voice = (i: number, confidence: number, status: "auto" | "approved" = "auto") => ({
    id: `kotlin.comments.v${i}`, scope: "personal" as const, language: "kotlin" as const, category: "comments" as const, text: `Voice rule ${i}.`,
    evidence: { examples: [{ file: "A.kt", line: 1, snippet: "x" }] }, confidence, status,
  });
  const rules = [...baselineRules(p, opts), voice(1, 0.9), voice(2, 0.7), voice(3, 0.8), voice(4, 0.85), voice(5, 0.65, "approved")];
  const md = renderStyleMd({ ...p, rules }, { threshold: 0.6 });
  const comments = md.split("## Comments")[1]!.split("## ")[0]!;
  expect(comments).toContain("Start comments with a capital letter.");
  expect(comments).toContain("When a comment is warranted, it reads like this:");
  expect(comments).toContain("Voice rule 1.");
  expect(comments).toContain("Voice rule 4.");
  expect(comments).toContain("Voice rule 3.");
  expect(comments).not.toContain("Voice rule 2.");
  expect(comments).toContain("Voice rule 5."); // approved rules are always served
  expect(comments.indexOf("capital letter")).toBeLessThan(comments.indexOf("Voice rule 1."));
});

test("a language under 5% of the lines is left out of the full profile but served when asked for", () => {
  const p = upsertSource(emptyProfile("me", ["me@x"]), source("/a", () => {}));
  const py = emptyStats(); py.loc = 300;
  const withPy: Profile = { ...p, stats: { ...p.stats, python: py } };
  const rule = { id: "python.comments.x", scope: "personal" as const, language: "python" as const, category: "comments" as const, text: "Python comments are terse.", evidence: { examples: [{ file: "a.py", line: 1, snippet: "# x" }] }, confidence: 0.9, status: "auto" as const };
  const rules = [...baselineRules(withPy, opts), rule];
  expect(renderStyleMd({ ...withPy, rules }, { threshold: 0.6 })).not.toContain("Python comments are terse.");
  expect(renderStyleMd({ ...withPy, rules }, { threshold: 0.6, language: "python" })).toContain("Python comments are terse.");
});

test("a text shared by some of the served languages is labelled with exactly those", () => {
  const p = upsertSource(emptyProfile("me", ["me@x"]), source("/a", () => {}));
  const st = () => { const x = emptyStats(); x.loc = 5000; return x; };
  const three: Profile = { ...p, stats: { kotlin: st(), typescript: st(), go: st() } };
  const rule = (language: "kotlin" | "typescript" | "go", text: string) => ({
    id: `${language}.comments.${text}`, scope: "personal" as const, language, category: "comments" as const, text,
    evidence: { metric: { name: "m", value: 1, sampleSize: 100 }, examples: [] }, confidence: 0.9, status: "auto" as const,
  });
  const rules = [rule("kotlin", "No doc comments."), rule("typescript", "No doc comments."), rule("go", "Document everything."), ...(["kotlin", "typescript", "go"] as const).map((l) => rule(l, "No emoji."))];
  const md = renderStyleMd({ ...three, rules }, { threshold: 0.6 });
  expect(md).toContain("- Kotlin, TypeScript: No doc comments.");
  expect(md).toContain("- Go: Document everything.");
  expect(md).toContain("- No emoji.");
});

test("a borrowed profile serves voice and layout, labelled, without idiom or project rules, under its own header", () => {
  const src = { ...source("/tivi", () => {}), headDate: "2023-12-30T10:00:00+00:00" };
  const p = upsertSource(emptyProfile("Chris", ["chris@x"]), src);
  const ex = { examples: [{ file: "A.kt", line: 1, snippet: "x" }] };
  const base = { scope: "personal" as const, language: "kotlin" as const, confidence: 0.9, status: "auto" as const };
  const rules = [
    ...baselineRules(p, opts),
    { ...base, id: "kotlin.naming.lookups", category: "naming" as const, kind: "voice" as const, text: "Name lookups as noun phrases.", evidence: ex },
    { ...base, id: "kotlin.structure.indent", category: "structure" as const, kind: "layout" as const, text: "Indent with two spaces.", evidence: ex },
    { ...base, id: "kotlin.errors.elvis", category: "errors" as const, kind: "idiom" as const, text: "Resolve nullables with elvis.", evidence: ex },
    { ...base, id: "kotlin.structure.old", category: "structure" as const, text: "Untagged structure rule.", evidence: ex },
    { ...base, id: "kotlin.errors.kept", category: "errors" as const, kind: "idiom" as const, status: "approved" as const, text: "Approved idiom rule.", evidence: ex },
    { ...base, id: "kotlin.comments.header", category: "comments" as const, kind: "voice" as const, repo: "/tivi", text: "Start every file with the Tivi header.", evidence: ex },
  ];
  const own = renderStyleMd({ ...p, rules }, { threshold: 0.6, repo: "/tivi" });
  expect(own).toContain("# Code style: Chris\n");
  expect(own).toContain("Resolve nullables with elvis.");
  expect(own).toContain("Start every file with the Tivi header.");
  expect(own).toContain("- Use when instead of if/else chains");

  const md = renderStyleMd({ ...p, rules, borrowed: ["voice", "layout"] }, { threshold: 0.6, repo: "/tivi" });
  expect(md).toContain("# Code style: borrowed from Chris");
  expect(md).toContain("written up to December 2023");
  expect(md).toContain("It shapes naming, comments, commit messages and layout.");
  expect(md).toContain("its formatter and current language practice win");
  expect(md).toContain("- Kotlin: Name lookups as noun phrases.");
  expect(md).toContain("- Kotlin: Indent with two spaces.");
  expect(md).toContain("- Kotlin: Approved idiom rule.");
  expect(md).toContain("- Kotlin: Keep functions short.");
  expect(md).toContain("- Kotlin: No emoji in comments.");
  for (const gone of ["Resolve nullables with elvis.", "Untagged structure rule.", "Tivi header", "Use when instead", "runCatching"]) expect(md).not.toContain(gone);
  expect(renderStyleMd({ ...p, rules, borrowed: ["voice"] }, { threshold: 0.6 })).not.toContain("Indent with two spaces.");
  expect(isServed(rules.find((r) => r.id === "kotlin.errors.elvis")!, 0.6)).toBe(true);
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

test("a ratio habit that one file in six does the opposite way gets half confidence and says so", async () => {
  const stats = emptyStats();
  stats.comments.line = 160; stats.comments.doc = 40; // 20% doc comments overall, a "low" rule
  const base = { ...emptyProfile("me", ["me@x"]), stats: { kotlin: stats } as Profile["stats"] };
  const plain = baselineRules({ ...base, sources: [] }, { minSampleSize: 20 }).find((r) => r.id === "kotlin.comments.doc-ratio.low")!;
  const src = { repo: "/r", head: "h", scannedAt: "t", commits: 1, linesOwned: 1, stats: { kotlin: stats }, commitStats: analyzeCommits([]) };
  const split = baselineRules({ ...base, sources: [{ ...src, spread: { kotlin: { "comments.doc-ratio": { under: 6, over: 2 } } } }] }, { minSampleSize: 20 }).find((r) => r.id === "kotlin.comments.doc-ratio.low")!;
  expect(split.confidence).toBeCloseTo(plain.confidence / 2, 1);
  expect(split.text).toContain("Varies by file: 2 of 8 files");
  // one of nine is under the line
  const fine = baselineRules({ ...base, sources: [{ ...src, spread: { kotlin: { "comments.doc-ratio": { under: 8, over: 1 } } } }] }, { minSampleSize: 20 }).find((r) => r.id === "kotlin.comments.doc-ratio.low")!;
  expect(fine.confidence).toBe(plain.confidence);
});
