import { emptyProfile, emptyStats, upsertSource, analyzeCommits, type LlmProvider } from "@idiolect/core";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { loadTasks, metricDistance, renderReport, runEval } from "./index.js";

const tasksDir = fileURLToPath(new URL("../../../data/eval-tasks", import.meta.url));

test("loads the shipped tasks", async () => {
  const tasks = await loadTasks(tasksDir);
  expect(tasks.length).toBeGreaterThanOrEqual(6);
  expect(tasks.find((t) => t.id === "commit-message")?.kind).toBe("commit");
});

test("runEval scores a mock provider and metric distance prefers the closer side", async () => {
  const stats = emptyStats();
  stats.loc = 1000; stats.functions.count = 100; stats.functions.expressionBody = 90; stats.functions.blockBody = 10;
  stats.comments.line = 50; stats.comments.lowercaseStart = 45;
  const cs = analyzeCommits([]); cs.count = 50; cs.lowercaseStart = 48;
  const profile = upsertSource(emptyProfile("me", ["me@x"]), { repo: "/r", head: "h", scannedAt: "t", commits: 50, linesOwned: 1000, stats: { kotlin: stats }, commitStats: cs });
  const tasks = (await loadTasks(tasksDir)).filter((t) => t.id === "sealed-state" || t.id === "commit-message");

  // "with profile" outputs are lowercase-commented expression bodies, "without" are the opposite
  const mock: LlmProvider = {
    name: "mock", model: "m",
    complete: async ({ system, schema }) => {
      const styled = system.includes("style profile");
      const shape = JSON.stringify((schema as { shape?: object }).shape ?? {});
      if (shape.includes("message")) return (styled ? { message: "add device label\n\nwhy" } : { message: "Added device label." }) as never;
      if (shape.includes("winner")) return { winner: "A", reason: "r" } as never;
      return { code: styled ? "// lowercase note\nfun a() = 1\nfun b() = 2\n" : "// Uppercase note.\nfun a(): Int {\n    return 1\n}\nfun b(): Int {\n    return 2\n}\n" } as never;
    },
  };
  const report = await runEval({ profile, provider: mock, references: [{ file: "f", line: 1, text: "fun x() = 1" }], tasks, threshold: 0.6 });
  expect(report.judge.total).toBe(2);
  expect(report.metricDistance.with).toBeLessThan(report.metricDistance.without);
  const d = await metricDistance(profile, report.generations);
  expect(d.perMetric.map((m) => m.metric)).toContain("commits.lowercase-ratio");
  const md = renderReport(report);
  expect(md).toContain("| LLM judge win rate |");
  expect(md).toContain("### sealed-state");
});
