import type { Commit, LineRange } from "./collector.js";
import { parse } from "./parser.js";
import { redact } from "./redact.js";

export type Sample = { file: string; line: number; text: string };
export type Samples = { functions: Sample[]; comments: Sample[]; commits: Sample[] };
export type SampleInput = { path: string; code: string; ranges?: LineRange[]; test?: boolean };
export type SampleOptions = { maxTokens: number; functions?: number; comments?: number; commits?: number };

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Stratified, deterministic samples of the developer's own code for the profile writer. Production functions only, comments from everywhere. */
export async function collectSamples(files: SampleInput[], commits: Commit[], opts: SampleOptions): Promise<Samples> {
  const functions: Sample[] = [];
  const comments: Sample[] = [];
  for (const f of files) {
    const tree = await parse(f.code, "kotlin");
    const owned = (row: number) => !f.ranges || f.ranges.some((r) => r.start <= row + 1 && row + 1 <= r.end);
    const walk = (n: import("web-tree-sitter").Node) => {
      const row = n.startPosition.row;
      const lines = n.endPosition.row - row + 1;
      if (n.type === "function_declaration" && !f.test && owned(row) && lines >= 3 && lines <= 40 && n.text.includes("{")) functions.push({ file: f.path, line: row + 1, text: n.text });
      else if ((n.type === "line_comment" || n.type === "block_comment") && owned(row)) comments.push({ file: f.path, line: row + 1, text: n.text });
      for (const c of n.namedChildren) if (c) walk(c);
    };
    walk(tree.rootNode);
    tree.delete();
  }
  const commitSamples = commits.map((c) => ({ file: "commit", line: 0, text: c.body ? `${c.subject}\n\n${c.body}` : c.subject }));

  const budget = { left: opts.maxTokens };
  const take = (xs: Sample[], max: number) => {
    const out: Sample[] = [];
    for (const x of shuffle(xs)) {
      if (out.length >= max) break;
      const text = redact(x.text);
      const cost = estimateTokens(text);
      if (cost > budget.left) continue;
      budget.left -= cost;
      out.push({ ...x, text });
    }
    return out;
  };
  return { commits: take(commitSamples, opts.commits ?? 100), comments: take(comments, opts.comments ?? 100), functions: take(functions, opts.functions ?? 30) };
}

// deterministic order so dry-run and the real call send the same samples
function shuffle<T extends Sample>(xs: T[]): T[] {
  return [...xs].sort((a, b) => hash(`${a.file}:${a.line}:${a.text.length}`) - hash(`${b.file}:${b.line}:${b.text.length}`));
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
