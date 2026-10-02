import type { Node } from "web-tree-sitter";
import { analyzeTree, bump, commentText, countComment, countCommentText, countName, firstWord, GENERIC_NAME, testNameStyle, type AnalyzeOptions, type LanguageStats, type NameKind } from "./analyzer.js";
import type { LineRange } from "./collector.js";

const NEST = new Set(["if_statement", "for_statement", "expression_switch_statement", "type_switch_statement", "select_statement", "func_literal"]);
const DECLS = new Set(["function_declaration", "method_declaration", "type_declaration", "var_declaration", "const_declaration", "package_clause"]);

export const analyzeGo = (code: string, owned?: LineRange[], opts: AnalyzeOptions = {}) => analyzeTree(code, "go", count, owned, opts);

const field = (n: Node, name: string) => n.childForFieldName(name);
const exported = (id: string) => /^[A-Z]/.test(id);

function count(n: Node, s: LanguageStats, test: boolean) {
  switch (n.type) {
    case "function_declaration": case "method_declaration": return countFunction(n, s, test);
    case "type_spec": {
      const id = field(n, "name")?.text, type = field(n, "type");
      if (type?.type === "struct_type") s.go.structs++;
      if (type?.type === "interface_type") s.go.interfaces++;
      countName(id, "class", s);
      return countDoc(n.parent!, id, s);
    }
    case "const_spec": case "var_spec": {
      const id = field(n, "name")?.text;
      const top = n.parent?.parent?.type === "source_file";
      countName(id, top ? (n.type === "const_spec" ? "constant" : "property") : "local", s);
      if (top) countDoc(n.parent!, id, s);
      return;
    }
    case "short_var_declaration": {
      for (const c of field(n, "left")?.namedChildren ?? []) if (c?.type === "identifier" && c.text !== "_") countName(c.text, "local", s);
      return;
    }
    case "field_declaration": {
      const id = field(n, "name")?.text;
      countName(id, "property", s);
      if (id && field(n, "type")?.text === "bool") bump(s.naming.booleanPrefix, firstWord(id));
      return;
    }
    case "parameter_declaration": {
      const id = field(n, "name")?.text;
      if (id && n.parent?.parent?.type !== "method_elem") countName(id, "parameter", s);
      return;
    }
    case "comment": {
      // Go doc comments are plain // comments above a declaration, so they count as doc, not line
      if (!isGoDocComment(n)) return countComment(n, s);
      s.comments.doc++;
      return countCommentText(commentText(n.text), s);
    }
    case "if_statement": if (/\berr\s*!=\s*nil\b/.test(field(n, "condition")?.text ?? "")) s.go.errChecks++; return;
    case "type_assertion_expression": {
      // v, ok := x.(T) is checked, anything else can panic
      const list = n.parent;
      const lhs = list?.parent?.childForFieldName("left");
      if (!(list?.type === "expression_list" && lhs?.namedChildren.length === 2)) s.errors.forceUnwrap++;
      return;
    }
    case "call_expression": if (field(n, "function")?.text === "panic") s.go.panics++; return;
  }
}

function countFunction(n: Node, s: LanguageStats, test: boolean) {
  const f = s.functions;
  f.count++;
  const fname = field(n, "name")?.text;
  if (test) { s.tests.functions++; if (fname) bump(s.naming.testNames, testNameStyle(fname)); }
  else { countName(fname, "function", s); if (fname && GENERIC_NAME.test(fname)) s.naming.genericNames++; }
  if (fname && !test) bump(s.naming.functionVerb, firstWord(fname));
  countDoc(n, fname, s);

  bump(f.params, field(n, "parameters")?.namedChildren.length ?? 0);
  const result = field(n, "result");
  if (result?.type === "parameter_list" && result.namedChildren.some((c) => c?.childForFieldName("name"))) s.go.namedReturns++;
  if (fname && !test && result?.text === "bool") bump(s.naming.booleanPrefix, firstWord(fname));

  const body = field(n, "body");
  if (!body) return;
  f.blockBody++;
  bump(f.lengthLines, n.endPosition.row - n.startPosition.row + 1);
  let maxDepth = 0;
  let early = false;
  const walk = (x: Node, depth: number, inner: boolean) => {
    if (x.type === "return_statement" && depth > 0 && !inner) early = true;
    const d = NEST.has(x.type) ? depth + 1 : depth;
    maxDepth = Math.max(maxDepth, d);
    for (const c of x.namedChildren) if (c) walk(c, d, inner || x.type === "func_literal");
  };
  walk(body, 0, false);
  bump(f.maxNesting, maxDepth);
  if (early) f.earlyReturn++;
}

/** Top-level declarations only. Exported means public. The doc comment is the comment block ending on the line above. */
function countDoc(decl: Node, id: string | undefined, s: LanguageStats) {
  if (decl.parent?.type !== "source_file" || !id) return;
  const isPrivate = !exported(id);
  let prev = decl.previousNamedSibling;
  let documented = false;
  let row = decl.startPosition.row;
  while (prev?.type === "comment" && prev.endPosition.row === row - 1) {
    documented = true;
    row = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  s.comments[isPrivate ? "privateDecls" : "publicDecls"]++;
  if (documented) s.comments[isPrivate ? "privateDocumented" : "publicDocumented"]++;
}

/** Comments that sit right above a top-level declaration are its doc, Go has no separate syntax for that. */
export function isGoDocComment(n: Node): boolean {
  if (n.parent?.type !== "source_file") return false;
  let next = n.nextNamedSibling;
  let row = n.endPosition.row;
  while (next?.type === "comment" && next.startPosition.row === row + 1) { row = next.endPosition.row; next = next.nextNamedSibling; }
  return !!next && DECLS.has(next.type) && next.startPosition.row === row + 1;
}
