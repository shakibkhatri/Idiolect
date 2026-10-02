import type { Node } from "web-tree-sitter";
import type { Commit, LineRange } from "./collector.js";
import { parse } from "./parser.js";

// All stats are counts or histograms (value -> count). Merging is a plain sum, ratios and percentiles are derived at render time.
export type Histogram = Record<string, number>;
export type Counter = Record<string, number>;
export type NameKind = "function" | "class" | "property" | "local" | "parameter" | "constant";
export type Casing = "camel" | "pascal" | "snake" | "screaming" | "backtick" | "other";

export type LanguageStats = {
  files: number;
  loc: number;
  functions: { count: number; blockBody: number; expressionBody: number; lengthLines: Histogram; params: Histogram; maxNesting: Histogram; earlyReturn: number };
  naming: { casing: Record<NameKind, Record<Casing, number>>; nameLength: Record<NameKind, Histogram>; functionVerb: Counter; booleanPrefix: Counter; abbreviated: number; identifiers: number; testNames: Counter; genericNames: number };
  tests: { files: number; loc: number; functions: number };
  comments: { line: number; block: number; doc: number; chars: number; lowercaseStart: number; trailingPeriod: number; todo: Counter; tells: Counter; publicDecls: number; publicDocumented: number; privateDecls: number; privateDocumented: number };
  errors: { tryCatch: number; runCatching: number; resultType: number; forceUnwrap: number };
  kotlin: { when3: number; ifElseChain3: number; sealedInterface: number; sealedClass: number; extensionFunctions: number; dataClasses: number; composables: number; modifierParamFirst: number; modifierParamLater: number; remember: number };
};

export type CommitStats = { count: number; subjectLength: Histogram; lowercaseStart: number; conventionalPrefix: number; trailingPeriod: number; withBody: number; tense: Counter };

const KINDS: NameKind[] = ["function", "class", "property", "local", "parameter", "constant"];

export function emptyStats(): LanguageStats {
  const perKind = <T>(make: () => T) => Object.fromEntries(KINDS.map((k) => [k, make()])) as Record<NameKind, T>;
  return {
    files: 0,
    loc: 0,
    functions: { count: 0, blockBody: 0, expressionBody: 0, lengthLines: {}, params: {}, maxNesting: {}, earlyReturn: 0 },
    naming: { casing: perKind(() => ({ camel: 0, pascal: 0, snake: 0, screaming: 0, backtick: 0, other: 0 })), nameLength: perKind(() => ({})), functionVerb: {}, booleanPrefix: {}, abbreviated: 0, identifiers: 0, testNames: {}, genericNames: 0 },
    tests: { files: 0, loc: 0, functions: 0 },
    comments: { line: 0, block: 0, doc: 0, chars: 0, lowercaseStart: 0, trailingPeriod: 0, todo: {}, tells: {}, publicDecls: 0, publicDocumented: 0, privateDecls: 0, privateDocumented: 0 },
    errors: { tryCatch: 0, runCatching: 0, resultType: 0, forceUnwrap: 0 },
    kotlin: { when3: 0, ifElseChain3: 0, sealedInterface: 0, sealedClass: 0, extensionFunctions: 0, dataClasses: 0, composables: 0, modifierParamFirst: 0, modifierParamLater: 0, remember: 0 },
  };
}

/** Deep-sums two objects of the same shape. Works for LanguageStats, CommitStats and any nested counter. */
export function mergeStats<T>(a: T, b: T): T {
  if (typeof a === "number") return ((a as number) + ((b as number) ?? 0)) as T;
  const out: Record<string, unknown> = { ...(a as object) };
  for (const [k, v] of Object.entries(b as object)) out[k] = k in out ? mergeStats(out[k], v) : v;
  return out as T;
}

const bump = (h: Histogram, key: string | number, by = 1) => { h[key] = (h[key] ?? 0) + by; };

/** Test files keep structural stats but route function names to `naming.testNames` so sentence-style test names never pollute verb stats. */
export const isTestPath = (path: string) => /(^|\/)(test|androidTest|commonTest|jvmTest|iosTest|unitTest)\/|(Test|Tests|Spec)\.kts?$/.test(path);

