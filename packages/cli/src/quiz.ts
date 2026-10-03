import type { Report } from "@shakibkhatri/idiolect-eval";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { THEME } from "./theme.js";

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
        res.end(page(pairs.map(({ task, prompt, a, b }) => ({ task, prompt, a, b })), `style with ${report.rules} rules, run ${report.generatedAt.slice(0, 16).replace("T", " ")}`));
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

export function page(pairs: Omit<Pair, "flip">[], subtitle = ""): string {
  // the JSON goes through a script tag, so a closing tag inside a sample must not end it early
  const data = JSON.stringify(pairs).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Idiolect quiz</title>
<style>
${THEME}
  .wrap { max-width: 1440px; margin: 0 auto; padding: 20px 24px 120px; }
  header { display: flex; align-items: center; gap: 20px; margin-bottom: 18px; }
  header h1 { font-size: 20px; margin: 0; font-weight: 650; letter-spacing: -.01em; }
  header .sub { color: var(--muted); font-size: 13px; }
  .dots { display: flex; gap: 5px; margin-left: auto; }
  .dots i { width: 8px; height: 8px; border-radius: 50%; background: var(--line); transition: background .2s, transform .2s; }
  .dots i.done { background: var(--accent); } .dots i.now { background: var(--accent); transform: scale(1.35); }
  .task { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 18px; margin-bottom: 18px; box-shadow: var(--shadow); }
  .task small { display: block; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; font-size: 11px; font-weight: 600; margin-bottom: 4px; }
  .task p { margin: 0; white-space: pre-wrap; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 900px) { .pair { grid-template-columns: 1fr; } }
  .card { cursor: pointer; transition: border-color .15s, transform .15s, box-shadow .15s; overflow: hidden; animation: in .25s ease-out; }
  .card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 2px 4px rgba(0,0,0,.06), 0 14px 32px rgba(20,20,40,.12); }
  .card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .card h2 { display: flex; align-items: center; gap: 10px; margin: 0; padding: 12px 16px; font-size: 13px; font-weight: 600; color: var(--muted); border-bottom: 1px solid var(--line); }
  .card h2 b { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); font-size: 14px; }
  .card h2 span { margin-left: auto; font-weight: 500; opacity: 0; transition: opacity .15s; }
  .card:hover h2 span { opacity: 1; }
  pre { margin: 0; padding: 14px 16px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  pre .same { opacity: .4; }
  pre .diff { box-shadow: inset 3px 0 0 var(--accent); margin-left: -16px; padding-left: 13px; display: inline-block; width: calc(100% + 16px); }
  .foot { position: fixed; left: 0; right: 0; bottom: 0; display: flex; justify-content: center; align-items: center; gap: 18px; padding: 14px; background: color-mix(in srgb, var(--bg) 85%, transparent); backdrop-filter: blur(8px); border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
  .foot button { font: inherit; color: var(--muted); background: none; border: 1px solid var(--line); border-radius: 8px; padding: 6px 14px; cursor: pointer; }
  .foot button:hover { color: var(--fg); border-color: var(--accent); }
  .result { max-width: 640px; margin: 48px auto; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 32px; box-shadow: var(--shadow); animation: in .3s ease-out; }
  .result .big { font-size: 56px; font-weight: 700; letter-spacing: -.03em; line-height: 1; }
  .result .big small { font-size: 20px; color: var(--muted); font-weight: 500; margin-left: 8px; letter-spacing: 0; }
  .result p { color: var(--muted); margin: 12px 0 20px; }
  .meter { height: 10px; border-radius: 5px; background: var(--line); overflow: hidden; position: relative; }
  .meter i { display: block; height: 100%; background: var(--accent); width: 0; transition: width .6s ease-out; }
  .meter:after { content: ""; position: absolute; left: 50%; top: -3px; bottom: -3px; border-left: 2px dashed var(--muted); }
  .legend { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin: 6px 0 24px; }
  .list { display: grid; grid-template-columns: 1fr auto; gap: 6px 24px; font-size: 14px; }
  .list .with { color: var(--accent); font-weight: 600; } .list .without, .list .skip { color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header><h1>Which sounds like you?</h1><span class="sub">${subtitle}</span><div class="dots" id="dots"></div></header>
  <div id="root"></div>
</div>
<div class="foot" id="foot"><span><kbd>A</kbd> left</span><span><kbd>B</kbd> right</span><span><kbd>S</kbd> skip</span><button onclick="pick('skip')">Skip this one</button></div>
<script id="data" type="application/json">${data}</script>
<script>
var pairs = JSON.parse(document.getElementById("data").textContent);
var picks = [], i = 0;
var root = document.getElementById("root"), dots = document.getElementById("dots");
dots.innerHTML = pairs.map(function () { return "<i></i>"; }).join("");

// lines both outputs share, by longest common subsequence
function shared(a, b) {
  var n = a.length, m = b.length, dp = [];
  for (var x = 0; x <= n; x++) dp.push(new Array(m + 1).fill(0));
  for (var x = n - 1; x >= 0; x--) for (var y = m - 1; y >= 0; y--) dp[x][y] = a[x] === b[y] && a[x].trim() ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
  var sa = new Set(), sb = new Set(), x = 0, y = 0;
  while (x < n && y < m) {
    if (a[x] === b[y] && a[x].trim()) { sa.add(x); sb.add(y); x++; y++; }
    else if (dp[x + 1][y] >= dp[x][y + 1]) x++; else y++;
  }
  return [sa, sb];
}
function esc(s) { return s.replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }

// the dimming only helps when the two outputs mostly overlap, two unrelated texts stay plain
function render(lines, same, mark) {
  return lines.map(function (l, k) { return mark ? "<span class=\\"" + (same.has(k) ? "same" : l.trim() ? "diff" : "") + "\\">" + esc(l) + "</span>" : esc(l); }).join("\\n");
}
function card(side, text, same, mark) {
  return "<div class=\\"card\\" tabindex=\\"0\\" role=\\"button\\" onclick=\\"pick('" + side + "')\\" onkeydown=\\"if(event.key==='Enter')pick('" + side + "')\\"><h2><b>" + side + "</b>Output " + side + "<span>Pick this one</span></h2><pre>" + render(text, same, mark) + "</pre></div>";
}
function show() {
  var p = pairs[i], a = p.a.trim().split("\\n"), b = p.b.trim().split("\\n");
  var s = shared(a, b), mark = s[0].size >= Math.min(a.length, b.length) * 0.5;
  var d = dots.children; for (var k = 0; k < d.length; k++) d[k].className = k < i ? "done" : k === i ? "now" : "";
  root.innerHTML = "<div class=\\"task\\"><small>Task " + (i + 1) + " of " + pairs.length + "</small><p>" + esc(p.prompt) + "</p></div><div class=\\"pair\\">" + card("A", a, s[0], mark) + card("B", b, s[1], mark) + "</div>";
  window.scrollTo(0, 0);
}
function pick(v) {
  if (i >= pairs.length) return;
  picks.push({ task: pairs[i].task, pick: v });
  if (++i < pairs.length) return show();
  var d = dots.children; for (var k = 0; k < d.length; k++) d[k].className = "done";
  document.getElementById("foot").style.display = "none";
  root.innerHTML = "<div class=\\"result\\">Scoring...</div>";
  fetch("/done", { method: "POST", body: JSON.stringify(picks) }).then(function (r) { return r.json(); }).then(finish);
}
function finish(q) {
  var pct = q.total ? Math.round(100 * q.withWins / q.total) : 0;
  var verdict = !q.total ? "Nothing answered." : pct > 60 ? "The style makes agent output read more like you." : pct < 40 ? "The style makes agent output read less like you." : "No clear difference yet. Chance is the dashed line.";
  var html = "<div class=\\"result\\"><div class=\\"big\\">" + q.withWins + " <small>of " + q.total + " for the style</small></div><p>" + verdict + " The report is updated, you can close this tab.</p>";
  html += "<div class=\\"meter\\"><i id=\\"meter\\"></i></div><div class=\\"legend\\"><span>none for the style</span><span>chance</span><span>all for the style</span></div><div class=\\"list\\">";
  for (var r = 0; r < q.picks.length; r++) html += "<span>" + esc(q.picks[r].task) + "</span><span class=\\"" + q.picks[r].picked + "\\">" + ({ with: "style", without: "plain", skip: "skipped" })[q.picks[r].picked] + "</span>";
  root.innerHTML = html + "</div></div>";
  requestAnimationFrame(function () { document.getElementById("meter").style.width = pct + "%"; });
}
document.addEventListener("keydown", function (e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  var k = e.key.toUpperCase();
  if (k === "A" || k === "B") pick(k); else if (k === "S") pick("skip");
});
show();
</script>
</body>
</html>`;
}
