import type { Node } from "web-tree-sitter";
import { analyzeTree, bump, countComment, countCommentText, countName, firstWord, GENERIC_NAME, type AnalyzeOptions, type LanguageStats, type NameKind } from "./analyzer.js";
import type { LineRange } from "./collector.js";

const NEST = new Set(["if_statement", "for_statement", "while_statement", "try_statement", "with_statement", "match_statement", "lambda"]);
const LITERAL = new Set(["string", "concatenated_string", "integer", "float", "true", "false", "none", "list", "tuple", "dictionary", "set"]);
const COMPREHENSIONS = new Set(["list_comprehension", "dictionary_comprehension", "set_comprehension", "generator_expression"]);
const PARAMS = new Set(["identifier", "typed_parameter", "default_parameter", "typed_default_parameter", "list_splat_pattern", "dictionary_splat_pattern"]);

export const analyzePython = (code: string, owned?: LineRange[], opts: AnalyzeOptions = {}) => analyzeTree(code, "python", count, owned, opts);

const field = (n: Node, name: string) => n.childForFieldName(name);
const isPrivateName = (id: string) => id.startsWith("_") && !id.startsWith("__");
/** A decorated definition is one statement, so docs and scope are read from the wrapper. */
const statementOf = (n: Node) => (n.parent?.type === "decorated_definition" ? n.parent : n);
const isModuleLevel = (n: Node) => statementOf(n).parent?.type === "module";
const docstring = (body: Node | null) => {
  const first = body?.namedChildren[0];
  return first?.type === "expression_statement" && first.namedChildren[0]?.type === "string" ? first.namedChildren[0] : undefined;
};
export const docstringText = (raw: string) => raw.replace(/^[a-zA-Z]*("""|\'\'\'|"|')|("""|\'\'\'|"|')$/g, "").split("\n").map((l) => l.trim()).filter(Boolean).join(" ");

function count(n: Node, s: LanguageStats, test: boolean) {
  switch (n.type) {
    case "module": { const d = docstring(n); if (d) { s.comments.doc++; countCommentText(docstringText(d.text), s); } return; }
    case "function_definition": return countFunction(n, s, test);
    case "class_definition": {
      countName(field(n, "name")?.text, "class", s);
      if (n.parent?.type === "decorated_definition" && n.parent.namedChildren.some((c) => c?.type === "decorator" && /\bdataclass\b/.test(c.text))) s.python.dataclasses++;
      return countDoc(n, field(n, "name")?.text, docstring(field(n, "body")), s);
    }
    case "assignment": {
      if (n.parent?.type !== "expression_statement") return;
      const left = field(n, "left"), right = field(n, "right");
      // self.x = ... in a method is a property, a bare name is a local, module level is a constant when it holds a literal
      if (left?.type === "attribute" && left.namedChildren[0]?.text === "self") {
        const id = left.namedChildren[1]?.text;
        countName(id, "property", s);
        if (id && (right?.type === "true" || right?.type === "false")) bump(s.naming.booleanPrefix, firstWord(id));
        return;
      }
      if (left?.type !== "identifier") return;
      const scope = n.parent.parent?.type;
      const kind: NameKind = scope === "module" ? (right && LITERAL.has(right.type) ? "constant" : "property") : scope === "block" && n.parent.parent?.parent?.type === "class_definition" ? "property" : "local";
      countName(left.text, kind, s);
      if (right?.type === "true" || right?.type === "false" || field(n, "type")?.text === "bool") bump(s.naming.booleanPrefix, firstWord(left.text));
      if (kind !== "local") countDoc(n.parent, left.text, undefined, s);
      return;
    }
    case "comment": return countComment(n, s);
    case "try_statement": s.errors.tryCatch++; return;
    case "except_clause": if (n.namedChildren.every((c) => c?.type === "block" || c?.type === "comment")) s.python.bareExcepts++; return;
    case "string": if (/^[a-zA-Z]*[fF]/.test(n.firstChild?.text ?? "")) s.python.fStrings++; return;
    case "call": {
      const fn = field(n, "function");
      if (fn?.type === "attribute" && fn.namedChildren[0]?.type === "string" && fn.namedChildren[1]?.text === "format") s.python.formatCalls++;
      return;
    }
    default: if (COMPREHENSIONS.has(n.type)) s.python.comprehensions++;
  }
}

function countFunction(n: Node, s: LanguageStats, test: boolean) {
  const f = s.functions;
  f.count++;
  const fname = field(n, "name")?.text;
  const magic = !!fname && fname.startsWith("__");
  // test_x and TestX are the only forms the framework allows, so the name says nothing about the developer
  if (test) s.tests.functions++;
  else if (!magic) { countName(fname, "function", s); if (fname && GENERIC_NAME.test(fname)) s.naming.genericNames++; }
  if (fname && !test && !magic) bump(s.naming.functionVerb, firstWord(fname));
  const body = field(n, "body");
  countDoc(n, fname, docstring(body), s);

  const params = field(n, "parameters")?.namedChildren.filter((c) => c && PARAMS.has(c.type) && c.text !== "self" && c.text !== "cls") ?? [];
  bump(f.params, params.length);
  const ret = field(n, "return_type");
  if (ret || params.some((c) => c!.type.startsWith("typed_"))) s.python.typeHinted++;
  if (fname && !test && ret?.text === "bool") bump(s.naming.booleanPrefix, firstWord(fname));

  if (!body) return;
  f.blockBody++;
  bump(f.lengthLines, n.endPosition.row - n.startPosition.row + 1);
  let maxDepth = 0;
  let early = false;
  const walk = (x: Node, depth: number, inner: boolean) => {
    if (x.type === "function_definition" || x.type === "class_definition") return;
    if (x.type === "return_statement" && depth > 0 && !inner) early = true;
    const d = NEST.has(x.type) ? depth + 1 : depth;
    maxDepth = Math.max(maxDepth, d);
    for (const c of x.namedChildren) if (c) walk(c, d, inner || x.type === "lambda");
  };
  walk(body, 0, false);
  bump(f.maxNesting, maxDepth);
  if (early) f.earlyReturn++;
}

/** Module and class level only. A leading underscore makes it private, a docstring documents it. */
function countDoc(n: Node, id: string | undefined, documented: Node | undefined, s: LanguageStats) {
  const stmt = statementOf(n);
  const scope = stmt.parent?.type;
  if (scope !== "module" && !(scope === "block" && stmt.parent?.parent?.type === "class_definition")) return;
  const isPrivate = !!id && isPrivateName(id);
  s.comments[isPrivate ? "privateDecls" : "publicDecls"]++;
  if (documented) { s.comments[isPrivate ? "privateDocumented" : "publicDocumented"]++; s.comments.doc++; countCommentText(docstringText(documented.text), s); }
}
