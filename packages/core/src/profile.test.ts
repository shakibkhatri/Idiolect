import { expect, test } from "vitest";
import { analyzeCommits, emptyStats } from "./analyzer.js";
import { emptyProfile, upsertSource, type Source } from "./profile.js";

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
