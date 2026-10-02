import type { Report } from "@shakibkhatri/idiolect-eval";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";

type Quiz = NonNullable<Report["quiz"]>;
type Pick = Quiz["picks"][number];

/** Pairs shown in a random order per task. The page never learns which side is the profile until the quiz is over. */
type Pair = { task: string; prompt: string; a: string; b: string; flip: boolean };

export function pairsOf(report: Report, random = Math.random): Pair[] {
  return report.generations.map((g) => {
    const flip = random() < 0.5;
    return { task: g.task.id, prompt: g.task.prompt, a: flip ? g.without : g.with, b: flip ? g.with : g.without, flip };
  });
}

export function scorePicks(pairs: Pair[], raw: { task: string; pick: string }[]): Quiz {
  const picks: Pick[] = pairs.map((p) => {
    const pick = raw.find((r) => r.task === p.task)?.pick.toUpperCase();
    if (pick !== "A" && pick !== "B") return { task: p.task, picked: "skip" };
    return { task: p.task, picked: (pick === "A") !== p.flip ? "with" : "without" };
  });
  const answered = picks.filter((p) => p.picked !== "skip");
  const withWins = answered.filter((p) => p.picked === "with").length;
  return { withWins, total: answered.length, winRate: answered.length ? withWins / answered.length : 0, picks };
}

