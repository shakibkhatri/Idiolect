import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyzeCommits, emptyStats } from "./analyzer.js";
import { emptyProfile, saveProfile, type Profile, type Rule } from "./profile.js";
import { renderStyleMd } from "./render.js";
import { loadServedProfile, saveOverrides } from "./served.js";
import { buildStyle, composeStyles, listStyles } from "./styles.js";

const rule = (r: Partial<Rule> & { id: string; text: string }): Rule => ({
  scope: "personal", language: "kotlin", category: "comments", confidence: 0.9, status: "auto", evidence: { examples: [{ file: "A.kt", line: 3, snippet: "val secret = 1" }] }, ...r,
});
const metric = { metric: { name: "comments.trailing-period-ratio", value: 0.02, sampleSize: 500 }, examples: [] };

function scanned(): Profile {
  const stats = emptyStats(); stats.loc = 4000;
  return {
    ...emptyProfile("Someone", ["someone@example.com"]),
    sources: [{ repo: "/tmp/repo", head: "abc123", headDate: "2023-12-30T10:00:00Z", scannedAt: "t", commits: 10, linesOwned: 4000, stats: { kotlin: stats }, commitStats: analyzeCommits([]) }],
    stats: { kotlin: stats },
    rules: [
      rule({ id: "kotlin.comments.period", text: "No trailing period on comments.", evidence: metric }),
      rule({ id: "kotlin.comments.approved", text: "Approved voice rule.", status: "approved", kind: "voice" }),
      rule({ id: "kotlin.comments.edited", text: "Edited voice rule.", status: "edited", kind: "voice" }),
      rule({ id: "kotlin.comments.unreviewed", text: "Nobody looked at this one." }),
      rule({ id: "kotlin.comments.rejected", text: "Rejected rule.", status: "rejected" }),
      rule({ id: "kotlin.comments.header", text: "Project header rule.", status: "approved", repo: "/tmp/repo" }),
      rule({ id: "typescript.comments.other", text: "Another language.", status: "approved", language: "typescript" }),
      rule({ id: "any.commits.tidy", text: "Call cleanups Tidy up.", status: "approved", language: "any", category: "commits" }),
    ],
  };
}
const build = (id: string, language: "kotlin" | "typescript", p = scanned()) => buildStyle(p, { id, title: id, language, project: `github.com/x/${id}`, license: "MIT" });

test("a built style holds measured rules and reviewed voice rules, without emails, code or project rules", () => {
  const style = build("kotlin-x", "kotlin");
  expect(style.rules.map((r) => r.id)).toEqual(["kotlin.comments.period", "kotlin.comments.approved", "kotlin.comments.edited", "any.commits.tidy"]);
  expect(style.rules.every((r) => r.status === "auto" && r.kind)).toBe(true);
  expect(style.source).toMatchObject({ commit: "abc123", snapshot: "2023-12-30T10:00:00Z", lines: 4000 });
  const json = JSON.stringify(style);
  expect(json).not.toContain("someone@example.com");
  expect(json).not.toContain("val secret");
  expect(json).not.toContain("/tmp/repo");
  expect(() => build("go-x", "go" as never)).toThrow(/no go code/);
});

test("composed styles serve each language from its own style and commit rules from one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "idiolect-styles-"));
  const ts = scanned();
  ts.stats = { typescript: ts.stats.kotlin! };
  ts.rules = [rule({ id: "typescript.comments.terse", text: "Terse TypeScript comments.", status: "approved", language: "typescript" }), rule({ id: "any.commits.lower", text: "Lowercase subjects.", status: "approved", language: "any", category: "commits" })];
  await writeFile(join(dir, "kotlin-x.json"), JSON.stringify(build("kotlin-x", "kotlin")));
  await writeFile(join(dir, "typescript-y.json"), JSON.stringify(build("typescript-y", "typescript", ts)));

  const p = await composeStyles({ kotlin: "kotlin-x", typescript: "typescript-y", commits: "typescript-y" }, dir);
  expect(p.rules.map((r) => r.id).sort()).toEqual(["any.commits.lower", "kotlin.comments.approved", "kotlin.comments.edited", "kotlin.comments.period", "typescript.comments.terse"]);
  expect(p.shipped).toBe(true);
  expect(p.provenance).toContain("Kotlin from kotlin-x (github.com/x/kotlin-x, code up to December 2023)");
  expect(p.provenance).toContain("commit messages from typescript-y");
  const md = renderStyleMd({ ...p, borrowed: ["voice", "layout"] }, { threshold: 0.6 });
  expect(md).toContain("# Code style: borrowed from kotlin-x, typescript-y");
  expect(md).toContain("- TypeScript: Terse TypeScript comments.");
  expect(md).toContain("- Lowercase subjects.");
  expect(md).not.toContain("Call cleanups Tidy up.");

  expect((await composeStyles({ kotlin: "kotlin-x" }, dir)).rules.map((r) => r.id)).toContain("any.commits.tidy");
  await expect(composeStyles({ kotlin: "typescript-y" }, dir)).rejects.toThrow(/is a typescript style, not kotlin/);
  await expect(composeStyles({ kotlin: "nope" }, dir)).rejects.toThrow(/no style nope/);
});

test("a repo that picked shipped styles needs no personal profile, and its decisions stay in the repo", async () => {
  const home = await mkdtemp(join(tmpdir(), "idiolect-home-"));
  const repo = await mkdtemp(join(tmpdir(), "idiolect-repo-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    expect(await loadServedProfile(repo)).toBeUndefined();
    const shipped = (await listStyles())[0]!;
    await mkdir(join(repo, ".idiolect"), { recursive: true });
    await writeFile(join(repo, ".idiolect", "config.json"), JSON.stringify({ styles: { [shipped.language]: shipped.id } }));
    const served = (await loadServedProfile(repo))!;
    expect(served.shipped).toBe(true);
    expect(served.borrowed).toEqual(["voice", "layout"]);
    await expect(saveProfile(served)).rejects.toThrow(/read-only/);

    const [first, second] = served.rules;
    await saveOverrides(repo, { ...served, rules: served.rules.map((r) => (r.id === first!.id ? { ...r, status: "rejected" } : r.id === second!.id ? { ...r, status: "edited", text: "My wording." } : r)) });
    const again = (await loadServedProfile(repo))!;
    expect(again.rules.find((r) => r.id === first!.id)!.status).toBe("rejected");
    expect(again.rules.find((r) => r.id === second!.id)).toMatchObject({ status: "edited", text: "My wording." });
  } finally {
    process.env.HOME = realHome;
  }
});

test("every shipped style is free of emails, code snippets and project rules", async () => {
  const styles = await listStyles();
  expect(styles.length).toBeGreaterThan(0);
  for (const s of styles) {
    expect(JSON.stringify(s)).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    for (const r of s.rules) {
      expect(r.repo).toBeUndefined();
      expect(r.evidence.examples.every((e) => e.snippet === "")).toBe(true);
      expect(r.language === s.language || r.language === "any").toBe(true);
    }
  }
});
