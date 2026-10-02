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

test("parses TypeScript and TSX fixtures without errors", async () => {
  const ts = fileURLToPath(new URL("../../../fixtures/typescript/Sample.ts", import.meta.url));
  const tree = await parse(readFileSync(ts, "utf8"), "typescript");
  expect(tree.rootNode.hasError).toBe(false);
  const tsx = await parse("export const App = () => <div className=\"a\">{1}</div>;\n", "tsx");
  expect(tsx.rootNode.hasError).toBe(false);
});

test("parses Python and Go fixtures without errors", async () => {
  for (const [lang, file] of [["python", "python/sample.py"], ["go", "go/sample.go"]] as const) {
    const tree = await parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/${file}`, import.meta.url)), "utf8"), lang);
    expect(tree.rootNode.hasError).toBe(false);
  }
});
