import { analyzeKotlin, BUZZWORDS, commentText, EMOJI, isTestPath, RESTATES, TODO_TAG } from "./analyzer.js";
import { COMMIT_METRICS, metric } from "./metrics.js";
import { parse } from "./parser.js";
import type { Language, Profile } from "./profile.js";
import { appliesTo } from "./render.js";
import { isServed } from "./writer.js";

export type Violation = { ruleId: string; line?: number; message: string; suggestion: string };
/** `file` is relative to the repo, used for test detection and path-scoped rules. */
export type CheckOptions = { language: Language; threshold: number; repo?: string; file?: string };

/** Runs the analyzer on the code and compares every served metric rule against it. No LLM, so it cannot judge voice. */
export async function checkStyle(profile: Profile, code: string, opts: CheckOptions): Promise<Violation[]> {
  const rules = profile.rules.filter((r) => isServed(r, opts.threshold) && appliesTo(r, opts) && (!r.repo || r.repo === opts.repo)
    && r.evidence.metric && !(r.evidence.metric.name in COMMIT_METRICS));
  const stats = await analyzeKotlin(code, undefined, { test: !!opts.file && isTestPath(opts.file) });
  const comments = await commentNodes(code);
  const out: Violation[] = [];
  for (const r of rules) {
    const dev = r.evidence.metric!;
    const here = metric(dev.name, stats);
    if (!here.sampleSize) continue;
    const kind = r.id.startsWith("avoid.") ? "avoid" : r.id.split(".").at(-1)!;
    // value rules are "keep it small" quantities except the per-kloc ones, which say the developer does a lot of something
    const bad = kind === "high" ? here.value < 0.5
      : kind === "low" ? here.value > 0.5
      : kind === "avoid" ? here.value > 0
      : kind === "value" ? !dev.name.endsWith("per-kloc") && here.value > dev.value * 1.5
      : false;
    if (!bad) continue;
    const message = `${dev.name} is ${fmt(dev.name, here.value)} here (n = ${here.sampleSize}), ${fmt(dev.name, dev.value)} in your code (n = ${dev.sampleSize})`;
    const lines = LOCATE[`${dev.name}.${kind}`]?.(comments, code) ?? [];
    if (lines.length) for (const line of lines) out.push({ ruleId: r.id, line, message, suggestion: r.text });
    else out.push({ ruleId: r.id, message, suggestion: r.text });
  }
  return out.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

function fmt(name: string, v: number): string {
  if (name.endsWith("-ratio") || name.endsWith("-share")) return `${Math.round(v * 100)}%`;
  if (name.endsWith("per-100-loc")) return `${Math.round(v * 10) / 10} per 100 lines`;
  if (name.endsWith("per-kloc")) return `${Math.round(v * 10) / 10} per 1000 lines`;
  return String(Math.round(v * 10) / 10);
}

type CommentNode = { line: number; end: number; text: string; doc: boolean };

async function commentNodes(code: string): Promise<CommentNode[]> {
  const tree = await parse(code, "kotlin");
  const out: CommentNode[] = [];
  const visit = (n: typeof tree.rootNode) => {
    if (n.type === "line_comment" || n.type === "block_comment") out.push({ line: n.startPosition.row + 1, end: n.endPosition.row, text: commentText(n.text), doc: n.text.startsWith("/**") });
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(tree.rootNode);
  tree.delete();
  return out;
}

const lines = (cs: CommentNode[]) => cs.map((c) => c.line);
const nextDecl = (c: CommentNode, code: string) => code.split("\n").slice(c.end + 1).find((l) => l.trim()) ?? "";
const PRIVATE = /^\s*(private|internal|protected)\b/;

/** Line finders keyed by metric and rule kind. Metrics without one report a single violation without a line. */
const LOCATE: Record<string, (cs: CommentNode[], code: string) => number[]> = {
  "comments.lowercase-start-ratio.high": (cs) => lines(cs.filter((c) => /^[A-Z]/.test(c.text))),
  "comments.lowercase-start-ratio.low": (cs) => lines(cs.filter((c) => /^[a-z]/.test(c.text))),
  "comments.trailing-period-ratio.high": (cs) => lines(cs.filter((c) => c.text && !c.text.endsWith("."))),
  "comments.trailing-period-ratio.low": (cs) => lines(cs.filter((c) => c.text.endsWith("."))),
  "comments.doc-ratio.low": (cs) => lines(cs.filter((c) => c.doc)),
  "comments.public-doc-ratio.low": (cs, code) => lines(cs.filter((c) => c.doc && !PRIVATE.test(nextDecl(c, code)))),
  "comments.private-doc-ratio.avoid": (cs, code) => lines(cs.filter((c) => c.doc && PRIVATE.test(nextDecl(c, code)))),
  "comments.buzzword-ratio.avoid": (cs) => lines(cs.filter((c) => BUZZWORDS.test(c.text))),
  "comments.restates-ratio.avoid": (cs) => lines(cs.filter((c) => RESTATES.test(c.text))),
  "comments.emoji-ratio.avoid": (cs) => lines(cs.filter((c) => EMOJI.test(c.text))),
  "comments.todo-ratio.avoid": (cs) => lines(cs.filter((c) => TODO_TAG.test(c.text))),
  "errors.force-unwrap-per-kloc.avoid": (_, code) => code.split("\n").flatMap((l, i) => (l.includes("!!") ? [i + 1] : [])),
};
