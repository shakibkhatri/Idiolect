import type { Report } from "@shakibkhatri/idiolect-eval";
import { expect, test } from "vitest";
import { page, pairsOf, scorePicks } from "./quiz.js";

const report = {
  generations: [
    { task: { id: "t1", prompt: "p1" }, with: "fun a() {}", without: "fun b() {}" },
    { task: { id: "t2", prompt: "p2" }, with: "// x\nval y = 1", without: "val y = 1</script><b>" },
  ],
} as unknown as Report;

test("quiz pairs hide the side, picks map back through the flip, and the page carries the data", () => {
  const pairs = pairsOf(report, () => 0.1); // every pair flipped: A is without, B is with
  expect(pairs[0]).toMatchObject({ a: "fun b() {}", b: "fun a() {}", flip: true });
  const quiz = scorePicks(pairs, [{ task: "t1", pick: "b" }, { task: "t2", pick: "A" }]);
  expect(quiz.picks).toEqual([{ task: "t1", picked: "with" }, { task: "t2", picked: "without" }]);
  expect(quiz).toMatchObject({ withWins: 1, total: 2, winRate: 0.5 });
  expect(scorePicks(pairs, [{ task: "t1", pick: "skip" }])).toMatchObject({ withWins: 0, total: 0, picks: [{ task: "t1", picked: "skip" }, { task: "t2", picked: "skip" }] });
  const html = page(pairs.map(({ flip: _, ...p }) => p));
  expect(html).not.toContain("flip");
  expect(html).not.toContain("</script><b>"); // a closing tag inside a sample cannot break out of the data script
  expect(html).toContain("\\u003c/script>");
});
