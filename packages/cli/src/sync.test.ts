import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { END, START, syncBlock, syncTargets } from "./sync.js";

test("syncBlock appends once, replaces in place and leaves the rest untouched", () => {
  const user = "# My project\n\nDo not touch this.\n";
  const first = syncBlock(user, "- rule one", "CLAUDE.md");
  expect(first.startsWith(user)).toBe(true);
  expect(first).toContain(`${START}\n`);
  expect(first.trim().endsWith(END)).toBe(true);
  expect(syncBlock(first, "- rule one", "CLAUDE.md")).toBe(first);
  const second = syncBlock(`${first}\nTrailing user text.\n`, "- rule two", "CLAUDE.md");
  expect(second).toContain("- rule two");
  expect(second).not.toContain("- rule one");
  expect(second.startsWith(user)).toBe(true);
  expect(second.endsWith("Trailing user text.\n")).toBe(true);
  expect(syncBlock(undefined, "- r", "x.mdc").startsWith("---\n")).toBe(true);
});

test("syncTargets creates only AGENTS.md by default and updates files that exist", async () => {
  const repo = await mkdtemp(join(tmpdir(), "idiolect-sync-"));
  await writeFile(join(repo, "CLAUDE.md"), "# Mine\n");
  const first = await syncTargets(repo, "- rule");
  expect(first).toEqual([
    { file: "AGENTS.md", status: "created" }, { file: "CLAUDE.md", status: "updated" },
    { file: ".cursor/rules/idiolect.mdc", status: "skipped" }, { file: ".github/copilot-instructions.md", status: "skipped" },
    { file: "GEMINI.md", status: "skipped" },
  ]);
  expect(await readFile(join(repo, "CLAUDE.md"), "utf8")).toMatch(/^# Mine\n\n<!-- idiolect:start -->/);
  expect((await syncTargets(repo, "- rule")).map((r) => r.status)).toEqual(["unchanged", "unchanged", "skipped", "skipped", "skipped"]);
  expect(await syncTargets(repo, "- rule", [".cursor/rules/idiolect.mdc"])).toEqual([{ file: ".cursor/rules/idiolect.mdc", status: "created" }]);
});

test("a caller can name more files to create, the rest are still only updated", async () => {
  const repo = await mkdtemp(join(tmpdir(), "idiolect-sync-"));
  const results = await syncTargets(repo, "body", undefined, new Set(["AGENTS.md", "CLAUDE.md"]));
  expect(results.filter((r) => r.status === "created").map((r) => r.file)).toEqual(["AGENTS.md", "CLAUDE.md"]);
  expect(results.filter((r) => r.status === "skipped").map((r) => r.file)).toEqual([".cursor/rules/idiolect.mdc", ".github/copilot-instructions.md", "GEMINI.md"]);
});
