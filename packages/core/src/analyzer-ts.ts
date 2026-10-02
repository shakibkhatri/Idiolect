import type { Node } from "web-tree-sitter";
import { analyzeTree, bump, countComment, countName, firstWord, GENERIC_NAME, grammarFor, type AnalyzeOptions, type LanguageStats, type NameKind } from "./analyzer.js";
import type { LineRange } from "./collector.js";

const FUNCTION_LIKE = new Set(["function_declaration", "generator_function_declaration", "function_expression", "arrow_function", "method_definition"]);
const NEST = new Set(["if_statement", "switch_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "try_statement", "arrow_function", "function_expression"]);
const LITERAL = new Set(["string", "number", "template_string", "true", "false", "null", "array", "object", "regex"]);
const TYPE_DECLS = new Set(["class_declaration", "abstract_class_declaration", "interface_declaration", "type_alias_declaration", "enum_declaration"]);

export const analyzeTypeScript = (code: string, owned?: LineRange[], opts: AnalyzeOptions = {}) => analyzeTree(code, grammarFor("typescript", opts.path), count, owned, opts);

const field = (n: Node, name: string) => n.childForFieldName(name);
const isBoolean = (type: Node | null, value: Node | null) => type?.namedChildren[0]?.text === "boolean" || value?.type === "true" || value?.type === "false";
/** The statement a declaration sits in: its export wrapper when exported, so docs and scope are read from the right node. */
const statementOf = (n: Node) => (n.parent?.type === "export_statement" ? n.parent : n);
const isModuleLevel = (n: Node) => statementOf(n).parent?.type === "program";

function count(n: Node, s: LanguageStats, test: boolean) {
  switch (n.type) {
    case "function_declaration": case "generator_function_declaration":
      s.typescript.functionDeclarations++;
      return countFunction(n, n, field(n, "name")?.text, s, test);
    case "method_definition": {
      // a constructor is not a name the developer chose
      const fname = field(n, "name")?.text;
      return countFunction(n, n, fname === "constructor" ? undefined : fname, s, test);
    }
    case "arrow_function": case "function_expression": {
      // only named ones count as functions: a callback passed to a call is a lambda, like Kotlin's lambda_literal
      const p = n.parent;
      if (p?.type !== "variable_declarator" && p?.type !== "public_field_definition") return;
      if (n.type === "arrow_function") s.typescript.arrowFunctions++;
      return countFunction(n, p.type === "variable_declarator" ? p.parent! : p, field(p, "name")?.text, s, test);
    }
    case "variable_declarator": {
      const decl = n.parent;
      if (!decl || (decl.type !== "lexical_declaration" && decl.type !== "variable_declaration")) return;
      const id = field(n, "name"), value = field(n, "value");
      if (id?.type !== "identifier" || (value && FUNCTION_LIKE.has(value.type))) return;
      const top = isModuleLevel(decl);
      const kind: NameKind = !top ? "local" : decl.firstChild?.text === "const" && value && LITERAL.has(value.type) ? "constant" : "property";
      countName(id.text, kind, s);
      if (isBoolean(field(n, "type"), value)) bump(s.naming.booleanPrefix, firstWord(id.text));
      if (top) countDoc(decl, s);
      return;
    }
    case "public_field_definition": {
      const id = field(n, "name")?.text, value = field(n, "value");
      if (value && FUNCTION_LIKE.has(value.type)) return;
      countName(id, "property", s);
      if (id && isBoolean(field(n, "type"), value)) bump(s.naming.booleanPrefix, firstWord(id));
      return countDoc(n, s);
    }
    case "required_parameter": case "optional_parameter": case "rest_parameter": {
      const pattern = field(n, "pattern");
      if (pattern?.type === "identifier") countName(pattern.text, "parameter", s);
      return;
    }
    case "comment": return countComment(n, s);
    case "try_statement": s.errors.tryCatch++; return;
    case "non_null_expression": s.errors.forceUnwrap++; return;
    case "optional_chain": s.typescript.optionalChains++; return;
    case "predefined_type": if (n.text === "any") s.typescript.anyTypes++; return;
    default:
      if (TYPE_DECLS.has(n.type)) {
        if (n.type === "interface_declaration") s.typescript.interfaces++;
        if (n.type === "type_alias_declaration") s.typescript.typeAliases++;
        countName(field(n, "name")?.text, "class", s);
        countDoc(n, s);
      }
  }
}

/** `anchor` is the node whose lines and doc comment belong to the function: the const declaration for an arrow. */
function countFunction(n: Node, anchor: Node, fname: string | undefined, s: LanguageStats, test: boolean) {
  const f = s.functions;
  f.count++;
  if (test) { s.tests.functions++; if (fname) bump(s.naming.testNames, fname.split(/(?=[A-Z])|_/).length >= 4 ? "camelSentence" : "camel"); }
  else { countName(fname, "function", s); if (fname && GENERIC_NAME.test(fname)) s.naming.genericNames++; }
  if (fname && !test) bump(s.naming.functionVerb, firstWord(fname));
  countDoc(anchor, s);

  const params = field(n, "parameters")?.namedChildren.length ?? (field(n, "parameter") ? 1 : 0);
  bump(f.params, params);
  if (fname && !test && field(n, "return_type")?.namedChildren[0]?.text === "boolean") bump(s.naming.booleanPrefix, firstWord(fname));

  const body = field(n, "body");
  if (!body) return;
  if (body.type !== "statement_block") { f.expressionBody++; return; }
  f.blockBody++;
  bump(f.lengthLines, anchor.endPosition.row - anchor.startPosition.row + 1);
  let maxDepth = 0;
  let early = false;
  const walk = (x: Node, depth: number, inner: boolean) => {
    if (x.type === "function_declaration" || x.type === "method_definition") return;
    if (x.type === "return_statement" && depth > 0 && !inner) early = true;
    const d = NEST.has(x.type) ? depth + 1 : depth;
    maxDepth = Math.max(maxDepth, d);
    for (const c of x.namedChildren) if (c) walk(c, d, inner || FUNCTION_LIKE.has(x.type));
  };
  walk(body, 0, false);
  bump(f.maxNesting, maxDepth);
  if (early) f.earlyReturn++;
}

/** Module level: exported is public, the rest is private to the file. Class members: private or protected modifier. */
function countDoc(n: Node, s: LanguageStats) {
  const stmt = statementOf(n);
  const scope = stmt.parent?.type;
  if (scope !== "program" && scope !== "class_body") return;
  const isPrivate = scope === "program" ? stmt.type !== "export_statement" : n.namedChildren.some((c) => c?.type === "accessibility_modifier" && c.text !== "public");
  const prev = stmt.previousNamedSibling;
  const documented = prev?.type === "comment" && prev.text.startsWith("/**");
  s.comments[isPrivate ? "privateDecls" : "publicDecls"]++;
  if (documented) s.comments[isPrivate ? "privateDocumented" : "publicDocumented"]++;
}
