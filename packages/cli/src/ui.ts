import { git, isServed, loadServedProfile, loadRepoConfig, renderStyleMd, updateRules, type Profile, type Rule } from "@shakibkhatri/idiolect-core";
import type { Report } from "@shakibkhatri/idiolect-eval";
import { Command } from "commander";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { NO_PROFILE, persist } from "./rules.js";
import { THEME } from "./theme.js";

export type ReportRow = { stamp: string; generatedAt: string; rules: number; tasks: number; judge: { withWins: number; total: number }; quiz?: { withWins: number; total: number }; distance: { with: number; without: number } };

/** Everything the page needs in one object: rules with a served flag, the rendered profile for this repo, languages, sources and eval runs. */
export async function buildState(profile: Profile, repo: string, threshold: number, reports: ReportRow[]) {
  const total = Object.values(profile.stats).reduce((n, s) => n + (s?.loc ?? 0), 0);
  const languages = Object.entries(profile.stats).map(([language, s]) => ({ language, loc: s?.loc ?? 0, share: total ? (s?.loc ?? 0) / total : 0 })).sort((a, b) => b.loc - a.loc);
  const sources = await Promise.all(profile.sources.map(async (s) => ({
    repo: s.repo, scannedAt: s.scannedAt, commits: s.commits, linesOwned: s.linesOwned,
    commitsSince: Number((await git(s.repo, ["rev-list", "--count", `${s.head}..HEAD`]).catch(() => "0")).trim()),
  })));
  const rules = profile.rules.map((r) => ({ ...r, served: isServed(r, threshold, profile.borrowed) && (!r.repo || r.repo === repo) }));
  return { developer: profile.developer, generatedAt: profile.generatedAt, repo, threshold, languages, sources, rules, style: renderStyleMd(profile, { threshold, repo }), reports };
}

export async function listReports(repo: string): Promise<ReportRow[]> {
  const dir = join(repo, ".idiolect", "eval");
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort().reverse();
  const rows: ReportRow[] = [];
  for (const f of files) {
    const r = JSON.parse(await readFile(join(dir, f), "utf8")) as Report;
    rows.push({ stamp: f.replace(/\.json$/, ""), generatedAt: r.generatedAt, rules: r.rules, tasks: r.tasks, judge: { withWins: r.judge.withWins, total: r.judge.total }, quiz: r.quiz && { withWins: r.quiz.withWins, total: r.quiz.total }, distance: { with: r.metricDistance.with, without: r.metricDistance.without } });
  }
  return rows;
}

