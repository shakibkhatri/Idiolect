import { emptyProfile, emptyStats, upsertSource, analyzeCommits, type LlmProvider } from "@shakibkhatri/idiolect-core";
import { expect, test } from "vitest";
import { loadTasks, metricDistance, renderReport, runEval, DEFAULT_TASKS_DIR } from "./index.js";

const tasksDir = DEFAULT_TASKS_DIR;

test("loads the shipped tasks", async () => {
  const tasks = await loadTasks(tasksDir);
  expect(tasks.length).toBeGreaterThanOrEqual(6);
  expect(tasks.find((t) => t.id === "commit-message")?.kind).toBe("commit");
  expect(tasks.filter((t) => t.language === "typescript").length).toBeGreaterThanOrEqual(4);
});

test("metric distance keeps languages apart and names them when mixed", async () => {
  const kt = emptyStats(); kt.loc = 1000; kt.functions.count = 100; kt.functions.expressionBody = 90; kt.functions.blockBody = 10;
  const ts = emptyStats(); ts.loc = 1000; ts.typescript.arrowFunctions = 5; ts.typescript.functionDeclarations = 95; ts.functions.count = 100; ts.functions.blockBody = 100;
  const profile = upsertSource(emptyProfile("me", ["me@x"]), { repo: "/r", head: "h", scannedAt: "t", commits: 0, linesOwned: 2000, stats: { kotlin: kt, typescript: ts }, commitStats: analyzeCommits([]) });
  const task = (id: string, language: "kotlin" | "typescript") => ({ id, language, kind: "code" as const, prompt: "p" });
  const d = await metricDistance(profile, [
    { task: task("k", "kotlin"), with: "fun a() = 1\nfun b() = 2\n", without: "fun a(): Int {\n    return 1\n}\n" },
    { task: task("t", "typescript"), with: "function a() { return 1 }\nfunction b() { return 2 }\n", without: "const a = () => 1\nconst b = () => 2\n" },
  ]);
  const names = d.perMetric.map((m) => m.metric);
  expect(names).toContain("kotlin.functions.expression-body-ratio");
  expect(names).toContain("typescript.typescript.arrow-ratio");
  expect(names).not.toContain("typescript.kotlin.data-class-ratio");
  expect(d.with).toBeLessThan(d.without);
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
