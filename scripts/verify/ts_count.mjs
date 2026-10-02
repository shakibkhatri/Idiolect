// Independent TypeScript counts via the TypeScript compiler API, same definitions as idiolect's analyzer.
import ts from "../../node_modules/typescript/lib/typescript.js";
import { readFileSync } from "node:fs";

const out = { files: 0, functions: 0, params: {}, classes: 0, comments: 0, doc: 0, tryCatch: 0, forceUnwrap: 0, arrowFunctions: 0, functionDeclarations: 0, typeAliases: 0, interfaces: 0, optionalChains: 0, anyTypes: 0, publicDecls: 0, publicDocumented: 0, privateDecls: 0, privateDocumented: 0 };
const bump = (h, k) => { h[k] = (h[k] ?? 0) + 1; };
const FUNC_LIKE = new Set([ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.MethodDeclaration]);

for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  out.files++;
  // comments: leading and trailing ranges of every node, deduped by position
  const seen = new Set();
  const comment = (r) => { if (seen.has(r.pos)) return; seen.add(r.pos); out.comments++; if (src.slice(r.pos, r.pos + 3) === "/**") out.doc++; };
  const collect = (node) => {
    for (const r of ts.getLeadingCommentRanges(src, node.getFullStart()) ?? []) comment(r);
    for (const r of ts.getTrailingCommentRanges(src, node.getEnd()) ?? []) comment(r);
    ts.forEachChild(node, collect);
  };
  collect(sf);
  for (const r of ts.getLeadingCommentRanges(src, sf.endOfFileToken.getFullStart()) ?? []) comment(r);
  const documented = (node) => (ts.getLeadingCommentRanges(src, node.getFullStart()) ?? []).some((r) => src.slice(r.pos, r.pos + 3) === "/**");
  const isExported = (node) => !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
  const decl = (stmt, isPrivate) => { out[isPrivate ? "privateDecls" : "publicDecls"]++; if (documented(stmt)) out[isPrivate ? "privateDocumented" : "publicDocumented"]++; };
  const fn = (node, name) => {
    out.functions++;
    bump(out.params, node.parameters.length);
  };
  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.FunctionDeclaration: out.functionDeclarations++; fn(node); break;
      case ts.SyntaxKind.MethodDeclaration: case ts.SyntaxKind.Constructor: case ts.SyntaxKind.GetAccessor: case ts.SyntaxKind.SetAccessor: fn(node); break;
      case ts.SyntaxKind.ArrowFunction: case ts.SyntaxKind.FunctionExpression:
        if (ts.isVariableDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent)) { if (node.kind === ts.SyntaxKind.ArrowFunction) out.arrowFunctions++; fn(node); }
        break;
      case ts.SyntaxKind.ClassDeclaration: case ts.SyntaxKind.InterfaceDeclaration: case ts.SyntaxKind.TypeAliasDeclaration: case ts.SyntaxKind.EnumDeclaration:
        out.classes++;
        if (node.kind === ts.SyntaxKind.InterfaceDeclaration) out.interfaces++;
        if (node.kind === ts.SyntaxKind.TypeAliasDeclaration) out.typeAliases++;
        break;
      case ts.SyntaxKind.TryStatement: out.tryCatch++; break;
      case ts.SyntaxKind.NonNullExpression: out.forceUnwrap++; break;
      case ts.SyntaxKind.AnyKeyword: out.anyTypes++; break;
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken) out.optionalChains++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // module level: exported is public, the rest is private to the file; class members by modifier
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) decl(st, !isExported(st));
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) decl(st, !isExported(st));
    if (ts.isClassDeclaration(st)) for (const m of st.members) {
      if (ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m) || ts.isConstructorDeclaration(m)) {
        if (ts.isPropertyDeclaration(m) && m.initializer && FUNC_LIKE.has(m.initializer.kind)) continue;
        decl(m, !!(ts.getCombinedModifierFlags(m) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)));
      }
    }
  }
}
console.log(JSON.stringify(out));