export function uiCommand(): Command {
  return new Command("ui").description("open the dashboard in your browser: review rules, read the style your agent reads, browse eval runs")
    .option("--repo <path>", "repository path, for the rules of this repo, the threshold and eval reports", ".")
    .option("--port <n>", "port, default is a free one", "0")
    .option("--no-open", "print the URL without opening the browser")
    .action(async (o: { repo: string; port: string; open: boolean }) => {
      const repo = (await git(resolve(o.repo), ["rev-parse", "--show-toplevel"]).catch(() => resolve(o.repo))).trim();
      const load = async () => { const p = await loadServedProfile(repo); if (!p) throw new Error(NO_PROFILE); return p; };
      const { confidenceThreshold: threshold } = await loadRepoConfig(repo);
      const state = async () => buildState(await load(), repo, threshold, await listReports(repo));

      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        try {
          if (req.method === "GET" && url.pathname === "/") return html(res, page());
          if (req.method === "GET" && url.pathname === "/api/state") return json(res, await state());
          if (req.method === "GET" && url.pathname === "/api/style") return json(res, { style: renderStyleMd(await load(), { threshold, repo, language: url.searchParams.get("lang") || undefined }) });
          if (req.method === "GET" && url.pathname === "/api/report") {
            const stamp = url.searchParams.get("stamp") ?? "";
            if (!/^[\w-]+$/.test(stamp)) return json(res, { error: "bad stamp" }, 400);
            return json(res, JSON.parse(await readFile(join(repo, ".idiolect", "eval", `${stamp}.json`), "utf8")));
          }
          if (req.method === "POST" && url.pathname === "/api/rules") {
            const body = JSON.parse(await read(req)) as { ids: string[]; status: "approved" | "rejected" | "edited"; text?: string };
            const profile = updateRules(await load(), body.ids, body.status, body.text);
            await persist(profile, repo, threshold);
            return json(res, await state());
          }
          res.writeHead(404); res.end();
        } catch (e) { json(res, { error: (e as Error).message }, 500); }
      });
      server.listen(Number(o.port), "127.0.0.1", () => {
        const addr = server.address();
        const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : o.port}/`;
        console.log(`dashboard: ${url}  (ctrl-c to stop)`);
        if (o.open) openBrowser(url);
      });
    });
}

const json = (res: ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const html = (res: ServerResponse, body: string) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
const read = (req: IncomingMessage) => new Promise<string>((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });
export function openBrowser(url: string) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd, args, () => {});
}

export function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Idiolect</title>
<style>
${THEME}
  .wrap { max-width: 1240px; margin: 0 auto; padding: 20px 24px 80px; }
  header { display: flex; align-items: center; gap: 24px; margin-bottom: 20px; flex-wrap: wrap; }
  header h1 { font-size: 20px; margin: 0; font-weight: 650; letter-spacing: -.01em; }
  header .who { color: var(--muted); font-size: 13px; }
  nav { display: flex; gap: 4px; margin-left: auto; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 3px; }
  nav a { padding: 6px 14px; border-radius: 8px; color: var(--muted); text-decoration: none; font-weight: 500; font-size: 14px; }
  nav a.on { background: var(--accent-soft); color: var(--accent); }
  .bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { border: 1px solid var(--line); background: var(--card); color: var(--muted); border-radius: 999px; padding: 4px 12px; font-size: 13px; }
  .chip.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .chip b { font-weight: 600; margin-left: 4px; }
  select, input[type=search], textarea { font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
  input[type=search] { min-width: 220px; }
  .rule { display: grid; grid-template-columns: 92px 1fr auto; gap: 14px; padding: 12px 16px; border-bottom: 1px solid var(--line); align-items: start; animation: in .2s ease-out; }
  .rule:last-child { border-bottom: 0; }
  .rule .meta { font-size: 12px; color: var(--muted); display: grid; gap: 4px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; background: var(--accent-soft); color: var(--accent); }
  .badge.approved, .badge.edited { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .badge.rejected { background: color-mix(in srgb, var(--bad) 15%, transparent); color: var(--bad); }
  .badge.pending { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
  .conf { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; } .conf i { display: block; height: 100%; background: var(--accent); }
  .rule .text { cursor: pointer; }
  .rule .text .tags { color: var(--muted); font-size: 12px; margin-left: 6px; }
  .rule .text.off { color: var(--muted); }
  .prev { color: var(--muted); text-decoration: line-through; font-size: 13px; margin-top: 4px; }
  .evidence { margin-top: 10px; font-size: 13px; color: var(--muted); display: grid; gap: 8px; }
  .evidence pre { margin: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; color: var(--fg); }
  .evidence .where { font-size: 12px; }
  .actions { display: flex; gap: 6px; }
  .actions button { border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; padding: 5px 10px; font-size: 13px; }
  .actions button:hover { color: var(--fg); border-color: var(--accent); }
  .actions button.primary { color: var(--accent); border-color: var(--accent); }
  .editor { grid-column: 2 / 4; display: grid; gap: 8px; }
  .editor textarea { width: 100%; min-height: 72px; resize: vertical; }
  .empty { padding: 40px; text-align: center; color: var(--muted); }
  .md { padding: 24px 28px; max-width: 900px; line-height: 1.6; }
  .md h1 { font-size: 22px; margin: 0 0 8px; } .md h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 28px 0 10px; }
  .md p { margin: 8px 0; color: var(--muted); } .md ul { margin: 0; padding-left: 20px; } .md li { margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); font-size: 14px; } th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  tr.row { cursor: pointer; } tr.row:hover td { background: var(--accent-soft); }
  .num { font-variant-numeric: tabular-nums; }
  .with { color: var(--accent); font-weight: 600; } .without { color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
  .stat { padding: 18px 20px; } .stat small { display: block; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; font-size: 11px; font-weight: 600; margin-bottom: 6px; }
  .stat .big { font-size: 28px; font-weight: 700; letter-spacing: -.02em; } .stat .big small { display: inline; font-size: 14px; color: var(--muted); text-transform: none; letter-spacing: 0; font-weight: 500; margin-left: 6px; }
  .stat ul { margin: 8px 0 0; padding: 0; list-style: none; } .stat li { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; border-top: 1px solid var(--line); font-size: 14px; }
  .pairs details { border-top: 1px solid var(--line); padding: 10px 16px; } .pairs summary { cursor: pointer; display: flex; gap: 14px; align-items: baseline; }
  .pairs summary .reason { color: var(--muted); font-size: 13px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 10px; } .two pre { margin: 0; padding: 12px; border: 1px solid var(--line); border-radius: 10px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .two h4 { margin: 0 0 6px; font-size: 12px; color: var(--muted); font-weight: 600; }
  .hint { color: var(--muted); font-size: 13px; margin: 10px 0 0; } .hint code { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--fg); color: var(--bg); padding: 8px 16px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.on { opacity: 1; }
</style>
</head>
<body>
<div class="wrap">
  <header><h1>Idiolect</h1><span class="who" id="who"></span>
    <nav><a href="#rules">Rules</a><a href="#style">Style</a><a href="#evals">Evals</a><a href="#status">Status</a></nav></header>
  <div id="root"><div class="empty">Loading your style...</div></div>
</div>
<div class="toast" id="toast"></div>
<script>
var S = null, filter = { status: "all", lang: "", category: "", q: "" }, open = {}, editing = null, styleLang = "", report = null;
var root = document.getElementById("root");
var CATS = ["naming", "comments", "structure", "errors", "framework", "commits", "avoid"];
var LANG = { kotlin: "Kotlin", typescript: "TypeScript", python: "Python", go: "Go", any: "Any language" };

function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function toast(m) { var t = document.getElementById("toast"); t.textContent = m; t.className = "toast on"; setTimeout(function () { t.className = "toast"; }, 1800); }
function tab() { var t = location.hash.replace("#", "").replace("profile", "style"); return ["rules", "style", "evals", "status"].indexOf(t) >= 0 ? t : "rules"; }
function api(path, opts) { return fetch(path, opts).then(function (r) { return r.json(); }).then(function (j) { if (j.error) { toast(j.error); throw new Error(j.error); } return j; }); }
function load() { return api("/api/state").then(function (s) { S = s; document.getElementById("who").textContent = s.developer.name + " · " + s.rules.length + " rules · " + s.repo.split("/").pop(); render(); }); }
function render() {
  var t = tab();
  var links = document.querySelectorAll("nav a"); for (var i = 0; i < links.length; i++) links[i].className = links[i].getAttribute("href") === "#" + t ? "on" : "";
  if (t === "rules") renderRules(); else if (t === "style") renderProfile(); else if (t === "evals") renderEvals(); else renderStatus();
}

// ---- rules ----
function visible() {
  var q = filter.q.toLowerCase();
  return S.rules.filter(function (r) {
    if (filter.status === "served" ? !r.served : filter.status !== "all" && r.status !== filter.status) return false;
    if (filter.lang && r.language !== filter.lang) return false;
    if (filter.category && r.category !== filter.category) return false;
    return !q || (r.text + " " + r.id).toLowerCase().indexOf(q) >= 0;
  });
}
function chip(key, label) {
  var n = key === "all" ? S.rules.length : key === "served" ? S.rules.filter(function (r) { return r.served; }).length : S.rules.filter(function (r) { return r.status === key; }).length;
  if (!n && key !== "all") return "";
  return "<button class=\\"chip" + (filter.status === key ? " on" : "") + "\\" onclick=\\"setFilter('status','" + key + "')\\">" + label + "<b>" + n + "</b></button>";
}
function setFilter(k, v) { filter[k] = v; renderRules(); }
function renderRules() {
  var langs = Object.keys(LANG).filter(function (l) { return S.rules.some(function (r) { return r.language === l; }); });
  var h = "<div class=\\"bar\\"><div class=\\"chips\\">" + chip("all", "All") + chip("served", "Served") + chip("pending", "Pending") + chip("approved", "Approved") + chip("edited", "Edited") + chip("rejected", "Rejected") + chip("auto", "Undecided") + "</div>";
  h += "<select onchange=\\"setFilter('lang',this.value)\\"><option value=\\"\\">Every language</option>" + langs.map(function (l) { return "<option value=\\"" + l + "\\"" + (filter.lang === l ? " selected" : "") + ">" + LANG[l] + "</option>"; }).join("") + "</select>";
  h += "<select onchange=\\"setFilter('category',this.value)\\"><option value=\\"\\">Every category</option>" + CATS.map(function (c) { return "<option value=\\"" + c + "\\"" + (filter.category === c ? " selected" : "") + ">" + c + "</option>"; }).join("") + "</select>";
  h += "<input type=\\"search\\" placeholder=\\"Search rules\\" value=\\"" + esc(filter.q) + "\\" oninput=\\"filter.q=this.value;renderRules()\\"></div>";
  var rows = visible();
  h += "<div class=\\"card\\">" + (rows.length ? rows.map(ruleRow).join("") : "<div class=\\"empty\\">No rules match.</div>") + "</div>";
  h += "<p class=\\"hint\\">Approved and edited rules survive every rescan. Rejected rules are kept but never served. A pending rule is an approved rule whose text a rescan changed. Agent files update with <code>idiolect sync</code>, the MCP server sees changes at once.</p>";
  root.innerHTML = h;
  var inp = root.querySelector("input[type=search]"); if (inp && filter.q) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}
function ruleRow(r) {
  var tags = (r.language !== "any" ? LANG[r.language] : "") + (r.repo ? " · " + r.repo.split("/").pop() + " only" : "") + (r.evidence.metric ? " · measured" : " · from examples");
  var h = "<div class=\\"rule\\"><div class=\\"meta\\"><span class=\\"badge " + r.status + "\\">" + (r.status === "auto" ? "auto" : r.status) + "</span><div class=\\"conf\\" title=\\"confidence " + r.confidence + "\\"><i style=\\"width:" + Math.round(r.confidence * 100) + "%\\"></i></div><span>" + r.confidence.toFixed(2) + (r.served ? "" : " · not served") + "</span></div>";
  h += "<div><div class=\\"text" + (r.served ? "" : " off") + "\\" onclick=\\"toggle('" + r.id + "')\\">" + esc(r.text) + "<span class=\\"tags\\">" + esc(tags) + "</span></div>";
  if (r.previousText) h += "<div class=\\"prev\\">" + esc(r.previousText) + "</div>";
  if (open[r.id]) h += evidence(r);
  h += "</div>";
  h += "<div class=\\"actions\\">" + (r.status !== "approved" ? "<button class=\\"primary\\" onclick=\\"decide('" + r.id + "','approved')\\">Approve</button>" : "") + (r.status !== "rejected" ? "<button onclick=\\"decide('" + r.id + "','rejected')\\">Reject</button>" : "") + "<button onclick=\\"edit('" + r.id + "')\\">Edit</button></div>";
  if (editing === r.id) h += "<div class=\\"editor\\"><textarea id=\\"editbox\\">" + esc(r.text) + "</textarea><div class=\\"actions\\"><button class=\\"primary\\" onclick=\\"saveEdit('" + r.id + "')\\">Save as edited</button><button onclick=\\"editing=null;renderRules()\\">Cancel</button></div></div>";
  return h + "</div>";
}
function evidence(r) {
  var h = "<div class=\\"evidence\\"><div class=\\"where\\">" + esc(r.id) + (r.learnedIn ? " · learned in " + esc(r.learnedIn.split("/").pop()) : "") + "</div>";
  if (r.evidence.metric) h += "<div>" + esc(r.evidence.metric.name) + " = " + r.evidence.metric.value + " over " + r.evidence.metric.sampleSize + " items</div>";
  for (var i = 0; i < r.evidence.examples.length; i++) { var e = r.evidence.examples[i]; h += "<div><div class=\\"where\\">" + esc(e.file.indexOf("commit:") === 0 ? e.file : e.file + ":" + e.line) + "</div><pre>" + esc(e.snippet) + "</pre></div>"; }
  return h + "</div>";
}
function toggle(id) { open[id] = !open[id]; renderRules(); }
function edit(id) { editing = id; renderRules(); document.getElementById("editbox").focus(); }
function decide(id, status, text) {
  return api("/api/rules", { method: "POST", body: JSON.stringify({ ids: [id], status: status, text: text }) }).then(function (s) { S = s; editing = null; renderRules(); toast(status + " " + id); });
}
function saveEdit(id) { var t = document.getElementById("editbox").value.trim(); if (!t) return toast("rule text cannot be empty"); decide(id, "edited", t); }

// ---- profile ----
function md(text) {
  var out = "", list = false;
  text.split("\\n").forEach(function (l) {
    if (l.indexOf("- ") === 0) { if (!list) { out += "<ul>"; list = true; } out += "<li>" + esc(l.slice(2)) + "</li>"; return; }
    if (list) { out += "</ul>"; list = false; }
    if (l.indexOf("## ") === 0) out += "<h2>" + esc(l.slice(3)) + "</h2>"; else if (l.indexOf("# ") === 0) out += "<h1>" + esc(l.slice(2)) + "</h1>"; else if (l.trim()) out += "<p>" + esc(l) + "</p>";
  });
  return out + (list ? "</ul>" : "");
}
function renderProfile() {
  var opts = "<option value=\\"\\">As served in " + esc(S.repo.split("/").pop()) + "</option>" + S.languages.map(function (l) { return "<option value=\\"" + l.language + "\\"" + (styleLang === l.language ? " selected" : "") + ">" + LANG[l.language] + " only, " + Math.round(l.share * 100) + "% of your lines</option>"; }).join("");
  root.innerHTML = "<div class=\\"bar\\"><select onchange=\\"styleLang=this.value;renderProfile()\\">" + opts + "</select><span class=\\"hint\\" style=\\"margin:0\\">This is the text an agent reads. Decisions on the Rules tab change it at once.</span></div><div class=\\"card md\\" id=\\"style\\">Rendering...</div>";
  var show = function (s) { document.getElementById("style").innerHTML = md(s); };
  if (!styleLang) show(S.style); else api("/api/style?lang=" + styleLang).then(function (j) { show(j.style); });
}

// ---- evals ----
function pct(w, t) { return t ? Math.round(100 * w / t) + "%" : "-"; }
function renderEvals() {
  if (report) return renderReport();
  if (!S.reports.length) { root.innerHTML = "<div class=\\"card empty\\">No eval runs in this repo yet. Run <code>idiolect eval</code>.</div>"; return; }
  var h = "<div class=\\"card\\"><table><tr><th>Run</th><th>Rules</th><th>Tasks</th><th>Judge for style</th><th>Your quiz</th><th>Distance with</th><th>Distance without</th></tr>";
  S.reports.forEach(function (r) {
    h += "<tr class=\\"row\\" onclick=\\"openReport('" + r.stamp + "')\\"><td>" + esc(r.generatedAt.slice(0, 16).replace("T", " ")) + "</td><td class=\\"num\\">" + r.rules + "</td><td class=\\"num\\">" + r.tasks + "</td><td class=\\"num\\">" + pct(r.judge.withWins, r.judge.total) + " <span class=\\"without\\">" + r.judge.withWins + "/" + r.judge.total + "</span></td><td class=\\"num\\">" + (r.quiz ? pct(r.quiz.withWins, r.quiz.total) + " <span class=\\"without\\">" + r.quiz.withWins + "/" + r.quiz.total + "</span>" : "<span class=\\"without\\">not taken</span>") + "</td><td class=\\"num\\">" + r.distance.with + "</td><td class=\\"num\\">" + r.distance.without + "</td></tr>";
  });
  root.innerHTML = h + "</table></div><p class=\\"hint\\">The judge shares a model with the generator and flatters its own styled output. Your quiz is the number: <code>idiolect eval --from latest --quiz</code>. Lower distance is closer to your measured habits.</p>";
}
function openReport(stamp) { api("/api/report?stamp=" + stamp).then(function (r) { report = r; renderReport(); }); }
function renderReport() {
  var r = report, picks = {};
  (r.quiz ? r.quiz.picks : []).forEach(function (p) { picks[p.task] = p.picked; });
  var h = "<div class=\\"bar\\"><button class=\\"chip\\" onclick=\\"report=null;renderEvals()\\">All runs</button><span class=\\"hint\\" style=\\"margin:0\\">" + esc(r.generatedAt.slice(0, 16).replace("T", " ")) + " · style with " + r.rules + " rules · judge " + r.judge.withWins + "/" + r.judge.total + (r.quiz ? " · you " + r.quiz.withWins + "/" + r.quiz.total : " · quiz not taken") + "</span></div><div class=\\"card pairs\\">";
  r.generations.forEach(function (g) {
    var v = r.judge.verdicts.filter(function (x) { return x.task === g.task.id; })[0] || {};
    h += "<details><summary><b>" + esc(g.task.id) + "</b><span class=\\"" + v.winner + "\\">judge: " + (v.winner === "with" ? "style" : "plain") + "</span>" + (picks[g.task.id] ? "<span class=\\"" + picks[g.task.id] + "\\">you: " + (picks[g.task.id] === "with" ? "style" : picks[g.task.id] === "without" ? "plain" : "skipped") + "</span>" : "") + "<span class=\\"reason\\">" + esc(v.reason || "") + "</span></summary>";
    h += "<div class=\\"two\\"><div><h4>With style</h4><pre>" + esc(g.with.trim()) + "</pre></div><div><h4>Without</h4><pre>" + esc(g.without.trim()) + "</pre></div></div></details>";
  });
  root.innerHTML = h + "</div>";
}

// ---- status ----
function ago(iso) { var h = Math.round((Date.now() - new Date(iso).getTime()) / 36e5); return h < 1 ? "just now" : h < 48 ? h + " h ago" : Math.round(h / 24) + " days ago"; }
function renderStatus() {
  var by = function (st) { return S.rules.filter(function (r) { return r.status === st; }).length; };
  var pending = S.rules.filter(function (r) { return r.status === "pending"; });
  var h = "<div class=\\"grid\\">";
  h += "<div class=\\"card stat\\"><small>Style</small><div class=\\"big\\">" + S.rules.length + "<small>rules, scanned " + ago(S.generatedAt) + "</small></div><ul><li><span>Undecided</span><span>" + by("auto") + "</span></li><li><span>Approved</span><span>" + by("approved") + "</span></li><li><span>Edited</span><span>" + by("edited") + "</span></li><li><span>Pending</span><span>" + by("pending") + "</span></li><li><span>Rejected</span><span>" + by("rejected") + "</span></li></ul></div>";
  h += "<div class=\\"card stat\\"><small>Languages</small><div class=\\"big\\">" + S.languages.length + "<small>in your code</small></div><ul>" + S.languages.map(function (l) { return "<li><span>" + LANG[l.language] + (l.share < 0.05 ? " <span class=\\"without\\">(under 5%, served on request)</span>" : "") + "</span><span>" + l.loc.toLocaleString() + " lines</span></li>"; }).join("") + "</ul></div>";
  h += "<div class=\\"card stat\\"><small>Repos</small><div class=\\"big\\">" + S.sources.length + "<small>scanned</small></div><ul>" + S.sources.map(function (s) { return "<li><span>" + esc(s.repo.split("/").pop()) + " <span class=\\"without\\">" + ago(s.scannedAt) + "</span></span><span>" + s.commits + " commits, " + (s.commitsSince ? s.commitsSince + " new" : "up to date") + "</span></li>"; }).join("") + "</ul></div>";
  h += "</div>";
  if (pending.length) h += "<h2 style=\\"font-size:15px;margin:28px 0 10px\\">Pending after a rescan</h2><div class=\\"card\\">" + pending.map(ruleRow).join("") + "</div>";
  root.innerHTML = h;
}

window.addEventListener("hashchange", render);
load();
</script>
</body>
</html>`;
}
