import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION } from "web-tree-sitter";
import { expect, test } from "vitest";
import { parse } from "./parser.js";

const fixture = fileURLToPath(new URL("../../../fixtures/kotlin/Sample.kt", import.meta.url));

test("parses Kotlin fixture without errors", async () => {
  const tree = await parse(readFileSync(fixture, "utf8"), "kotlin");
  const grammarAbi = tree.language.abiVersion;
  console.log(`web-tree-sitter ABI ${LANGUAGE_VERSION} (min ${MIN_COMPATIBLE_VERSION}), kotlin grammar ABI ${grammarAbi}`);
  expect(tree.rootNode.hasError).toBe(false);
  const types = new Set<string>();
  const cursor = tree.walk();
  const visit = (): void => {
    types.add(cursor.nodeType);
    if (cursor.gotoFirstChild()) {
      do visit(); while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };
  visit();
  expect(types).toContain("function_declaration");
  expect(types).toContain("when_expression");
  expect(types).toContain("line_comment");
});
