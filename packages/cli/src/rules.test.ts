import type { Rule } from "@shakibkhatri/idiolect-core";
import { expect, test } from "vitest";
import { renderRules } from "./rules.js";
import { createTerm } from "./term.js";

const plain = createTerm({ isTTY: false, write: () => 0 }, {});
const rule = (id: string, category: Rule["category"], status: Rule["status"], text: string): Rule =>
  ({ id, scope: "personal", language: "kotlin", category, text, evidence: { examples: [] }, confidence: 0.9, status });

test("rules are listed by section with the text first, a marker in front and the id last", () => {
  const rows = [
    rule("kotlin.commits.short", "commits", "auto", "Keep the subject short"),
    rule("kotlin.naming.verbs", "naming", "approved", "Start function names with a verb"),
    rule("kotlin.naming.weak", "naming", "auto", "Prefer nouns for classes"),
    rule("kotlin.naming.changed", "naming", "pending", "Avoid\n abbreviations"),
    rule("kotlin.avoid.todo", "avoid", "rejected", "Do not leave TODO comments"),
  ];
  const lines = renderRules(rows, (r) => r.id !== "kotlin.naming.weak", plain).split("\n");
  expect(lines.slice(0, 5)).toEqual([
    "Naming",
    "  + Start function names with a verb  kotlin.naming.verbs",
    "  - Prefer nouns for classes  kotlin.naming.weak",
    "  ? Avoid abbreviations  kotlin.naming.changed",
    "",
  ]);
  expect(lines.indexOf("Commits")).toBeLessThan(lines.indexOf("Avoid"));
  expect(lines).toContain("  x Do not leave TODO comments  kotlin.avoid.todo");
  expect(lines).toContain("5 rules: 2 served, 1 held back, 1 pending, 1 rejected.");
  expect(lines.at(-1)).toMatch(/^Next: idiolect rules approve/);
  const long = renderRules([rule("kotlin.naming.a-rule-with-a-long-id", "naming", "auto", "word ".repeat(40))], () => true, plain).split("\n");
  expect(Math.max(...long.map((l) => l.length))).toBeLessThanOrEqual(100);
  expect(long[3]).toMatch(/^    word .*  kotlin\.naming\.a-rule-with-a-long-id$/);
  expect(renderRules([], () => true, plain)).toBe("No rules match.");
});
