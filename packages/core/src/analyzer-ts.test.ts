import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { isTestPath, languageOf } from "./analyzer.js";
import { analyzeTypeScript } from "./analyzer-ts.js";
import { analyze } from "./languages.js";
import { metric } from "./metrics.js";

const fixture = readFileSync(fileURLToPath(new URL("../../../fixtures/typescript/Sample.ts", import.meta.url)), "utf8");

test("TypeScript analyzer counts functions, names, comments, errors and idioms with known values", async () => {
  const s = await analyzeTypeScript(fixture);
  // getUser, isCached, evict, constructor, describe, toSlug, firstLine, readConfig
  expect(s.functions.count).toBe(8);
  expect(s.functions.expressionBody).toBe(1);
  expect(s.functions.blockBody).toBe(7);
  expect(s.functions.earlyReturn).toBe(2); // getUser guard and the returns inside the switch of describe
  expect(s.functions.params).toEqual({ 1: 8 });
  expect(s.typescript).toEqual({ arrowFunctions: 2, functionDeclarations: 2, typeAliases: 2, interfaces: 1, optionalChains: 1, anyTypes: 0 });
  expect(s.errors).toEqual({ tryCatch: 1, runCatching: 0, resultType: 0, forceUnwrap: 1 });
  expect(s.naming.casing.constant).toEqual({ camel: 1, pascal: 0, snake: 0, screaming: 1, backtick: 0, other: 0 });
  expect(s.naming.casing.class.pascal).toBe(4);
  expect(s.naming.booleanPrefix).toEqual({ is: 2 });
  expect(s.naming.functionVerb).toEqual({ get: 1, is: 1, evict: 1, describe: 1, to: 1, first: 1, read: 1 });
  expect(s.comments).toMatchObject({ line: 1, doc: 1, block: 0, lowercaseStart: 1 });
  // module level: LoadState, UserApi, UserRepository, describe, toSlug, readConfig exported, MAX_RETRIES, cacheTtlMs, firstLine, User private
  expect(s.comments.publicDecls).toBe(6 + 4); // plus isOnline, constructor, getUser, isCached
  expect(s.comments.publicDocumented).toBe(1);
  expect(s.comments.privateDecls).toBe(4 + 1 + 1);
  expect(metric("typescript.arrow-ratio", s).value).toBe(0.5);
  expect(await analyze(fixture, "typescript", undefined, { path: "a.ts" })).toEqual(s);
});

test("languageOf and isTestPath know TypeScript", () => {
  expect(languageOf("functions/src/a.ts")).toBe("typescript");
  expect(languageOf("web/App.tsx")).toBe("typescript");
  expect(languageOf("types/global.d.ts")).toBeUndefined();
  expect(languageOf("App.kt")).toBe("kotlin");
  expect(languageOf("README.md")).toBeUndefined();
  expect(isTestPath("functions/src/battles/outcome.test.ts")).toBe(true);
  expect(isTestPath("functions/test/helpers.ts")).toBe(true);
  expect(isTestPath("functions/src/battles/outcome.ts")).toBe(false);
});

test("TypeScript test files count it() and test() calls as test functions named by their string", async () => {
  const code = `import { it, test, describe } from "vitest";\ndescribe("users", () => {\n  it("should load a user", () => {});\n  it("rejects an unknown id", () => {});\n  test(\`caches \${1} user\`, () => {});\n  function helper() { return 1; }\n});\n`;
  const s = await analyzeTypeScript(code, undefined, { test: true });
  expect(s.tests.functions).toBe(4); // three cases and the helper
  expect(s.naming.testNames).toEqual({ should: 1, sentence: 2, camel: 1 });
  expect(metric("naming.test-should-ratio", s).value).toBeCloseTo(1 / 3);
  const prod = await analyzeTypeScript(code);
  expect(prod.tests.functions).toBe(0);
});
