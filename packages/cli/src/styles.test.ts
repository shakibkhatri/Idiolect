import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { listStyles } from "@shakibkhatri/idiolect-core";
import { filesToCreate, menuOrder, parsePick, relevantLanguages, renderList } from "./styles.js";

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
  expect(list).toMatch(/^Kotlin\n  kotlin-quiet\s+\S/);
  expect(renderList(menuOrder(await listStyles()), { numbered: true, hidden: 2 })).toMatch(/^Kotlin\n   1  kotlin-quiet[\s\S]*\n2 more for other languages: type all to see them/);
  expect(list).not.toContain("github.com");
  expect(list).toContain("(experimental)");
  for (const line of list.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
});

test("only languages with a real share of the project are offered, the biggest always", () => {
  expect(relevantLanguages({ kotlin: 794, typescript: 56, python: 6 })).toEqual(["kotlin", "typescript"]);
  expect(relevantLanguages({ go: 1 })).toEqual(["go"]);
  expect(relevantLanguages({})).toEqual([]);
});

test("a pick is read as menu numbers, one style per language", async () => {
  const menu = menuOrder(await listStyles());
  expect(parsePick("1, 2", menu).map((s) => s.id)).toEqual([menu[0]!.id, menu[1]!.id]);
  expect(() => parsePick("9", menu)).toThrow(/9 is not one of 1 to 4/);
  expect(() => parsePick("kotlin-quiet", menu)).toThrow(/not one of/);
  expect(() => parsePick("--all", [menu[0]!])).toThrow("--all is not 1, the only style listed");
  const two = [menu[0]!, { ...menu[0]!, id: "kotlin-other" }];
  expect(() => parsePick("1 2", two)).toThrow(/pick one Kotlin style/);
});
