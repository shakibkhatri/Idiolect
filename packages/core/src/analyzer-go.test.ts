import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { isTestPath } from "./analyzer.js";
import { analyzeGo } from "./analyzer-go.js";
import { metric } from "./metrics.js";

const fixture = readFileSync(fileURLToPath(new URL("../../../fixtures/go/sample.go", import.meta.url)), "utf8");

test("Go analyzer counts functions, names, doc comments, errors and idioms with known values", async () => {
  const s = await analyzeGo(fixture);
  // GetUser, isCached, evict, Describe, toSlug, firstLine, mustUser
  expect(s.functions.count).toBe(7);
  expect(s.functions.blockBody).toBe(7);
  expect(s.functions.earlyReturn).toBe(2); // GetUser guards, Describe switch
  expect(s.functions.params).toEqual({ 1: 6, 2: 1 });
  expect(s.go).toEqual({ errChecks: 1, namedReturns: 1, structs: 2, interfaces: 1, panics: 1 });
  expect(s.errors.forceUnwrap).toBe(1);
  expect(s.naming.casing.function).toMatchObject({ pascal: 2, camel: 5 });
  expect(s.naming.casing.constant).toEqual({ camel: 1, pascal: 1, snake: 0, screaming: 0, backtick: 0, other: 0 });
  expect(s.naming.casing.class.pascal).toBe(3);
  expect(s.naming.booleanPrefix).toEqual({ is: 2 });
  expect(s.comments.line).toBe(2); // the IsOnline field comment and the one inside GetUser
  expect(s.comments.doc).toBe(6); // package, User, Fetcher, UserRepository, GetUser, Describe
  // top level: MaxRetries, cacheTTLMs, User, Fetcher, UserRepository, GetUser, isCached, evict, Describe, toSlug, firstLine, mustUser
  expect(s.comments.publicDecls).toBe(6);
  expect(s.comments.publicDocumented).toBe(5); // all exported but MaxRetries
  expect(s.comments.privateDecls).toBe(6);
  expect(s.comments.privateDocumented).toBe(0);
  expect(metric("go.named-return-ratio", s).value).toBeCloseTo(1 / 7);
  expect(isTestPath("pkg/users_test.go")).toBe(true);
  expect(isTestPath("pkg/users.go")).toBe(false);
});
