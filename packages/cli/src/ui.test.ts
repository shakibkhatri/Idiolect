import { emptyProfile, emptyStats, type Profile, type Rule } from "@shakibkhatri/idiolect-core";
import { expect, test } from "vitest";
import { buildState, page } from "./ui.js";

const rule = (id: string, over: Partial<Rule> = {}): Rule => ({ id, scope: "personal", language: "kotlin", category: "naming", text: `Rule ${id}.`, evidence: { examples: [] }, confidence: 0.9, status: "auto", ...over });

test("dashboard state marks served rules, hides other repos' project rules and ranks languages by lines", async () => {
  const kt = emptyStats(); kt.loc = 9000;
  const py = emptyStats(); py.loc = 300;
  const profile: Profile = { ...emptyProfile("me", ["me@x"]), stats: { kotlin: kt, python: py }, rules: [
    rule("a"), rule("b", { confidence: 0.3 }), rule("c", { status: "rejected" }), rule("d", { repo: "/here" }), rule("e", { repo: "/elsewhere" }),
  ] };
  const s = await buildState(profile, "/here", 0.6, []);
  expect(s.rules.map((r) => [r.id, r.served])).toEqual([["a", true], ["b", false], ["c", false], ["d", true], ["e", false]]);
  expect(s.languages.map((l) => l.language)).toEqual(["kotlin", "python"]);
  expect(s.languages[1]!.share).toBeCloseTo(300 / 9300);
  expect(s.style).toContain("Rule a.");
  expect(s.style).not.toContain("Rule e.");
  expect(page()).toContain("/api/state");
});
