/** Design tokens and base styles shared by the quiz page and the dashboard. Light and dark follow the system. */
export const THEME = `
  :root { --bg: #f4f4f6; --card: #fff; --fg: #1b1b1f; --muted: #6b6b76; --line: #e2e2e8; --accent: #4f5bd5; --accent-soft: #eceefb; --ok: #2f8f5b; --warn: #b7791f; --bad: #c2410c; --shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(20,20,40,.06); }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f0f12; --card: #19191e; --fg: #ececf1; --muted: #8a8a96; --line: #2a2a32; --accent: #8c96ff; --accent-soft: #23243a; --ok: #4cc38a; --warn: #e0a640; --bad: #f0825a; --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.35); } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  pre, code, kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  kbd { font-size: 12px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; padding: 1px 6px; background: var(--card); color: var(--fg); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
  button { font: inherit; cursor: pointer; }
  @keyframes in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
`;