/** Serves the quiz page on localhost, opens the browser, resolves when the last pair is answered. */
export function webQuiz(report: Report, log: (s: string) => void = (s) => process.stderr.write(`${s}\n`)): Promise<Quiz> {
  const pairs = pairsOf(report);
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page(pairs.map(({ task, prompt, a, b }) => ({ task, prompt, a, b }))));
        return;
      }
      if (req.method === "POST" && req.url === "/done") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const quiz = scorePicks(pairs, JSON.parse(body));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(quiz), () => { server.close(); resolve(quiz); });
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/`;
      log(`quiz: ${url} (opening your browser, keys A, B and S)`);
      openBrowser(url);
    });
  });
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd, args, () => {});
}

/** The terminal quiz, for a shell without a browser. */
export async function ttyQuiz(report: Report): Promise<Quiz> {
  const pairs = pairsOf(report);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const raw: { task: string; pick: string }[] = [];
  try {
    for (const p of pairs) {
      console.log(`\n==== ${p.task}\n\n--- A\n${p.a.trim()}\n\n--- B\n${p.b.trim()}\n`);
      raw.push({ task: p.task, pick: (await rl.question("Which sounds like you? [A/B/skip]: ")).trim() });
    }
  } finally { rl.close(); }
  return scorePicks(pairs, raw);
}

export function page(pairs: Omit<Pair, "flip">[]): string {
  // the JSON goes through a script tag, so a closing tag inside a sample must not end it early
  const data = JSON.stringify(pairs).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Idiolect quiz</title>
<style>
  :root { --bg: #fff; --fg: #1a1a1a; --dim: #9a9a9a; --line: #e6e6e6; --mark: #fff3bf; --accent: #2f6feb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #e8e8e8; --dim: #6a6a6a; --line: #2a2a2a; --mark: #4a3f10; --accent: #6ea0ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { display: flex; align-items: baseline; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; }
  header .count { color: var(--dim); }
  header .keys { margin-left: auto; color: var(--dim); }
  kbd { border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
  .prompt { padding: 10px 16px; color: var(--dim); white-space: pre-wrap; border-bottom: 1px solid var(--line); font-family: system-ui, sans-serif; }
  .bar { height: 3px; background: var(--line); } .bar i { display: block; height: 100%; background: var(--accent); transition: width .2s; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  td { vertical-align: top; padding: 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
  td + td { border-left: 1px solid var(--line); }
  th { text-align: left; padding: 6px 12px; color: var(--dim); font-weight: 600; border-bottom: 1px solid var(--line); }
  th + th { border-left: 1px solid var(--line); }
  tr.same td { color: var(--dim); }
  tr.diff td.has { background: var(--mark); }
  .choose { display: flex; gap: 12px; padding: 16px; position: sticky; bottom: 0; background: var(--bg); border-top: 1px solid var(--line); }
  button { flex: 1; padding: 12px; font: inherit; font-weight: 600; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.skip { flex: 0 0 120px; color: var(--dim); }
  .done { padding: 24px 16px; max-width: 720px; }
  .done h2 { font-size: 20px; margin: 0 0 8px; }
  .done table { margin-top: 16px; width: auto; } .done td { padding: 4px 24px 4px 0; white-space: normal; border: 0; }
  .with { color: var(--accent); }
</style>
</head>
<body>
<header><h1>Which sounds like you?</h1><span class="count" id="count"></span><span class="keys"><kbd>A</kbd> left <kbd>B</kbd> right <kbd>S</kbd> skip</span></header>
<div class="bar"><i id="bar"></i></div>
<div id="root"></div>
<script id="data" type="application/json">${data}</script>
<script>
var pairs = JSON.parse(document.getElementById("data").textContent);
var picks = [], i = 0;
var root = document.getElementById("root");

// longest common subsequence over lines, so shared code is dimmed and only the differences stand out
function align(a, b) {
  var n = a.length, m = b.length, dp = [];
  for (var x = 0; x <= n; x++) { dp.push(new Array(m + 1).fill(0)); }
  // blank lines do not anchor the alignment, otherwise two unrelated paragraphs line up on their gaps
  function same(x, y) { return a[x] === b[y] && a[x].trim() !== ""; }
  for (var x = n - 1; x >= 0; x--) for (var y = m - 1; y >= 0; y--) dp[x][y] = same(x, y) ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
  var rows = [], x = 0, y = 0, da = [], db = [];
  // a run of changed lines is zipped so both versions of a paragraph sit on the same rows
  function flush() { for (var k = 0; k < Math.max(da.length, db.length); k++) { var l = k < da.length ? da[k] : null, r = k < db.length ? db[k] : null; rows.push([l, r, l === r]); } da = []; db = []; }
  while (x < n || y < m) {
    if (x < n && y < m && same(x, y)) { flush(); rows.push([a[x++], b[y++], true]); }
    else if (y < m && (x >= n || dp[x][y + 1] >= dp[x + 1][y])) { db.push(b[y++]); }
    else { da.push(a[x++]); }
  }
  flush();
  return rows;
}
function esc(s) { return s.replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
function cell(s) { return s === null ? "<td></td>" : "<td class=\\"has\\">" + (esc(s) || " ") + "</td>"; }

function show() {
  var p = pairs[i];
  document.getElementById("count").textContent = (i + 1) + " / " + pairs.length + "  " + p.task;
  document.getElementById("bar").style.width = (100 * i / pairs.length) + "%";
  var rows = align(p.a.trim().split("\\n"), p.b.trim().split("\\n"));
  var html = "<div class=\\"prompt\\">" + esc(p.prompt) + "</div><table><tr><th>A</th><th>B</th></tr>";
  for (var r = 0; r < rows.length; r++) html += "<tr class=\\"" + (rows[r][2] ? "same" : "diff") + "\\">" + cell(rows[r][0]) + cell(rows[r][1]) + "</tr>";
  html += "</table><div class=\\"choose\\"><button onclick=\\"pick('A')\\">A sounds like me</button><button class=\\"skip\\" onclick=\\"pick('skip')\\">Skip</button><button onclick=\\"pick('B')\\">B sounds like me</button></div>";
  root.innerHTML = html;
  window.scrollTo(0, 0);
}
function pick(v) {
  picks.push({ task: pairs[i].task, pick: v });
  if (++i < pairs.length) return show();
  document.getElementById("bar").style.width = "100%";
  document.getElementById("count").textContent = "done";
  root.innerHTML = "<div class=\\"done\\">Scoring...</div>";
  fetch("/done", { method: "POST", body: JSON.stringify(picks) }).then(function (r) { return r.json(); }).then(finish);
}
function finish(q) {
  var html = "<div class=\\"done\\"><h2>You picked the profile output " + q.withWins + " of " + q.total + "</h2>";
  html += "<p>More than half means the profile makes agent output read more like you. The report is updated, you can close this tab.</p><table>";
  for (var r = 0; r < q.picks.length; r++) html += "<tr><td>" + esc(q.picks[r].task) + "</td><td class=\\"" + q.picks[r].picked + "\\">" + (q.picks[r].picked === "with" ? "profile" : q.picks[r].picked === "without" ? "plain" : "skipped") + "</td></tr>";
  root.innerHTML = html + "</table></div>";
}
document.addEventListener("keydown", function (e) {
  if (i >= pairs.length || e.metaKey || e.ctrlKey) return;
  var k = e.key.toUpperCase();
  if (k === "A" || k === "B") pick(k); else if (k === "S") pick("skip");
});
show();
</script>
</body>
</html>`;
}
