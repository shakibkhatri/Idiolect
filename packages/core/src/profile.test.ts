import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyzeCommits, emptyStats } from "./analyzer.js";
import { emptyProfile, loadServedProfile, saveProfile, updateRules, upsertSource, type Rule, type Source } from "./profile.js";

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

test("a repo serves the profile its config names, otherwise the developer's own", async () => {
  const home = await mkdtemp(join(tmpdir(), "idiolect-home-"));
  const repo = await mkdtemp(join(tmpdir(), "idiolect-repo-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await mkdir(join(home, ".idiolect"), { recursive: true });
    await writeFile(join(home, ".idiolect", "config.json"), JSON.stringify({ emails: ["me@x.com"] }));
    await saveProfile(emptyProfile("me", ["me@x.com"]));
    await saveProfile(emptyProfile("someone else", ["other@x.com"]));
    expect((await loadServedProfile(repo))!.developer.name).toBe("me");

    await mkdir(join(repo, ".idiolect"), { recursive: true });
    await writeFile(join(repo, ".idiolect", "config.json"), JSON.stringify({ profile: "other@x.com" }));
    const borrowed = (await loadServedProfile(repo))!;
    expect(borrowed.developer.name).toBe("someone else");
    expect(borrowed.borrowed).toEqual(["voice", "layout"]);
    expect((await loadServedProfile())!.developer.name).toBe("me");

    // the marker is for serving only, a rule decision must not write it into the stored profile
    await saveProfile(borrowed);
    expect(await readFile(join(home, ".idiolect", "profiles", "other@x.com.json"), "utf8")).not.toContain("borrowed");

    // naming your own email is not borrowing
    await writeFile(join(repo, ".idiolect", "config.json"), JSON.stringify({ profile: "ME@x.com" }));
    expect((await loadServedProfile(repo))!.borrowed).toBeUndefined();

    await writeFile(join(repo, ".idiolect", "config.json"), JSON.stringify({ profile: "nobody@x.com" }));
    await expect(loadServedProfile(repo)).rejects.toThrow(/no profile .*nobody@x.com/);
  } finally {
    process.env.HOME = realHome;
  }
});
