import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { analyzeCommits, analyzeKotlin, casing, emptyStats, isTestPath, mergeStats } from "./analyzer.js";

const fixture = readFileSync(fileURLToPath(new URL("../../../fixtures/kotlin/Sample.kt", import.meta.url)), "utf8");

test("fixture: functions, naming, comments, errors, kotlin idioms", async () => {
  const s = await analyzeKotlin(fixture);
  expect(s.files).toBe(1);
  expect(s.functions).toMatchObject({ count: 4, blockBody: 1, expressionBody: 3, params: { "0": 1, "1": 3 }, lengthLines: { "6": 1 }, earlyReturn: 0 });
  expect(s.naming.casing.function).toMatchObject({ camel: 4, pascal: 0 });
  expect(s.naming.casing.class).toMatchObject({ pascal: 5 });
  expect(s.naming.functionVerb).toEqual({ get: 1, is: 1, describe: 1, to: 1 });
  expect(s.naming.booleanPrefix).toEqual({ is: 1 });
  expect(s.comments).toMatchObject({ line: 1, block: 0, doc: 0, lowercaseStart: 1, trailingPeriod: 0, publicDecls: 9, privateDecls: 1, publicDocumented: 0 });
  expect(s.errors).toEqual({ tryCatch: 0, runCatching: 1, resultType: 0, forceUnwrap: 0 });
  expect(s.kotlin).toMatchObject({ when3: 1, ifElseChain3: 0, sealedInterface: 1, sealedClass: 0, extensionFunctions: 1, dataClasses: 2 });
});

test("snippet: nesting, early return, chains, errors, compose, docs, todo", async () => {
  const s = await analyzeKotlin(`
/** Public doc. */
fun a(x: Int?): Int {
    if (x == null) return 0
    val y = x!!
    val z = if (y == 1) 1 else if (y == 2) 2 else 3
    try { for (i in 0..z) { if (i > 1) println(i) } } catch (e: Exception) { }
    // TODO(me): clean up
    // FIXME use Result
    return y
}
private fun b(): Result<Int> = runCatching { 1 }
@Composable fun Card(title: String, modifier: Modifier = Modifier) { val s = remember { 1 } }
@Composable fun Row(modifier: Modifier = Modifier) {}
object K {
    const val MAX_SIZE = 1
    val snake_name = 2
}
`);
  expect(s.functions).toMatchObject({ count: 4, blockBody: 3, expressionBody: 1, earlyReturn: 1, maxNesting: { "3": 1, "1": 1, "0": 1 } });
  expect(s.kotlin).toMatchObject({ ifElseChain3: 1, composables: 2, modifierParamFirst: 1, modifierParamLater: 1, remember: 1 });
  expect(s.errors).toEqual({ tryCatch: 1, runCatching: 1, resultType: 1, forceUnwrap: 1 });
  expect(s.comments).toMatchObject({ doc: 1, line: 2, publicDocumented: 1, privateDecls: 1, privateDocumented: 0, todo: { "TODO(x):": 1, FIXME: 1 } });
  expect(s.naming.casing.constant).toMatchObject({ screaming: 1 });
  expect(s.naming.casing.property).toMatchObject({ snake: 1 });
  expect(s.naming.casing.local).toMatchObject({ camel: 3 });
  expect(s.naming.casing.parameter.camel).toBe(4);
});

test("backtick test names stay out of verb, boolean and abbreviation stats", async () => {
  const s = await analyzeKotlin("fun `a usr can log in`(): Boolean = true\nfun isOk(): Boolean = true\n");
  expect(s.naming.casing.function).toMatchObject({ backtick: 1, camel: 1 });
  expect(s.naming.functionVerb).toEqual({ is: 1 });
  expect(s.naming.booleanPrefix).toEqual({ is: 1 });
  expect(s.naming.abbreviated).toBe(0);
});

test("test files route names to testNames and keep verbs clean", async () => {
  const s = await analyzeKotlin("fun aDeviceThatCannotLoadIsSkipped() {}\nfun `shows error`() {}\nfun setUp() {}\n", undefined, { test: true });
  expect(s.tests).toEqual({ files: 1, loc: 3, functions: 3 });
  expect(s.naming.testNames).toEqual({ camelSentence: 1, backtick: 1, camel: 1 });
  expect(s.naming.functionVerb).toEqual({});
  expect(s.naming.casing.function.camel).toBe(0);
  expect(["src/test/kotlin/A.kt", "app/src/androidTest/B.kt", "FooTest.kt", "src/main/Foo.kt", "contest/Foo.kt"].map(isTestPath)).toEqual([true, true, true, false, false]);
});

test("owned ranges restrict what is counted", async () => {
  const code = "fun a() = 1\nfun b() = 2\n// mine\n";
  const s = await analyzeKotlin(code, [{ start: 2, end: 3 }]);
  expect(s.functions.count).toBe(1);
  expect(s.comments.line).toBe(1);
  expect(s.loc).toBe(2);
});

test("mergeStats sums every leaf and keeps shape", async () => {
  const a = await analyzeKotlin(fixture);
  const m = mergeStats(a, a);
  expect(m.functions.count).toBe(8);
  expect(m.functions.params).toEqual({ "0": 2, "1": 6 });
  expect(m.naming.casing.class.pascal).toBe(10);
  expect(mergeStats(emptyStats(), a)).toEqual(a);
});

test("casing", () => {
  expect(["getUser", "UserRepo", "MAX_SIZE", "snake_case", "_backing", "HTML", "x", "`shows error`"].map(casing))
    .toEqual(["camel", "pascal", "screaming", "snake", "camel", "screaming", "camel", "backtick"]);
});

test("commit stats", () => {
  const mk = (subject: string, body = "") => ({ hash: "h", email: "e", date: "d", subject, body });
  const s = analyzeCommits([mk("add login screen", "details"), mk("feat(ui): Added button"), mk("Fixes crash."), mk("refactor repository")]);
  expect(s).toMatchObject({ count: 4, lowercaseStart: 2, conventionalPrefix: 1, trailingPeriod: 1, withBody: 1, tense: { imperative: 2, past: 1, thirdPerson: 1 } });
});
