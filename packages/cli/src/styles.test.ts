import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { listStyles } from "@shakibkhatri/idiolect-core";
import { filesToCreate, renderList } from "./styles.js";

test("use creates an agent's own file only when that agent is in use", async () => {
  const repo = await mkdtemp(join(tmpdir(), "idiolect-use-"));
  expect([...(await filesToCreate(repo, false))]).toEqual(["AGENTS.md"]);
  expect([...(await filesToCreate(repo, true))]).toEqual(["AGENTS.md", "CLAUDE.md"]);
  await mkdir(join(repo, ".claude"));
  await mkdir(join(repo, ".cursor"));
  expect([...(await filesToCreate(repo, false))]).toEqual(["AGENTS.md", "CLAUDE.md", ".cursor/rules/idiolect.mdc"]);
});

test("the list is one short line per shipped style, grouped by language, without the source repo", async () => {
  const list = renderList(await listStyles());
  expect(list).toMatch(/^Kotlin\n  kotlin-tivi\s+\S/);
  expect(list).not.toContain("github.com");
  expect(list).toContain("(experimental)");
  for (const line of list.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
});
