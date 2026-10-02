import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { isTestPath } from "./analyzer.js";
import { analyzePython } from "./analyzer-py.js";
import { metric } from "./metrics.js";

const fixture = readFileSync(fileURLToPath(new URL("../../../fixtures/python/sample.py", import.meta.url)), "utf8");

test("Python analyzer counts functions, names, docstrings, errors and idioms with known values", async () => {
  const s = await analyzePython(fixture);
  // __init__, get_user, is_cached, _evict, describe, to_slug, _first_line, active_names
  expect(s.functions.count).toBe(8);
  expect(s.functions.blockBody).toBe(8);
  expect(s.functions.expressionBody).toBe(0);
  expect(s.functions.earlyReturn).toBe(3); // get_user guards, describe branches, the return inside try in active_names
  expect(s.functions.params).toEqual({ 1: 8 }); // self is not a parameter
  expect(s.python).toEqual({ typeHinted: 4, fStrings: 1, formatCalls: 1, comprehensions: 1, bareExcepts: 1, dataclasses: 1 });
  expect(s.errors.tryCatch).toBe(2);
  expect(s.naming.casing.function).toMatchObject({ snake: 5, camel: 2 }); // describe and _evict are one word, camel by shape
  expect(s.naming.casing.constant).toEqual({ camel: 0, pascal: 0, snake: 1, screaming: 1, backtick: 0, other: 0 });
  expect(s.naming.casing.class.pascal).toBe(2);
  expect(s.naming.booleanPrefix).toEqual({ is: 2 });
  expect(s.comments).toMatchObject({ line: 1, doc: 3, lowercaseStart: 1, trailingPeriod: 3 }); // module, class and function docstrings, all ending with a period
  // module level: MAX_RETRIES, cache_ttl_ms, User, UserRepository, describe, to_slug, active_names public, _first_line private
  // class level: __init__, get_user, is_cached public, _evict private, plus the two dataclass fields
  expect(s.comments.publicDecls).toBe(7 + 3 + 2);
  expect(s.comments.privateDecls).toBe(1 + 1);
  expect(s.comments.publicDocumented).toBe(2); // UserRepository and describe have docstrings
  expect(metric("python.type-hint-ratio", s).value).toBe(0.5);
  expect(isTestPath("tests/test_users.py")).toBe(true);
  expect(isTestPath("app/users_test.py")).toBe(true);
  expect(isTestPath("app/users.py")).toBe(false);
});
