import { BUZZWORDS, commentText, EMOJI, grammarFor, isTestPath, RESTATES, TODO_TAG } from "./analyzer.js";
import { analyze } from "./languages.js";
import { COMMIT_METRICS, metric } from "./metrics.js";
import { parse } from "./parser.js";
import type { Language, Profile } from "./profile.js";
import { appliesTo } from "./render.js";
import { isServed } from "./writer.js";

// ponytail: calibrated on the author's repo so about one file in ten of his own code is flagged, make these repo config if others disagree
const MIN_ITEMS = 10, MIN_LINES = 100, MIN_LOCATED = 3, EXCESS = 2;

export type Violation = { ruleId: string; line?: number; message: string; suggestion: string };
/** `file` is relative to the repo, used for test detection and path-scoped rules. */
export type CheckOptions = { language: Language; threshold: number; repo?: string; file?: string };

/** Runs the analyzer on the code and compares every served metric rule against it. No LLM, so it cannot judge voice. */
export async function checkStyle(profile: Profile, code: string, opts: CheckOptions): Promise<Violation[]> {
  const rules = profile.rules.filter((r) => isServed(r, opts.threshold) && appliesTo(r, opts) && (!r.repo || r.repo === opts.repo)
    && r.evidence.metric && !(r.evidence.metric.name in COMMIT_METRICS));
  const stats = await analyze(code, opts.language, undefined, { test: !!opts.file && isTestPath(opts.file), path: opts.file });
  const found = await locateNodes(code, opts);
  const out: Violation[] = [];
  for (const r of rules) {
    const dev = r.evidence.metric!;
    const here = metric(dev.name, stats);
    const kind = r.id.startsWith("avoid.") ? "avoid" : r.id.split(".").at(-1)!;
    // a ratio over a handful of items is noise. Avoid rules fire on one occurrence, located ratio rules need a few items, aggregates need more
    const locate = LOCATE[`${dev.name}.${kind}`];
    const floor = kind === "avoid" ? 1 : locate ? MIN_LOCATED : dev.name.includes("loc") ? MIN_LINES : MIN_ITEMS;
    if (here.sampleSize < floor) continue;
    // value rules are "keep it small" quantities except the per-kloc ones, which say the developer does a lot of something
    const bad = kind === "high" ? here.value < 0.5
      : kind === "low" ? here.value > 0.5
      : kind === "avoid" ? here.value > 0
      : kind === "value" ? !dev.name.endsWith("per-kloc") && here.value > dev.value * EXCESS
      : false;
    if (!bad) continue;
    const message = `${dev.name} is ${fmt(dev.name, here.value)} here (n = ${here.sampleSize}), ${fmt(dev.name, dev.value)} in your code (n = ${dev.sampleSize})`;
    const lines = locate?.(found, code) ?? [];
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
type Found = { comments: CommentNode[]; forceUnwraps: number[]; anys: number[] };
const COMMENT_TYPES = new Set(["line_comment", "block_comment", "comment"]);

/** Second walk collecting the nodes the line finders need, in either grammar. */
async function locateNodes(code: string, opts: CheckOptions): Promise<Found> {
  const tree = await parse(code, grammarFor(opts.language, opts.file));
  const out: Found = { comments: [], forceUnwraps: [], anys: [] };
  const visit = (n: typeof tree.rootNode) => {
    const line = n.startPosition.row + 1;
    if (COMMENT_TYPES.has(n.type)) out.comments.push({ line, end: n.endPosition.row, text: commentText(n.text), doc: n.text.startsWith("/**") });
    else if (n.type === "non_null_expression" || (n.type === "unary_expression" && n.children.some((c) => c?.type === "!!"))) out.forceUnwraps.push(line);
    else if (n.type === "predefined_type" && n.text === "any") out.anys.push(line);
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(tree.rootNode);
  tree.delete();
  return out;
}

const lines = (cs: CommentNode[]) => cs.map((c) => c.line);
const nextDecl = (c: CommentNode, code: string) => code.split("\n").slice(c.end + 1).find((l) => l.trim()) ?? "";
const PRIVATE = /^\s*(private|internal|protected)\b/;

/** Line finders keyed by metric and rule kind. Metrics without one report a single violation without a line.
 * doc-ratio has none on purpose: a developer who documents some files fully and others not at all would see every doc comment flagged. */
const LOCATE: Partial<Record<string, (f: Found, code: string) => number[]>> = {
  "comments.lowercase-start-ratio.high": (f) => lines(f.comments.filter((c) => /^[A-Z]/.test(c.text))),
  "comments.lowercase-start-ratio.low": (f) => lines(f.comments.filter((c) => /^[a-z]/.test(c.text))),
  "comments.trailing-period-ratio.high": (f) => lines(f.comments.filter((c) => c.text && !c.text.endsWith("."))),
  "comments.trailing-period-ratio.low": (f) => lines(f.comments.filter((c) => c.text.endsWith("."))),
  "comments.public-doc-ratio.low": (f, code) => lines(f.comments.filter((c) => c.doc && !PRIVATE.test(nextDecl(c, code)))),
  "comments.private-doc-ratio.avoid": (f, code) => lines(f.comments.filter((c) => c.doc && PRIVATE.test(nextDecl(c, code)))),
  "comments.buzzword-ratio.avoid": (f) => lines(f.comments.filter((c) => BUZZWORDS.test(c.text))),
  "comments.restates-ratio.avoid": (f) => lines(f.comments.filter((c) => RESTATES.test(c.text))),
  "comments.emoji-ratio.avoid": (f) => lines(f.comments.filter((c) => EMOJI.test(c.text))),
  "comments.todo-ratio.avoid": (f) => lines(f.comments.filter((c) => TODO_TAG.test(c.text))),
  "errors.force-unwrap-per-kloc.avoid": (f) => f.forceUnwraps,
  "typescript.any-per-kloc.avoid": (f) => f.anys,
};
