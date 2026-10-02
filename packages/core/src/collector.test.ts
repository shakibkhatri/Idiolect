import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import { collect, detectEmail } from "./collector.js";

const A = "alice@example.com";
const B = "bob@example.com";
let repo: string;

function commit(email: string, msg: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: email, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: email, GIT_COMMITTER_EMAIL: email };
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", msg], { cwd: repo, env });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "idiolect-fixture-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", A], { cwd: repo });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
  commit(A, "add repo", {
    "src/Repo.kt": "class Repo {\n    fun one() = 1\n    fun two() = 2\n}\n",
    "build/Gen.kt": "class Gen\n",
    "src/Ignored.kt": "class Ignored\n",
    "src/Auto.kt": "// AUTO-GENERATED, do not edit\nclass Auto\n",
    ".idiolectignore": "src/Ignored.kt\n",
  });
  commit(B, "bob edits two", { "src/Repo.kt": "class Repo {\n    fun one() = 1\n    fun two() = 22\n}\n" });
  commit(B, "bob adds util", { "src/Util.kt": "fun util() = Unit\n" });
  commit(A, "alice reformats", { "src/Repo.kt": "class Repo {\n    fun one() = 1\n    fun two() =  22\n}\n" });
});

test("returns only author A's lines, commits, and respects ignores", async () => {
  const c = await collect({ repo, emails: [A] });
  expect(c.files.map((f) => f.path)).toEqual(["src/Repo.kt"]);
  // bob owns line 3; alice's whitespace-only edit must not reclaim it
  expect(c.files[0]!.ranges).toEqual([{ start: 1, end: 2 }, { start: 4, end: 4 }]);
  expect(c.files[0]!.ownedLines).toBe(3);
  expect(c.commits.map((m) => m.subject)).toEqual(["alice reformats", "add repo"]);
  expect(existsSync(join(repo, ".idiolect/cache/collector.json"))).toBe(true);
  expect(existsSync(join(repo, ".idiolect/cache/.gitignore"))).toBe(true);
  // files owned entirely by others are cached too, so they are not re-blamed every run
  const cache = JSON.parse(readFileSync(join(repo, ".idiolect/cache/collector.json"), "utf8"));
  expect(Object.keys(cache.files).sort()).toEqual(["src/Auto.kt", "src/Repo.kt", "src/Util.kt"]);
});

test("lines and messages from commits with an agent trailer are not the developer's", async () => {
  await collect({ repo, emails: [A] });
  commit(A, "agent adds four\n\nCo-Authored-By: Claude <noreply@anthropic.com>", { "src/Agent.kt": "fun four() = 4\n" });
  const c = await collect({ repo, emails: [A] });
  expect(c.agentCommits).toBe(1);
  expect(c.files.map((f) => f.path)).not.toContain("src/Agent.kt");
  expect(c.commits.map((m) => m.subject)).not.toContain("agent adds four");
});

test("incremental rescan picks up new commits and changed files", async () => {
  await collect({ repo, emails: [A] });
  commit(A, "alice adds three", { "src/Repo.kt": "class Repo {\n    fun one() = 1\n    fun two() =  22\n    fun three() = 3\n}\n" });
  commit(B, "bob adds more", { "src/More.kt": "fun more() = Unit\n" });
  const c = await collect({ repo, emails: [A] });
  expect(c.files[0]!.ownedLines).toBe(4);
  expect(c.commits.map((m) => m.subject)).toEqual(["alice adds three", "alice reformats", "add repo"]);
});

test("detects email from git config", async () => {
  expect(await detectEmail(repo)).toBe(A);
});

test("a cache written for other emails is discarded, so adding an email changes ownership on the next scan", async () => {
  await collect({ repo, emails: [A] });
  const both = await collect({ repo, emails: [A, B] });
  expect(both.files.map((f) => f.path)).toContain("src/Util.kt");
  expect(both.files.find((f) => f.path === "src/Repo.kt")!.ownedLines).toBe(5);
  expect(both.commits.map((m) => m.subject)).toContain("bob adds util");
  const cache = JSON.parse(readFileSync(join(repo, ".idiolect/cache/collector.json"), "utf8"));
  expect(cache.emails).toEqual([A, B]);
});