export async function analyzeKotlin(code: string, owned?: LineRange[], opts: { test?: boolean } = {}): Promise<LanguageStats> {
  const tree = await parse(code, "kotlin");
  const s = emptyStats();
  s.files = 1;
  const test = !!opts.test;
  if (test) s.tests.files = 1;
  const isOwned = (row: number) => !owned || owned.some((r) => r.start <= row + 1 && row + 1 <= r.end);
  code.split("\n").forEach((l, i) => { if (l.trim() && isOwned(i)) { s.loc++; if (test) s.tests.loc++; } });

  const visit = (n: Node) => {
    if (isOwned(n.startPosition.row)) count(n, s, test);
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(tree.rootNode);
  tree.delete();
  return s;
}

const NEST = new Set(["if_expression", "when_expression", "for_statement", "while_statement", "do_while_statement", "try_expression", "lambda_literal"]);
const TYPE_NODES = new Set(["user_type", "nullable_type", "parenthesized_type"]);

function count(n: Node, s: LanguageStats, test: boolean) {
  switch (n.type) {
    case "function_declaration": return countFunction(n, s, test);
    case "class_declaration": {
      const mods = modifierTexts(n);
      const isInterface = n.children.some((c) => c?.type === "interface");
      if (mods.has("sealed")) s.kotlin[isInterface ? "sealedInterface" : "sealedClass"]++;
      if (mods.has("data")) s.kotlin.dataClasses++;
      countName(name(n), "class", s);
      return countDoc(n, s);
    }
    case "object_declaration": countName(name(n), "class", s); return countDoc(n, s);
    case "property_declaration": {
      const decl = n.namedChildren.find((c) => c?.type === "variable_declaration");
      const id = decl?.namedChildren.find((c) => c?.type === "identifier")?.text;
      const typed = decl?.namedChildren.find((c) => c && TYPE_NODES.has(c.type));
      const kind: NameKind = modifierTexts(n).has("const") ? "constant" : hasAncestor(n, (p) => p.type === "block" || p.type === "lambda_literal") ? "local" : "property";
      countName(id, kind, s);
      if (id && typed?.text === "Boolean") bump(s.naming.booleanPrefix, firstWord(id));
      if (kind !== "local") countDoc(n, s);
      return;
    }
    case "parameter": case "class_parameter": return countName(n.namedChildren[0]?.text, "parameter", s);
    case "line_comment": case "block_comment": return countComment(n, s);
    case "try_expression": s.errors.tryCatch++; return;
    case "unary_expression": if (n.children.some((c) => c?.type === "!!")) s.errors.forceUnwrap++; return;
    case "user_type": if (n.text === "Result" || n.text.startsWith("Result<")) s.errors.resultType++; return;
    case "call_expression": {
      const callee = n.namedChildren[0]?.text ?? "";
      const last = callee.split(".").at(-1) ?? "";
      if (last === "runCatching") s.errors.runCatching++;
      if (/^remember[A-Z]?/.test(last)) s.kotlin.remember++;
      return;
    }
    case "when_expression": if (n.namedChildren.filter((c) => c?.type === "when_entry").length >= 3) s.kotlin.when3++; return;
    case "if_expression": {
      if (n.previousSibling?.type === "else") return; // counted as part of its chain head
      let branches = 1;
      let cur: Node | null = n;
      while (cur) {
        const elseIdx = cur.children.findIndex((c) => c?.type === "else");
        if (elseIdx < 0) break;
        branches++;
        const next: Node | null = cur.children[elseIdx + 1] ?? null;
        cur = next?.type === "if_expression" ? next : null;
      }
      if (branches >= 3) s.kotlin.ifElseChain3++;
      return;
    }
  }
}

function countFunction(n: Node, s: LanguageStats, test: boolean) {
  const f = s.functions;
  f.count++;
  const fname = name(n);
  const prose = test || !!fname?.startsWith("`");
  if (test) { s.tests.functions++; if (fname) bump(s.naming.testNames, testNameStyle(fname)); }
  else { countName(fname, "function", s); if (fname && GENERIC_NAME.test(fname)) s.naming.genericNames++; }
  if (fname && !prose) bump(s.naming.functionVerb, firstWord(fname));
  countDoc(n, s);

  const kids = n.namedChildren.filter((c): c is Node => !!c);
  const nameIdx = kids.findIndex((c) => c.type === "identifier");
  if (kids.slice(0, nameIdx).some((c) => TYPE_NODES.has(c.type))) s.kotlin.extensionFunctions++;

  const paramsNode = kids.find((c) => c.type === "function_value_parameters");
  const params = paramsNode?.namedChildren.filter((c) => c?.type === "parameter") ?? [];
  bump(f.params, params.length);
  const retType = kids[kids.findIndex((c) => c.type === "function_value_parameters") + 1];
  if (fname && !prose && retType && TYPE_NODES.has(retType.type) && retType.text === "Boolean") bump(s.naming.booleanPrefix, firstWord(fname));

  if (modifierTexts(n).has("@Composable")) {
    s.kotlin.composables++;
    const i = params.findIndex((p) => p?.namedChildren[0]?.text === "modifier");
    if (i === 0) s.kotlin.modifierParamFirst++;
    else if (i > 0) s.kotlin.modifierParamLater++;
  }

  const body = kids.find((c) => c.type === "function_body");
  if (!body) return;
  const block = body.namedChildren[0];
  if (block?.type !== "block") { f.expressionBody++; return; }
  f.blockBody++;
  bump(f.lengthLines, n.endPosition.row - n.startPosition.row + 1);
  let maxDepth = 0;
  let early = false;
  const walk = (x: Node, depth: number) => {
    if (x.type === "function_declaration" && x.id !== n.id) return;
    if (x.type === "return_expression" && depth > 0 && x.parent?.type !== "lambda_literal") early = true;
    const d = NEST.has(x.type) ? depth + 1 : depth;
    maxDepth = Math.max(maxDepth, d);
    for (const c of x.namedChildren) if (c) walk(c, d);
  };
  walk(block, 0);
  bump(f.maxNesting, maxDepth);
  if (early) f.earlyReturn++;
}

function countComment(n: Node, s: LanguageStats) {
  const c = s.comments;
  const isDoc = n.text.startsWith("/**");
  if (n.type === "line_comment") c.line++; else if (isDoc) c.doc++; else c.block++;
  const text = commentText(n.text);
  c.chars += text.length;
  const firstLetter = text.match(/[A-Za-z]/)?.[0];
  if (firstLetter && firstLetter === firstLetter.toLowerCase() && /^[a-z]/.test(text)) c.lowercaseStart++;
  if (text.endsWith(".")) c.trailingPeriod++;
  const todo = text.match(TODO_TAG);
  if (todo) bump(c.todo, `${todo[1]}${todo[2] ? "(x)" : ""}${todo[3] ? ":" : ""}`);
  if (BUZZWORDS.test(text)) bump(c.tells, "buzzword");
  if (RESTATES.test(text)) bump(c.tells, "restates");
  if (EMOJI.test(text)) bump(c.tells, "emoji");
}

/** Comment body without the // or /** markers and leading asterisks, joined to one line. */
export const commentText = (raw: string) => raw
  .replace(/^\/\*\*?|\*\/$/g, "").replace(/^\/\/+/, "")
  .split("\n").map((l) => l.replace(/^\s*\*\s?/, "").trim()).filter(Boolean).join(" ").trim();
export const TODO_TAG = /\b(TODO|FIXME|HACK)\b(\s*\([^)]*\))?(\s*:)?/;
export const RESTATES = /^(this (function|method|class|file|property)|the (function|method) )/i;
export const BUZZWORDS = /\b(robust|seamless(ly)?|leverag(e|es|ing)|comprehensive(ly)?|utiliz(e|es|ing)|ensur(e|es|ing) that|streamlin(e|ed)|cutting[- ]edge|delve|crucial|facilitat(e|es))\b/i;
export const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2705}\u{274C}]/u;
const GENERIC_NAME = /^(handle|process|manage|do)(Data|Item|Items|Input|Request|Response|Result|Stuff|Logic|It)$|^(helper|util|utility|data|temp|result|value|item)\d*$/i;

