# Idiolect - SPEC

Name: **Idiolect** (the unique way one person speaks and writes). The linter feature is called **Unbot**.

## 1. What it is

A local-first tool that learns how a developer writes code, comments and commits, turns that into a style profile, and feeds it to AI coding agents (Claude, Cursor, Copilot, any MCP client) so their output reads like the developer wrote it.

Three outputs:
1. A **style profile** learned from the developer's own git history
2. An **MCP server** that serves the profile and checks/rewrites code against it
3. **Unbot**, an AI-tell linter that flags code and comments that "sound like AI"

Later: **team mode**, which learns team rules from PR review comments.

## 2. Principles

- **Local first.** Code never leaves the machine except the samples sent to the LLM provider the user chose.
  Support a fully local option (Ollama or any OpenAI-compatible local server) so nothing leaves the machine at all.
- **LLM is optional.** Every feature has a no-LLM baseline. The LLM improves output, it never gates it.
- **Bring your own key.** No backend, no accounts in v1.
- **Evidence or nothing.** Every rule must be backed by stats or real examples from the user's code. No guessed rules.
- **Only the user's code.** Use git blame and author emails so other people's code never shapes the profile.
- **Never overwrite user files.** Only write inside clearly marked blocks.
- **Measurable.** The eval harness decides if a change made the output more "like me".

## 3. Tech stack

- TypeScript, Node 22+ (20 is end of life, 22 has `path.matchesGlob` and `fs.glob` built in), pnpm workspaces (monorepo)
- `web-tree-sitter` with WASM grammars (no native builds): Kotlin, Swift, TypeScript/JavaScript, Python, Go.
  Grammar `.wasm` files are vendored in `packages/core/grammars/` (MIT) and refreshed with `scripts/update-grammars.sh`.
  Reason: `tree-sitter-wasms` is stale (legacy `dylink` section, rejected by current `web-tree-sitter`) and the official grammar packages carry a node-gyp install script.
  Kotlin, TypeScript, Python and Go publish a modern wasm on npm. Swift does not, it must be built once with the tree-sitter CLI and vendored the same way
- `child_process` for git, no wrapper library
- `@modelcontextprotocol/sdk` for the MCP server (stdio transport)
- `commander` for the CLI, `zod` for schemas, `vitest` for tests
- LLM provider interface with adapters: Anthropic (default), OpenAI, Google Gemini, and `openai-compatible` (any base URL).
  The `openai-compatible` adapter covers Ollama, LM Studio, vLLM, llama.cpp server and corporate gateways, so local needs no dedicated code.
- Default model per provider lives in one table in `core`. Anthropic default is `claude-opus-5-5`. `model` in config is optional and overrides it
- Dashboard: Vite + React, served locally by the CLI

## 4. Repo structure

```
packages/
  core/        # collector, analyzer, profile model, profile writer, LLM adapters
  cli/         # `idiolect` command
  mcp/         # MCP server
  lint/        # AI-tell linter + git hooks
  eval/        # eval harness
  team/        # PR review mining (team mode)
  dashboard/   # local web UI
data/
  ai-tells.json   # curated list of AI writing habits
  eval-tasks/     # eval task definitions
fixtures/         # test repos (small, committed)
```

## 5. Data model

The **profile JSON is the source of truth**. `STYLE.md` is rendered from it.

```ts
type Profile = {
  version: 1
  developer: { name: string; emails: string[] }
  generatedAt: string
  sources: { repo: string; commits: number; linesOwned: number; stats: Record<Language, LanguageStats> }[]
  stats: Record<Language, LanguageStats>   // merged across repos, counts and histograms only
  rules: Rule[]
}

type Rule = {
  id: string                       // e.g. "kotlin.comments.lowercase-start"
  scope: "personal" | "team"
  language: Language | "any"
  category: "naming" | "comments" | "structure" | "errors" | "framework" | "commits" | "avoid"
  text: string                     // the rule as the agent reads it
  evidence: {
    metric?: { name: string; value: number; sampleSize: number }
    examples: { file: string; line: number; snippet: string }[]   // max 3
    count?: number                 // team mode: "flagged 14x"
  }
  confidence: number               // 0..1
  status: "auto" | "pending" | "approved" | "rejected" | "edited"
  paths?: string[]                 // optional glob scope, e.g. "shared/src/**"
}
```

Storage:
- Personal profile: `~/.idiolect/profiles/<primary-email>.json` (merged across repos)
- Merging: the analyzer emits counts and bucketed histograms, never ratios or percentiles.
  Merge is a plain sum, so it is exact, order-independent and deterministic. Ratios and percentiles are computed at render time.
  Per-repo stats are kept in `sources[]` so a repo that disagrees with the merged profile can be spotted later.
- Per-repo config and cache: `<repo>/.idiolect/` (cache git-ignored)
- Team rules: `<repo>/.idiolect/team.json` (committed)

Precedence when serving rules:
1. Scope first: team beats personal, always. A path-scoped personal rule never overrides a team rule.
2. Within a scope: path-scoped > language > any.
3. Same `id` at two levels: only the winner is served. Different ids: both are served, winner first.

