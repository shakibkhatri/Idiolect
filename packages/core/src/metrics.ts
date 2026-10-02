import type { CommitStats, Histogram, LanguageStats } from "./analyzer.js";

/** A metric is a fraction (num/den) or a value with a sample size, computed from raw stats. Ids are referenced by ai-tells.json and rule ids. */
export type Metric = { value: number; sampleSize: number };
type MetricFn = (s: LanguageStats) => Metric;

const ratio = (num: number, den: number): Metric => ({ value: den ? num / den : 0, sampleSize: den });
const perKloc = (num: number, s: LanguageStats): Metric => ({ value: s.loc ? (1000 * num) / s.loc : 0, sampleSize: s.loc });
const sum = (h: Histogram) => Object.values(h).reduce((a, b) => a + b, 0);
export function percentile(h: Histogram, p: number): number {
  const entries = Object.entries(h).map(([k, v]) => [Number(k), v] as const).sort((a, b) => a[0] - b[0]);
  const total = sum(h);
  let acc = 0;
  for (const [k, v] of entries) { acc += v; if (acc >= total * p) return k; }
  return 0;
}
const comments = (s: LanguageStats) => s.comments.line + s.comments.block + s.comments.doc;

export const METRICS: Record<string, MetricFn> = {
  "functions.expression-body-ratio": (s) => ratio(s.functions.expressionBody, s.functions.count),
  "functions.early-return-ratio": (s) => ratio(s.functions.earlyReturn, s.functions.blockBody),
  "functions.length-p50": (s) => ({ value: percentile(s.functions.lengthLines, 0.5), sampleSize: sum(s.functions.lengthLines) }),
  "functions.length-p90": (s) => ({ value: percentile(s.functions.lengthLines, 0.9), sampleSize: sum(s.functions.lengthLines) }),
  "functions.params-p90": (s) => ({ value: percentile(s.functions.params, 0.9), sampleSize: sum(s.functions.params) }),
  "functions.nesting-p90": (s) => ({ value: percentile(s.functions.maxNesting, 0.9), sampleSize: sum(s.functions.maxNesting) }),
  "naming.function-camel-ratio": (s) => ratio(s.naming.casing.function.camel, s.naming.casing.function.camel + s.naming.casing.function.snake + s.naming.casing.function.other),
  "naming.constant-screaming-ratio": (s) => ratio(s.naming.casing.constant.screaming, s.naming.casing.constant.screaming + s.naming.casing.constant.camel + s.naming.casing.constant.pascal),
  "naming.abbreviation-ratio": (s) => ratio(s.naming.abbreviated, s.naming.identifiers),
  "naming.generic-ratio": (s) => ratio(s.naming.genericNames, s.naming.casing.function.camel + s.naming.casing.function.pascal + s.naming.casing.function.snake),
  "naming.boolean-is-has-ratio": (s) => { const b = s.naming.booleanPrefix; const total = sum(b); return ratio((b.is ?? 0) + (b.has ?? 0) + (b.can ?? 0) + (b.should ?? 0), total); },
  "naming.test-backtick-ratio": (s) => ratio(s.naming.testNames.backtick ?? 0, sum(s.naming.testNames)),
  "naming.test-camel-sentence-ratio": (s) => ratio(s.naming.testNames.camelSentence ?? 0, sum(s.naming.testNames)),
  "naming.test-should-ratio": (s) => ratio(s.naming.testNames.should ?? 0, (s.naming.testNames.should ?? 0) + (s.naming.testNames.sentence ?? 0)),
  "comments.per-100-loc": (s) => ({ value: s.loc ? (100 * comments(s)) / s.loc : 0, sampleSize: s.loc }),
  "comments.doc-ratio": (s) => ratio(s.comments.doc, comments(s)),
  "comments.lowercase-start-ratio": (s) => ratio(s.comments.lowercaseStart, comments(s)),
  "comments.trailing-period-ratio": (s) => ratio(s.comments.trailingPeriod, comments(s)),
  "comments.avg-chars": (s) => ({ value: comments(s) ? Math.round(s.comments.chars / comments(s)) : 0, sampleSize: comments(s) }),
  "comments.public-doc-ratio": (s) => ratio(s.comments.publicDocumented, s.comments.publicDecls),
  "comments.private-doc-ratio": (s) => ratio(s.comments.privateDocumented, s.comments.privateDecls),
  "comments.todo-ratio": (s) => ratio(sum(s.comments.todo), comments(s)),
  "comments.buzzword-ratio": (s) => ratio(s.comments.tells.buzzword ?? 0, comments(s)),
  "comments.restates-ratio": (s) => ratio(s.comments.tells.restates ?? 0, comments(s)),
  "comments.emoji-ratio": (s) => ratio(s.comments.tells.emoji ?? 0, comments(s)),
  "errors.try-per-kloc": (s) => perKloc(s.errors.tryCatch, s),
  "errors.run-catching-per-kloc": (s) => perKloc(s.errors.runCatching, s),
  "errors.result-per-kloc": (s) => perKloc(s.errors.resultType, s),
  "errors.force-unwrap-per-kloc": (s) => perKloc(s.errors.forceUnwrap, s),
  "errors.run-catching-share": (s) => ratio(s.errors.runCatching, s.errors.runCatching + s.errors.tryCatch),
  "kotlin.when-ratio": (s) => ratio(s.kotlin.when3, s.kotlin.when3 + s.kotlin.ifElseChain3),
  "kotlin.sealed-interface-ratio": (s) => ratio(s.kotlin.sealedInterface, s.kotlin.sealedInterface + s.kotlin.sealedClass),
  "kotlin.extension-per-kloc": (s) => perKloc(s.kotlin.extensionFunctions, s),
  "kotlin.data-class-ratio": (s) => ratio(s.kotlin.dataClasses, s.naming.casing.class.pascal),
  "kotlin.composable-ratio": (s) => ratio(s.kotlin.composables, s.functions.count),
  "kotlin.modifier-first-ratio": (s) => ratio(s.kotlin.modifierParamFirst, s.kotlin.modifierParamFirst + s.kotlin.modifierParamLater),
  "typescript.arrow-ratio": (s) => ratio(s.typescript.arrowFunctions, s.typescript.arrowFunctions + s.typescript.functionDeclarations),
  "typescript.type-alias-ratio": (s) => ratio(s.typescript.typeAliases, s.typescript.typeAliases + s.typescript.interfaces),
  "typescript.optional-chain-per-kloc": (s) => perKloc(s.typescript.optionalChains, s),
  "typescript.any-per-kloc": (s) => perKloc(s.typescript.anyTypes, s),
  "python.type-hint-ratio": (s) => ratio(s.python.typeHinted, s.functions.count),
  "python.fstring-ratio": (s) => ratio(s.python.fStrings, s.python.fStrings + s.python.formatCalls),
  "python.comprehension-per-kloc": (s) => perKloc(s.python.comprehensions, s),
  "python.bare-except-per-kloc": (s) => perKloc(s.python.bareExcepts, s),
  "python.dataclass-ratio": (s) => ratio(s.python.dataclasses, s.naming.casing.class.pascal),
  "go.err-check-per-kloc": (s) => perKloc(s.go.errChecks, s),
  "go.named-return-ratio": (s) => ratio(s.go.namedReturns, s.functions.count),
  "go.panic-per-kloc": (s) => perKloc(s.go.panics, s),
};

