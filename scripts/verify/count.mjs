// Sums idiolect analyzer stats over whole files (no blame ranges) so they can be diffed against an independent counter.
import { analyze, emptyStats, mergeStats, isTestPath } from "../../packages/core/dist/index.js";
import { readFileSync } from "node:fs";
const [lang, ...files] = process.argv.slice(2);
let s = emptyStats();
for (const f of files) s = mergeStats(s, await analyze(readFileSync(f, "utf8"), lang, undefined, { test: isTestPath(f), path: f }));
const sum = (h) => Object.values(h).reduce((a, b) => a + b, 0);
const out = { files: s.files, loc: s.loc, functions: s.functions.count, blockBody: s.functions.blockBody, params: s.functions.params, earlyReturn: s.functions.earlyReturn, classes: sum(s.naming.casing.class), comments: s.comments.line + s.comments.block + s.comments.doc, doc: s.comments.doc, tryCatch: s.errors.tryCatch, forceUnwrap: s.errors.forceUnwrap, publicDecls: s.comments.publicDecls, publicDocumented: s.comments.publicDocumented, privateDecls: s.comments.privateDecls, privateDocumented: s.comments.privateDocumented, testFunctions: s.tests.functions };
if (lang === "python") Object.assign(out, s.python);
if (lang === "typescript") Object.assign(out, s.typescript);
if (lang === "kotlin") Object.assign(out, s.kotlin);
if (lang === "go") Object.assign(out, s.go);
console.log(JSON.stringify(out));