## 6. Modules

### M1 Collector (`core`)
- Input: repo path(s), author emails (auto-detect from `git config user.email`, allow more)
- `git log --author` for the user's commits and messages
- `git blame` per file to find lines the user owns
- Ignore: build dirs, generated code, lock files, vendored code, files over a size limit, `.gitignore` + `.idiolectignore`
- Output: list of owned code regions per file + commit messages
- Incremental: cache by commit hash, rescan only new commits

**Done when:** on a fixture repo with 2 authors, only author A's lines are returned.

### M2 Analyzer (`core`)
Pure counting with tree-sitter, no LLM. Per language, at least:

- **Functions:** length distribution (p50, p90), max nesting, early-return ratio, params count
- **Naming:** casing per symbol kind, verb prefixes (`get/fetch/load`), boolean prefixes (`is/has`), abbreviation rate, name length
- **Comments:** density per 100 LOC, avg length, lowercase-start ratio, trailing-period ratio, doc comments on public vs private, TODO format
- **Errors:** try/catch density, Result/runCatching usage, force unwrap (`!!`, `!`) per KLOC
- **Language-specific:**
  - Kotlin: `when` vs if/else chains (3+ branches), sealed interface vs sealed class, extension functions, data classes, Compose modifier param position, `remember` usage
  - Swift: guard vs if-let, structs vs classes, trailing closures
  - TS: arrow vs function declarations, `type` vs `interface`, optional chaining
- **Commits:** length, lowercase ratio, conventional prefix ratio, tense

Start with **Kotlin only**, add others after M5.

**Done when:** stats are deterministic and unit-tested against fixtures with known values.

### M3 Profile writer (`core`)
- Input: stats + sampled snippets (stratified: ~30 functions, ~100 comments, ~100 commit messages, configurable token budget)
- LLM turns stats + samples into `Rule[]` with a fixed prompt and zod-validated JSON output
- **No-LLM baseline:** without a provider configured, render template rules straight from stats (e.g. "p50 function length is 12 lines").
  First run gives value with no key and no local model. The LLM upgrades these into prose and adds the Avoid section
- Every rule must reference a metric or examples, otherwise dropped
- **Avoid section:** check each item in `data/ai-tells.json` against the user's code. If the user basically never does it, add an "avoid" rule.
  Each tell references a metric id from `core/metrics.ts`, so detection is counted by the analyzer, never guessed by the LLM
- **LLM rules must cite samples.** The model returns rules with example references (file and line). References that were not in the samples sent are dropped, and a rule left without examples is dropped
- Confidence for metric rules is the 95% Wilson lower bound of the ratio, so small samples lower confidence without being dropped outright
- Rules below confidence threshold (default 0.6) are stored but not served
- Minimum evidence: a metric-based rule needs `sampleSize >= minSampleSize` (default 20) and a ratio of >= 0.8 or <= 0.2.
  Below that the LLM gets the number but is told it is weak and must not turn it into a rule
- On rescan: diff old vs new rules, changed rules become `pending`
- Render `STYLE.md` (sections: Naming, Comments, Structure, Errors, Framework, Commits, Avoid, Team rules)

**Done when:** running on the author's own repos produces a profile where every rule has evidence and the author agrees with most of it.

### M4 Eval harness (`eval`)
- Task file (`data/eval-tasks/*.yaml`): prompt, language, optional context files
- For each task, generate code **with** and **without** the profile
- Scores:
  1. **Metric distance:** run the analyzer on the output, compare to the user's stats
  2. **LLM judge:** pairwise, "which output matches these reference samples from the developer"
  3. **Blind quiz:** CLI shows two outputs in random order, user picks which sounds like them
- Output: report with win rate and metric distance per category, saved as JSON + Markdown

**Done when:** `idiolect eval` prints a win rate, and re-running after a profile change shows the difference.

### M5 MCP server (`mcp`)
stdio transport. Tools:

| Tool | Input | Output |
|---|---|---|
| `get_style` | `file_path?`, `language?` | Rules that apply to that file (language + path scope + team), as Markdown |
| `check_style` | `code`, `language`, `file_path?` | Violations: `{rule_id, line, message, suggestion}` |
| `rewrite_like_me` | `code`, `language`, `scope: comments \| names \| all` | Rewritten code + list of changes |
| `get_team_rules` | `path` | Team rules for that path with counts |

Also:
- Resource: `style://profile/{language}`
- Prompt: `write_like_me` (instructs the agent to call `get_style` before writing and `check_style` after)

Install:
```
claude mcp add idiolect -- npx -y idiolect mcp
```
Plus documented config snippets for Cursor and other MCP clients.

**Done when:** Claude Code calls `get_style` on a `.kt` file and gets only Kotlin + general rules.

### M6 Sync (`cli`)
- `idiolect sync` writes the rendered profile into:
  - `CLAUDE.md`
  - `AGENTS.md`
  - `.cursor/rules/idiolect.mdc`
  - `.github/copilot-instructions.md`
