import { expect, test } from "vitest";
import { analyzeCommits, emptyStats } from "./analyzer.js";
import { emptyProfile, updateRules, upsertSource, type Rule, type Source } from "./profile.js";

const src = (repo: string, fns: number, commits: number): Source => {
  const stats = emptyStats();
  stats.functions.count = fns;
  const cs = analyzeCommits([]);
  cs.count = commits;
  return { repo, head: "h", scannedAt: "t", commits, linesOwned: 1, stats: { kotlin: stats }, commitStats: cs };
};

test("upsertSource replaces same repo and re-merges", () => {
  let p = emptyProfile("me", ["me@x.com"]);
  p = upsertSource(p, src("/a", 10, 5));
  p = upsertSource(p, src("/b", 7, 2));
  expect(p.stats.kotlin!.functions.count).toBe(17);
  expect(p.commitStats.count).toBe(7);
  p = upsertSource(p, src("/a", 1, 1));
  expect(p.sources.map((s) => s.repo)).toEqual(["/b", "/a"]);
  expect(p.stats.kotlin!.functions.count).toBe(8);
  expect(p.commitStats.count).toBe(3);
});

test("updateRules sets decisions, edit replaces text, unknown ids throw", () => {
  const rule: Rule = { id: "a", scope: "personal", language: "any", category: "comments", text: "old", evidence: { examples: [] }, confidence: 1, status: "auto" };
  let p = { ...emptyProfile("me", ["me@x.com"]), rules: [rule, { ...rule, id: "b" }] };
  p = updateRules(p, ["a"], "rejected");
  p = updateRules(p, ["b"], "edited", " new text ");
  expect(p.rules.map((r) => [r.status, r.text])).toEqual([["rejected", "old"], ["edited", "new text"]]);
  expect(() => updateRules(p, ["zzz"], "approved")).toThrow(/no rule zzz/);
  expect(() => updateRules(p, ["a"], "edited", " ")).toThrow(/needs the new rule text/);
});