function countDoc(n: Node, s: LanguageStats) {
  const parent = n.parent?.type;
  if (parent !== "source_file" && parent !== "class_body" && parent !== "enum_class_body") return;
  const mods = modifierTexts(n);
  const isPrivate = mods.has("private") || mods.has("internal") || mods.has("protected");
  const prev = n.previousNamedSibling;
  const documented = prev?.type === "block_comment" && prev.text.startsWith("/**");
  s.comments[isPrivate ? "privateDecls" : "publicDecls"]++;
  if (documented) s.comments[isPrivate ? "privateDocumented" : "publicDocumented"]++;
}

const SHORT_OK = new Set(["id", "ok", "io", "os", "ui", "db", "to", "in", "is", "at", "by", "of", "on", "or", "up", "as", "an", "it", "if", "no", "dp", "px", "sp", "api", "url", "uri", "key", "max", "min", "sum", "add", "get", "set", "put", "run", "new", "old", "end", "map", "row", "col", "tag", "log", "raw", "all", "has", "can", "use", "ids", "dto", "sdk", "app", "tab", "bar", "top", "box", "fab", "job", "pin", "age", "sub", "pre", "any", "not", "and", "for", "one", "two", "now", "day", "hex", "jwt", "sql", "xml", "css", "ttl", "cpu", "gpu", "ram", "yes", "mid", "low", "big", "red", "dir", "src", "out", "err", "ack", "nav", "arg", "fun", "val", "var", "lhs", "rhs", "pos", "len", "idx"]);