export const COMMIT_METRICS: Record<string, (c: CommitStats) => Metric> = {
  "commits.subject-p50": (c) => ({ value: percentile(c.subjectLength, 0.5), sampleSize: c.count }),
  "commits.lowercase-ratio": (c) => ratio(c.lowercaseStart, c.count),
  "commits.conventional-ratio": (c) => ratio(c.conventionalPrefix, c.count),
  "commits.trailing-period-ratio": (c) => ratio(c.trailingPeriod, c.count),
  "commits.body-ratio": (c) => ratio(c.withBody, c.count),
  "commits.imperative-ratio": (c) => ratio(c.tense.imperative ?? 0, c.count),
  "commits.past-ratio": (c) => ratio(c.tense.past ?? 0, c.count),
};

export function metric(id: string, s: LanguageStats | undefined, c?: CommitStats): Metric {
  if (id in COMMIT_METRICS) { if (!c) throw new Error(`metric ${id} needs commit stats`); return COMMIT_METRICS[id]!(c); }
  const fn = METRICS[id];
  if (!fn) throw new Error(`unknown metric ${id}`);
  if (!s) return { value: 0, sampleSize: 0 };
  return fn(s);
}

/** How a ratio metric splits across files: how many files sit at or under 0.5 and how many over, among files with at least `minItems` items. */
export type Spread = { under: number; over: number };
export const isRatioMetric = (id: string) => id.endsWith("-ratio") || id.endsWith("-share");

export function fileSpread(perFile: LanguageStats[], minItems = 5): Record<string, Spread> {
  const out: Record<string, Spread> = {};
  for (const id of Object.keys(METRICS).filter(isRatioMetric)) {
    const sp: Spread = { under: 0, over: 0 };
    for (const f of perFile) {
      const m = METRICS[id]!(f);
      if (m.sampleSize < minItems) continue;
      sp[m.value > 0.5 ? "over" : "under"]++;
    }
    if (sp.under + sp.over) out[id] = sp;
  }
  return out;
}