- Only between `<!-- idiolect:start -->` and `<!-- idiolect:end -->`. Never touch anything else
- Choose targets in config, default: only files that already exist + `AGENTS.md`

**Done when:** running sync twice changes nothing, and user content outside markers is untouched.

### M7 Unbot, the AI-tell linter (`lint`)
- `idiolect unbot [files]` checks for AI habits and profile violations
- Two modes: fast (AST + regex, no LLM) and deep (`--llm`)
- Examples of AI tells: comments restating the code, "This function...", words like "robust", "seamless", "leverage", "comprehensive", docblocks on trivial private functions, over-generic names (`handleData`, `processItem`), try/catch around everything, emoji in comments
- `--fix` uses `rewrite_like_me`
- `idiolect hooks install` adds a pre-commit hook (works with husky / lefthook if present)
- Default: warn only. `--strict`: non-zero exit

**Done when:** a file of typical AI-written Kotlin gets flagged and `--fix` produces something the eval judge prefers.

### M8 Auto refresh (`cli`)
- Post-commit hook counts commits, every N commits (default 50) runs incremental scan in background
- Changed rules go to `pending`, user approves via CLI or dashboard
- `idiolect status` shows profile age, pending rules, last scan

### M9 Team mode (`team`)
- Source: GitHub (token or `gh` auth), GitLab later
- Fetch PR review comments + review bodies for last N months
- LLM classifies: convention/style comment vs other (bugs, questions, praise)
- Cluster similar comments, count them, map to file paths
- Generate team rules with `count` and links to example comments
- Write to `.idiolect/team.json` (committed, reviewed like code)
- Later: GitHub App that updates team rules automatically and comments on PRs

**Done when:** on a real repo with reviews, the top 5 team rules match what the team would say.

### M10 Dashboard (`dashboard`)
- `idiolect ui` starts a local web server
- View rules with evidence, approve / reject / edit, filter by language and category
- See pending diffs after rescans
- Run eval and view reports
- Local only, no login

## 7. CLI

```
idiolect init                 # detect emails, languages, create config
idiolect scan [--repo ...]    # collect + analyze + write profile
idiolect show [--lang kotlin] # print STYLE.md
idiolect sync                 # write into agent instruction files
idiolect unbot [files] [--fix] [--llm] [--strict]
idiolect hooks install
idiolect eval [--quiz]
idiolect status
idiolect team scan            # team mode
idiolect mcp                  # start MCP server
idiolect ui                   # dashboard
```

## 8. Config (`.idiolect/config.json`)

```json
{
  "emails": ["me@example.com"],
  "languages": ["kotlin"],
  "llm": { "provider": "anthropic", "model": "claude-opus-5-5", "apiKeyEnv": "ANTHROPIC_API_KEY" },
  "// local example": { "provider": "openai-compatible", "baseUrl": "http://localhost:11434/v1", "model": "<model>" },
  "sampling": { "maxTokens": 40000 },
  "confidenceThreshold": 0.6,
  "minSampleSize": 20,
  "sync": { "targets": ["AGENTS.md", "CLAUDE.md"] },
  "refresh": { "everyCommits": 50 },
  "ignore": ["**/build/**", "**/generated/**"]
}
```

## 9. Privacy and security

- No telemetry by default
- Show exactly what will be sent to the LLM (`--dry-run` prints samples + token count)
- Redact secrets in samples (API keys, tokens, `.env` style values) before sending
- Fully offline option via any OpenAI-compatible local server (Ollama, LM Studio, vLLM, llama.cpp)
- `idiolect init` asks which provider to use and explains what each one receives
- Team mode tokens read from env or `gh`, never stored in plain config

## 10. Testing

- Unit tests for every analyzer metric with small fixture files and known expected values
- Fixture repos with multiple authors for the collector
- Snapshot tests for `STYLE.md` rendering and sync
- MCP tests: spawn server, call each tool, validate output schemas
- LLM calls mocked in unit tests, real calls only in `eval`

## 11. Build order

0. **Spike:** parse one real Kotlin file with `web-tree-sitter`, print the AST. Done 2026-10-02, see `packages/core/src/parser.test.ts`
1. **M1 Collector** + **M2 Analyzer** (Kotlin)
2. **M3 Profile writer** + `STYLE.md`
3. **M4 Eval harness** - prove it works on the author's own repos before going further
4. **M5 MCP server** + **M6 Sync**
5. **M7 Unbot linter**
6. **Launch:** README with before/after examples, post on Hacker News, r/programming, r/ClaudeAI
7. Add languages (Swift, TS, Python, Go), **M8 Auto refresh**
8. **M9 Team mode**, **M10 Dashboard** - only after real usage

## 12. Out of scope for v1

- Hosted backend, accounts, payments
- IDE plugins (MCP + sync cover this)
- Training or fine-tuning models

## 13. Open questions

- Grab domain (idiolect.dev) and GitHub org
- Pricing: free personal, paid team mode?
- Should profiles be shareable/exportable ("use my style on a new machine")?
