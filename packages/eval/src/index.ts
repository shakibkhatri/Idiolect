import { analyzeCommits, analyzeKotlin, emptyStats, mergeStats, METRICS, COMMIT_METRICS, renderStyleMd, type CommitStats, type LanguageStats, type LlmProvider, type Profile, type Sample } from "@shakibkhatri/idiolect-core";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The task files shipped with the package. */
export const DEFAULT_TASKS_DIR = fileURLToPath(new URL("../tasks", import.meta.url));
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type Task = { id: string; language: "kotlin"; kind: "code" | "commit"; prompt: string };
export type Generation = { task: Task; with: string; without: string };
export type Judgement = { task: string; winner: "with" | "without"; reason: string };
export type Report = {
  generatedAt: string;
  profileGeneratedAt: string;
  rules: number;
  tasks: number;
  judge: { withWins: number; total: number; winRate: number; verdicts: Judgement[] };
  quiz?: { withWins: number; total: number; winRate: number; picks: { task: string; picked: "with" | "without" | "skip" }[] };
  metricDistance: { with: number; without: number; perMetric: { metric: string; developer: number; with: number; without: number }[] };
  generations: Generation[];
};

const TaskSchema = z.object({ id: z.string(), language: z.literal("kotlin").default("kotlin"), kind: z.enum(["code", "commit"]).default("code"), prompt: z.string() });

export async function loadTasks(dir: string): Promise<Task[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
  return Promise.all(files.map(async (f) => TaskSchema.parse(parseYaml(await readFile(join(dir, f), "utf8")))));
}

const Code = z.object({ code: z.string().describe("the Kotlin source, nothing else") });
const Commit = z.object({ message: z.string().describe("the full commit message: subject line, blank line, body") });
const Verdict = z.object({ winner: z.enum(["A", "B"]), reason: z.string().max(300) });

export type EvalOptions = { profile: Profile; provider: LlmProvider; references: Sample[]; tasks: Task[]; repo?: string; threshold: number; concurrency?: number; onProgress?: (msg: string) => void };

export async function runEval(o: EvalOptions): Promise<Report> {
  const style = renderStyleMd(o.profile, { threshold: o.threshold, repo: o.repo });
  const baseSystem = "You are a senior Kotlin developer writing production code for a real app. Return only what is asked.";
  const styledSystem = `${baseSystem}\n\nWrite exactly the way this developer writes. Follow their style profile strictly, including comments and commit messages:\n\n${style}`;

  const generations = await pool(o.tasks, o.concurrency ?? 3, async (task): Promise<Generation> => {
    const gen = async (system: string) => task.kind === "commit"
      ? (await o.provider.complete({ system, user: task.prompt, schema: Commit })).message
      : (await o.provider.complete({ system, user: task.prompt, schema: Code })).code;
    const [withText, withoutText] = await Promise.all([gen(styledSystem), gen(baseSystem)]);
    o.onProgress?.(`generated ${task.id}`);
    return { task, with: withText, without: withoutText };
  });

  const refs = o.references.map((s, i) => `[ref ${i + 1}]\n${s.text}`).join("\n\n");
  const verdicts = await pool(generations, o.concurrency ?? 3, async (g): Promise<Judgement> => {
    const flip = hash(g.task.id) % 2 === 1;
    const [a, b] = flip ? [g.without, g.with] : [g.with, g.without];
    const out = await o.provider.complete({
      system: "You compare two pieces of code or text against reference samples written by one developer and decide which was more likely written by that developer. Judge voice, naming, comments, structure and error handling, not correctness or length. Return JSON.",
      user: `# Reference samples by the developer\n\n${refs}\n\n# Task\n${g.task.prompt}\n\n# A\n${a}\n\n# B\n${b}\n\nWhich of A or B reads more like the developer who wrote the reference samples?`,
      schema: Verdict,
    });
    const winner = (out.winner === "A") !== flip ? "with" : "without";
    o.onProgress?.(`judged ${g.task.id}: ${winner}`);
    return { task: g.task.id, winner, reason: out.reason };
  });
  const withWins = verdicts.filter((v) => v.winner === "with").length;

  const dist = await metricDistance(o.profile, generations);
  return {
    generatedAt: new Date().toISOString(), profileGeneratedAt: o.profile.generatedAt, rules: o.profile.rules.length, tasks: o.tasks.length,
    judge: { withWins, total: verdicts.length, winRate: verdicts.length ? withWins / verdicts.length : 0, verdicts },
    metricDistance: dist, generations,
  };
}