function countName(id: string | undefined, kind: NameKind, s: LanguageStats) {
  if (!id) return;
  const n = s.naming;
  n.identifiers++;
  const c = casing(id);
  n.casing[kind][c]++;
  if (c === "backtick") return;
  bump(n.nameLength[kind], id.length);
  // ponytail: a 2-3 letter camel word outside the allowlist counts as an abbreviation, good enough for a ratio
  if (words(id).some((w) => w.length >= 2 && w.length <= 3 && !SHORT_OK.has(w))) n.abbreviated++;
}

// ponytail: three buckets are enough to say "you write test names as backtick sentences"
function testNameStyle(id: string): string {
  if (id.startsWith("`")) return "backtick";
  if (/_/.test(id)) return "snake";
  return words(id).length >= 4 ? "camelSentence" : "camel";
}

export function casing(id: string): Casing {
  if (id.startsWith("`")) return "backtick";
  const x = id.replace(/^_+/, "");
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(x) || (/^[A-Z]{2,}$/.test(x))) return "screaming";
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(x)) return "snake";
  if (/^[a-z][a-zA-Z0-9]*$/.test(x)) return "camel";
  if (/^[A-Z][a-zA-Z0-9]*$/.test(x)) return "pascal";
  return "other";
}

const words = (id: string) => id.replace(/^_+/, "").split(/(?=[A-Z])|_/).map((w) => w.toLowerCase()).filter(Boolean);
const firstWord = (id: string) => words(id)[0] ?? id;
const name = (n: Node) => n.namedChildren.find((c) => c?.type === "identifier")?.text;
const modifierTexts = (n: Node) => new Set(n.namedChildren.find((c) => c?.type === "modifiers")?.namedChildren.map((c) => c?.text ?? "") ?? []);
function hasAncestor(n: Node, pred: (p: Node) => boolean) {
  for (let p = n.parent; p; p = p.parent) if (pred(p)) return true;
  return false;
}

const CONVENTIONAL = /^(feat|fix|chore|docs|refactor|test|style|perf|build|ci|revert)(\([^)]+\))?!?:\s/i;

export function analyzeCommits(commits: Commit[]): CommitStats {
  const s: CommitStats = { count: 0, subjectLength: {}, lowercaseStart: 0, conventionalPrefix: 0, trailingPeriod: 0, withBody: 0, tense: {} };
  for (const c of commits) {
    s.count++;
    bump(s.subjectLength, c.subject.length);
    const conventional = CONVENTIONAL.test(c.subject);
    if (conventional) s.conventionalPrefix++;
    const rest = conventional ? c.subject.replace(CONVENTIONAL, "") : c.subject;
    if (/^[a-z]/.test(rest)) s.lowercaseStart++;
    if (c.subject.endsWith(".")) s.trailingPeriod++;
    if (c.body) s.withBody++;
    const verb = rest.split(/\s+/)[0]?.toLowerCase() ?? "";
    // ponytail: suffix heuristic, "added" past, "adds" third person, else imperative
    bump(s.tense, /ed$/.test(verb) ? "past" : /[^s]s$/.test(verb) ? "thirdPerson" : "imperative");
  }
  return s;
}
