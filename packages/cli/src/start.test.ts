import { expect, test } from "vitest";
import { renderState, renderSteps, stepsFor, type ProjectState } from "./start.js";
import { createTerm } from "./term.js";

const plain = createTerm({ isTTY: false, write: () => 0 }, {});
const base: ProjectState = { kind: "none", styles: [], rules: 0, pending: [], refreshEvery: 50, files: { written: [], stale: [] } };
const commands = (s: ProjectState) => stepsFor(s).map((step) => step.runs.map((r) => r.join(" ")).join(" + "));

test("each state offers only the steps that apply, as existing commands", () => {
  expect(commands(base)).toEqual(["use", "init + scan"]);
  expect(commands({ ...base, kind: "unscanned", rules: 4 })).toEqual(["scan", "use"]);

  const house: ProjectState = { ...base, kind: "house", styles: [{ language: "kotlin", id: "kotlin-tivi", summary: "Few comments" }], files: { written: ["AGENTS.md"], stale: [] } };
  expect(commands(house)).toEqual(["use", "ui", "unbot --all", "remove"]);
  expect(commands({ ...house, files: { written: ["AGENTS.md"], stale: ["AGENTS.md"] } })).toEqual(["use", "ui", "unbot --all", "sync", "remove"]);

  const own: ProjectState = { ...base, kind: "own", rules: 79, updated: new Date().toISOString(), scan: { since: 0, scannedAt: new Date().toISOString() }, files: { written: ["AGENTS.md"], stale: [] } };
  expect(commands(own)).toEqual(["ui", "unbot --all", "remove"]);
  expect(commands({ ...own, scan: { ...own.scan!, since: 3 }, files: { written: [], stale: ["AGENTS.md"] } })).toEqual(["scan", "ui", "sync", "unbot --all", "remove"]);
  for (const s of [base, house, own]) expect(stepsFor(s).length).toBeLessThanOrEqual(5);
});

test("the report names the served style first and stays within 100 columns", () => {
  const house: ProjectState = { ...base, kind: "house", styles: [{ language: "typescript", id: "typescript-vue", summary: "x".repeat(60) }], files: { written: ["AGENTS.md", "CLAUDE.md"], stale: ["CLAUDE.md"] } };
  const report = renderState(house, plain);
  expect(report.split("\n")[0]).toBe("This project follows a house style.");
  expect(report).toContain("Agent files  AGENTS.md, out of date: CLAUDE.md");
  expect(Math.max(...report.split("\n").map((l) => l.length))).toBeLessThanOrEqual(100);

  const own: ProjectState = { ...base, kind: "own", rules: 79, pending: [{ id: "kotlin.naming.x", text: "Name things plainly" }], updated: new Date().toISOString(), scan: { since: 50, scannedAt: new Date().toISOString() }, files: { written: [], stale: ["AGENTS.md"] } };
  const mine = renderState(own, plain);
  expect(mine).toContain("79 rules, 1 pending, updated under an hour ago");
  expect(mine).toContain("50 commits since, refresh due now");
  expect(mine).toContain("Agent files  not written yet");
  expect(mine).toContain("  Name things plainly  kotlin.naming.x");
  expect(mine).not.toMatch(/profile/i);
});

test("steps are numbered for a prompt and listed as commands without one", () => {
  expect(renderSteps(stepsFor(base), true, plain)).toBe("  1  Pick a house style                      idiolect use\n  2  Learn my own style from my git history  idiolect init, then idiolect scan");
  expect(renderSteps(stepsFor(base), false, plain).split("\n")).toEqual(["Next:", "  idiolect use                       Pick a house style", "  idiolect init, then idiolect scan  Learn my own style from my git history"]);
});
