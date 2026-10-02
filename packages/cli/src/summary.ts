import type { CommitStats, Counter, Histogram, Language, LanguageStats } from "@idiolect/core";

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
const top = (c: Counter, n = 6) => Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
export function percentile(h: Histogram, p: number): number {
  const entries = Object.entries(h).map(([k, v]) => [Number(k), v] as const).sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((n, [, v]) => n + v, 0);
  let acc = 0;
  for (const [k, v] of entries) { acc += v; if (acc >= total * p) return k; }
  return 0;
}

export function summarizeLanguage(lang: Language, s: LanguageStats): string {
  const f = s.functions, n = s.naming, c = s.comments, e = s.errors, k = s.kotlin, t = s.typescript, py = s.python, g = s.go;
  const perKloc = (x: number) => (s.loc ? ((1000 * x) / s.loc).toFixed(1) : "0");
  const NAMES: Record<Language, string> = { kotlin: "Kotlin", typescript: "TypeScript", python: "Python", go: "Go" };
  const errors: Record<Language, string> = {
    kotlin: `try ${perKloc(e.tryCatch)}, runCatching ${perKloc(e.runCatching)}, Result ${perKloc(e.resultType)}, !! ${perKloc(e.forceUnwrap)}`,
    typescript: `try ${perKloc(e.tryCatch)}, non-null ! ${perKloc(e.forceUnwrap)}, any ${perKloc(t.anyTypes)}`,
    python: `try ${perKloc(e.tryCatch)}, bare except ${perKloc(py.bareExcepts)}`,
    go: `err != nil ${perKloc(g.errChecks)}, panic ${perKloc(g.panics)}, unchecked assertions ${perKloc(e.forceUnwrap)}`,
  };
  const idioms: Record<Language, string> = {
    kotlin: `when3 ${k.when3} vs if-chain3 ${k.ifElseChain3}, sealed interface ${k.sealedInterface} vs class ${k.sealedClass}, extension fns ${k.extensionFunctions}, data classes ${k.dataClasses}, composables ${k.composables}, remember ${k.remember}`,
    typescript: `arrow fns ${t.arrowFunctions} vs declarations ${t.functionDeclarations}, type aliases ${t.typeAliases} vs interfaces ${t.interfaces}, optional chains ${t.optionalChains}`,
    python: `type hinted ${pct(py.typeHinted, f.count)}, f-strings ${py.fStrings} vs format ${py.formatCalls}, comprehensions ${py.comprehensions}, dataclasses ${py.dataclasses}`,
    go: `structs ${g.structs}, interfaces ${g.interfaces}, named returns ${pct(g.namedReturns, f.count)}`,
  };
  const comments = c.line + c.block + c.doc;
  return [
    `${NAMES[lang]}  ${s.files} files, ${s.loc} owned lines`,
    `  functions   ${f.count} (${pct(f.expressionBody, f.count)} expression body), length p50 ${percentile(f.lengthLines, 0.5)} p90 ${percentile(f.lengthLines, 0.9)}, params p90 ${percentile(f.params, 0.9)}, nesting p90 ${percentile(f.maxNesting, 0.9)}, early return ${pct(f.earlyReturn, f.blockBody)}`,
    `  naming      fn ${top(n.casing.function, 3)} | class ${top(n.casing.class, 2)} | const ${top(n.casing.constant, 2)} | abbreviations ${pct(n.abbreviated, n.identifiers)}`,
    `  verbs       ${top(n.functionVerb, 8)}`,
    `  booleans    ${top(n.booleanPrefix, 5)}`,
    `  tests       ${s.tests.files} files, ${s.tests.functions} test fns, names ${top(n.testNames, 3)}`,
    `  comments    ${comments} (${c.doc} doc), ${s.loc ? ((100 * comments) / s.loc).toFixed(1) : 0} per 100 lines, avg ${comments ? Math.round(c.chars / comments) : 0} chars, lowercase start ${pct(c.lowercaseStart, comments)}, trailing period ${pct(c.trailingPeriod, comments)}, todo ${top(c.todo, 3)}`,
    `  docs        public ${pct(c.publicDocumented, c.publicDecls)} of ${c.publicDecls}, private ${pct(c.privateDocumented, c.privateDecls)} of ${c.privateDecls}`,
    `  errors/kloc ${errors[lang]}`,
    `  idioms      ${idioms[lang]}`,
  ].join("\n");
}

export function summarizeCommits(s: CommitStats): string {
  return `Commits ${s.count}  subject p50 ${percentile(s.subjectLength, 0.5)} chars, lowercase ${pct(s.lowercaseStart, s.count)}, conventional ${pct(s.conventionalPrefix, s.count)}, trailing period ${pct(s.trailingPeriod, s.count)}, with body ${pct(s.withBody, s.count)}, tense ${top(s.tense, 3)}`;
}