/** Mean absolute difference between the developer's ratio metrics and the same metrics on all generated outputs merged together. */
export async function metricDistance(profile: Profile, generations: Generation[]) {
  const dev = profile.stats.kotlin;
  const devCommits = profile.commitStats;
  const side = async (pick: (g: Generation) => string) => {
    let stats: LanguageStats = emptyStats();
    const commits: CommitStats[] = [];
    for (const g of generations) {
      if (g.task.kind === "commit") {
        const [subject = "", ...rest] = pick(g).trim().split("\n");
        commits.push(analyzeCommits([{ hash: "x", email: "x", date: "x", subject, body: rest.join("\n").trim() }]));
      } else {
        stats = mergeStats(stats, await analyzeKotlin(pick(g)));
      }
    }
    return { stats, commits: commits.reduce((a, b) => mergeStats(a, b), analyzeCommits([])) };
  };
  const w = await side((g) => g.with);
  const wo = await side((g) => g.without);
  const perMetric: { metric: string; developer: number; with: number; without: number }[] = [];
  for (const [id, fn] of Object.entries(METRICS)) {
    if (!id.endsWith("-ratio") && !id.endsWith("-share") && id !== "comments.per-100-loc") continue;
    if (!dev) break;
    const d = fn(dev), a = fn(w.stats), b = fn(wo.stats);
    if (d.sampleSize < 20 || !a.sampleSize || !b.sampleSize) continue;
    const norm = (v: number) => (id === "comments.per-100-loc" ? Math.min(1, v / 20) : v);
    perMetric.push({ metric: id, developer: norm(d.value), with: norm(a.value), without: norm(b.value) });
  }
  for (const [id, fn] of Object.entries(COMMIT_METRICS)) {
    if (!id.endsWith("-ratio")) continue;
    const d = fn(devCommits), a = fn(w.commits), b = fn(wo.commits);
    if (d.sampleSize < 20 || !a.sampleSize || !b.sampleSize) continue;
    perMetric.push({ metric: id, developer: d.value, with: a.value, without: b.value });
  }
  const mean = (k: "with" | "without") => (perMetric.length ? perMetric.reduce((n, m) => n + Math.abs(m[k] - m.developer), 0) / perMetric.length : 0);
  return { with: round(mean("with")), without: round(mean("without")), perMetric: perMetric.map((m) => ({ ...m, developer: round(m.developer), with: round(m.with), without: round(m.without) })) };
}

export function renderReport(r: Report): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const out = [`# Idiolect eval`, "", `${r.tasks} tasks, profile with ${r.rules} rules (generated ${r.profileGeneratedAt}), run ${r.generatedAt}`, ""];
  out.push(`## Scores`, "", `| score | with profile | without |`, `|---|---|---|`);
  out.push(`| LLM judge win rate | ${pct(r.judge.winRate)} (${r.judge.withWins}/${r.judge.total}) | ${pct(1 - r.judge.winRate)} |`);
  if (r.quiz) out.push(`| blind quiz win rate | ${pct(r.quiz.winRate)} (${r.quiz.withWins}/${r.quiz.total}) | ${pct(1 - r.quiz.winRate)} |`);
  out.push(`| metric distance (lower is better) | ${r.metricDistance.with} | ${r.metricDistance.without} |`, "");
  if (r.metricDistance.perMetric.length) {
    out.push(`## Metric distance`, "", `| metric | developer | with | without |`, `|---|---|---|---|`);
    for (const m of r.metricDistance.perMetric) out.push(`| ${m.metric} | ${m.developer} | ${m.with} | ${m.without} |`);
    out.push("");
  }
  out.push(`## Verdicts`, "");
  const picked = new Map(r.quiz?.picks.map((p) => [p.task, p.picked]));
  for (const v of r.judge.verdicts) out.push(`- **${v.task}**: judge says ${v.winner} profile${picked.has(v.task) ? `, developer picked ${picked.get(v.task)}` : ""}. ${v.reason}`);
  out.push("", `## Outputs`, "");
  for (const g of r.generations) out.push(`### ${g.task.id}`, "", `**with profile**`, "", "```kotlin", g.with.trim(), "```", "", `**without**`, "", "```kotlin", g.without.trim(), "```", "");
  return out.join("\n");
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const next = async (): Promise<void> => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]!); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, next));
  return out;
}
const round = (x: number) => Math.round(x * 1000) / 1000;
function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
