# Idiolect - SPEC

Name: **Idiolect** (the unique way one person speaks and writes). The linter feature is called **Unbot**.

## 1. What it is

A local-first tool that learns how a developer writes code, comments and commits, turns that into a style profile, and feeds it to AI coding agents (Claude, Cursor, Copilot, any MCP client) so their output reads like the developer wrote it.

Four outputs:
1. A **style profile** learned from the developer's own git history
2. An **MCP server** that serves the profile and checks/rewrites code against it
3. **Unbot**, an AI-tell linter that flags code and comments that "sound like AI"
4. **Shipped styles**, frozen profiles learned from open source projects, for people whose code is written by an agent and who have no history to learn from. Added 2026-10-03

Two audiences since then.
A developer gets "code that sounds like me".
Someone who prompts an agent for everything gets "code that looks professional": few comments, plain names, short commits, no AI tells.
The second is an extension of the first, not a replacement, and both run through the same profile model.

Later: **team mode**, which learns team rules from PR review comments.

## 2. Principles

- **Local first.** Code never leaves the machine except the samples sent to the LLM provider the user chose.
  Support a fully local option (Ollama or any OpenAI-compatible local server) so nothing leaves the machine at all.
- **LLM is optional.** Every feature has a no-LLM baseline. The LLM improves output, it never gates it.
- **No API key needed.** Most developers have an AI plan, not an API key. The default LLM path is the agent they already use (Claude Code, later Gemini CLI and Codex) run headless on their machine under their own login. API keys and local servers are options, never a requirement. We never read or store their tokens.
- **No backend, no accounts in v1.**
- **Evidence or nothing.** Every rule must be backed by stats or real examples from the user's code. No guessed rules.
- **Only the user's code.** Use git blame and author emails so other people's code never shapes the profile.
- **Never overwrite user files.** Only write inside clearly marked blocks.
- **Measurable.** The eval harness decides if a change made the output more "like me".

## 3. Tech stack

- TypeScript, Node 22+ (20 is end of life, 22 has `path.matchesGlob` and `fs.glob` built in), pnpm workspaces (monorepo)
- `web-tree-sitter` with WASM grammars (no native builds): Kotlin, TypeScript, Python, Go today, Swift and JavaScript later.
  Grammar `.wasm` files are vendored in `packages/core/grammars/` (MIT) and refreshed with `scripts/update-grammars.sh`.
  Reason: `tree-sitter-wasms` is stale (legacy `dylink` section, rejected by current `web-tree-sitter`) and the official grammar packages carry a node-gyp install script.
  Kotlin, TypeScript, Python and Go publish a modern wasm on npm. Swift does not, it must be built once with the tree-sitter CLI and vendored the same way
- `child_process` for git, no wrapper library
- `@modelcontextprotocol/sdk` for the MCP server (stdio transport)
- `commander` for the CLI, `zod` for schemas, `vitest` for tests
- LLM provider interface with adapters: `claude-cli` (default when Claude Code is installed, headless `claude -p --safe-mode --system-prompt --json-schema`, so the user's CLAUDE.md, hooks and plugins stay out of the call), Anthropic, OpenAI, Google Gemini, and `openai-compatible` (any base URL).
  Later: `gemini-cli` and `codex-cli` the same way, once their non-interactive flags are verified.
  Longer term: an MCP prompt `learn_my_style` lets any agent do the writing itself through the MCP server, no CLI needed.
  The `openai-compatible` adapter covers Ollama, LM Studio, vLLM, llama.cpp server and corporate gateways, so local needs no dedicated code.
- Default model per provider lives in one table in `core`. Anthropic default is `claude-opus-5-5`. `model` in config is optional and overrides it
- Dashboard: one HTML page served by the CLI from Node's http module, vanilla JS, no framework and no build step. It grew out of the quiz page, which shares its design tokens in `cli/src/theme.ts`

## 4. Repo structure

Target layout. A package is created when its module is built, so only `core`, `cli`, `eval` and `mcp` exist today.
Unbot did not get its own package: its fast mode is `checkStyle` in core, its deep mode and rewrite are `unbot.ts` in core because the MCP server shares them, and the command is one file in `cli`.

```
packages/
  core/        # collector, analyzer, profile model, profile writer, LLM adapters
  cli/         # `idiolect` command
  mcp/         # MCP server
  eval/        # eval harness
  team/        # PR review mining (team mode)
  dashboard/   # local web UI
data/
  ai-tells.json   # curated list of AI writing habits
  eval-tasks/     # eval task definitions
fixtures/         # test repos (small, committed)
```

`packages/core/styles/` holds the shipped styles, one JSON file each, and ships inside core like the grammars and the tells.

## 5. Data model

The **profile JSON is the source of truth**. `STYLE.md` is rendered from it.

```ts
type Profile = {
  version: 1
  developer: { name: string; emails: string[] }
  generatedAt: string
  sources: { repo: string; head: string; headDate?: string; commits: number; linesOwned: number; stats: Record<Language, LanguageStats> }[]
  stats: Record<Language, LanguageStats>   // merged across repos, counts and histograms only
  rules: Rule[]
}

type Rule = {
  id: string                       // e.g. "kotlin.comments.lowercase-start"
  scope: "personal" | "team"       // project rules are personal rules with `repo` set, see below
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
  kind?: "voice" | "layout" | "idiom"   // what a borrowed profile may serve, see Borrowed profiles below
  paths?: string[]                 // optional glob scope, e.g. "shared/src/**"
  learnedIn?: string               // repo the examples came from, so a rescan replaces only its own rules
  repo?: string                    // set on project rules: served only inside this repo
}
```

Storage:
- Personal profile: `~/.idiolect/profiles/<primary-email>.json` (merged across repos)
- Merging: the analyzer emits counts and bucketed histograms, never ratios or percentiles.
  Merge is a plain sum, so it is exact, order-independent and deterministic. Ratios and percentiles are computed at render time.
  Per-repo stats are kept in `sources[]` so a repo that disagrees with the merged profile can be spotted later.
- Developer config: `~/.idiolect/config.json` (name, all emails across repos, LLM provider). Never inside a repo, so nothing personal can be committed to a team repo
- Per-repo config and cache: `<repo>/.idiolect/config.json` holds repo settings only (languages, ignore, sync targets, thresholds), safe to commit.
  The tool writes `<repo>/.idiolect/.gitignore` with `cache/` and `eval/` the first time it creates the directory, so the host repo's own `.gitignore` is never touched
- Team rules: `<repo>/.idiolect/team.json` (committed)
- Served profile: `profile` in the repo config names the email of the profile this repo serves instead of the developer's own.
  Every command that reads rules goes through `loadServedProfile(repo)`, only `scan`, `status` and `refresh` stay on the developer's own profile.
  Added 2026-10-03 so a profile learned from human-written open source code can be served while the developer's own, mostly agent-written, keeps scanning
- Borrowed profiles: a served profile whose email is not one of the developer's is borrowed.
  Every rule has a kind: voice (naming, phrasing, quantities, does not age), layout (what a formatter decides) or idiom (the choice of a language feature or API, dates with the language).
  The LLM labels its rules, metric rules derive the kind from the metric, older rules fall back on their category.
  `borrow` in the repo config lists the kinds served, default voice and layout. Project rules are never served from a borrowed profile, approved and edited rules always are.
  The render says the style is borrowed, gives the date of the newest commit it was learned from (`headDate` on the source), states that the repo's code, formatter and current language practice win, and labels every language rule.
  The marker is `profile.borrowed`, set by `loadServedProfile` in memory and stripped by `saveProfile`
- Shipped styles, added 2026-10-03 for people whose code is written by an agent and who have no history to learn from.
  A style is a frozen file in `packages/core/styles/<language>-<project>.json`: the personal rules of one scanned profile for one language, its stats, and its source project, licence, commit and snapshot date. It is named after the project, never the person, and holds no emails, no code snippets and no project rules.
  `idiolect styles build` cuts one from a scanned profile. Metric rules go in as measured. A rule the LLM wrote goes in only when a person approved or edited it, because three scans of the same code gave three different rule sets.
  `idiolect styles` lists them by language with a one-line summary of at most 60 characters, written when the style is built. `idiolect styles show <id>` gives the source project, licence, snapshot and rules. The source URL is kept out of the list and out of the block agents read. One project and one main author per style, more projects mean more styles. `idiolect use` without ids is the picker: it counts the project's source files per language, offers only the styles for languages with at least 5% of them, numbers them and reads the numbers, Enter takes them all when each language has one style. `idiolect styles` filters the same way, `--all` on either shows everything, an empty project sees everything. `idiolect use <style...>` writes `styles` into the repo config, one style per language plus the one that owns the commit rules, and syncs. No `~/.idiolect` is needed.
  `composeStyles` turns the picked styles into one borrowed profile, so render, check, Unbot and the MCP server need no special case. `styles` wins over `profile`.
  A shipped style is read-only. Rule decisions made in a repo are stored in `<repo>/.idiolect/overrides.json` and applied on load.
  A style nobody who writes the language has reviewed is marked `experimental`

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
- Commits with an agent trailer (Co-Authored-By: Claude, Copilot, Codex and friends, "Generated with Claude Code") are not the developer's. Their lines are dropped from blame and their messages from the commit list, and `scan` says how many were excluded. On Dissent that is 42 of 523 commits and 11% of the owned lines
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
  - Python: type hint ratio, f-strings vs `.format()`, comprehensions, `@dataclass`, bare `except`. Docstrings are the doc comments: they count toward doc ratios and run through the same voice counters as comments. A leading underscore makes a declaration private, `self.x = ...` is a property, a module-level name holding a literal is a constant
  - Go: `if err != nil` density, named returns, structs vs interfaces, `panic`. A single-value type assertion `x.(T)` feeds the force-unwrap counter, the two-value form does not. Exported means public. The doc comment is the comment block ending on the line above a top-level declaration
  - TS: arrow vs function declarations, `type` vs `interface`, optional chaining, `any`. Non-null `!` feeds the same force-unwrap counter as Kotlin `!!`. Only named functions count as functions, a callback is a lambda. Module-level non-exported declarations count as private for the doc ratios. Test functions are the `function` declarations in test files, `it()` callbacks are not counted, see suggestion 17
- **Commits:** length, lowercase ratio, conventional prefix ratio, tense

Start with **Kotlin only**, add others after M5. TypeScript, Python and Go added 2026-10-02, the shared walk is `analyzeTree` and each language supplies a node counter in `analyzer-<lang>.ts`. `.d.ts` files are ignored, `.tsx` uses the tsx grammar. Expression-body rules exist only for Kotlin and TypeScript.

**Done when:** stats are deterministic and unit-tested against fixtures with known values. TypeScript verified on the author's Firebase functions in Dissent: 148 function declarations by grep versus 147 counted, interfaces and type aliases exact. Python verified on the six scripts in Dissent and on dabeaz/sly against the stdlib `ast` module: every count exact except f-strings, where `ast` also counts nested format specs. Go verified on tidwall/gjson against a regex count: functions, types, error checks and panics exact. TypeScript verified on sindresorhus/ky against the TypeScript compiler API and Kotlin on JakeWharton/picnic against a regex count, both within a few percent and exact on the idiom counters. `scripts/verify/` holds the counters and the isolated-home recipe, so a language nobody here writes can still be checked on a real repo

### M3 Profile writer (`core`)
- Input: stats + sampled snippets (stratified: ~30 functions, ~100 comments, ~100 commit messages, configurable token budget)
- LLM turns stats + samples into `Rule[]` with a fixed prompt and zod-validated JSON output
- **No-LLM baseline:** without a provider configured, render template rules straight from stats (e.g. "p50 function length is 12 lines").
  First run gives value with no key and no local model. The LLM upgrades these into prose and adds the Avoid section
- Every rule must reference a metric or examples, otherwise dropped
- **Avoid section:** check each item in `data/ai-tells.json` against the user's code. If the user basically never does it, add an "avoid" rule.
  Each tell references a metric id from `core/metrics.ts`, so detection is counted by the analyzer, never guessed by the LLM
- **Personal vs project.** The LLM labels each rule personal (holds in any codebase) or project (depends on this codebase's vocabulary, libraries, team conventions). Project rules carry `repo` and are served only inside that repo. Every LLM rule carries `learnedIn`, and a rescan replaces only the rules learned in that repo
- **Kind and wording.** The LLM labels each rule voice, layout or idiom, see Borrowed profiles in the data model. Its own wording uses plain punctuation, no em dashes, arrows or emoji, while a pattern quoted from the samples stays as written. Added 2026-10-03 after a rescan put an em dash into a synced instruction file
- **Not reproducible.** Three scans of the same Tivi code on 2026-10-03 gave three rule sets, one of them contradicting another on a naming habit. For a developer's own profile the review with `idiolect rules` absorbs that. A shipped style therefore takes LLM rules only after a person approved or edited them
- **LLM rules must cite samples.** The model returns rules with example references (file and line). References that were not in the samples sent are dropped, and a rule left without examples is dropped
- Confidence for metric rules is the 95% Wilson lower bound of the ratio, so small samples lower confidence without being dropped outright
- Rules below confidence threshold (default 0.6) are stored but not served
- Per-file spread: the scan counts, for every ratio metric, how many files sit over 0.5 and how many under, among files with at least 5 items. A high or low rule where 15% or more of the files do the opposite gets half confidence and the text says "Varies by file", the same treatment as a habit that varies between repos. Calibrated on the author's TypeScript, where JSDoc is 16% overall but the majority in 8 of 44 files
- Minimum evidence: a metric-based rule needs `sampleSize >= minSampleSize` (default 20) and a ratio of >= 0.8 or <= 0.2.
  Below that the LLM gets the number but is told it is weak and must not turn it into a rule
- On rescan: an approved rule whose text changed becomes `pending`, so a decision is never silently overridden. Auto rules the user never looked at are replaced in place, otherwise a background refresh would drop served rules without anyone deciding
- Decisions: `idiolect rules approve|reject|edit <id>` sets the status. Approved and edited rules are served and kept across rescans, rejected rules are stored but never served and a rescan does not revive them. The MCP server reads the profile per call, so a decision is live immediately, `idiolect sync` has to be re-run by hand
- Render `STYLE.md` (sections: Naming, Comments, Structure, Errors, Framework, Commits, Avoid, then Project conventions inside the repo they came from, then Team rules). A language under 5% of the developer's lines is left out of the full render and served only when asked for by language or file
- Fewer, sharper rules: the render serves every metric rule and every approved or edited rule, then at most three example-backed rules per section by confidence. The writer is asked for at most twelve rules, three per category, with confidence meaning the share of samples that show the habit. The first blind quiz on 2026-10-02 showed why: with eleven comment-voice rules served, the agent applied each one everywhere and the author picked the plain output 10 of 15 times. With the cap alone, same profile, the second quiz that night came out 7 of 15: the over-commenting was gone and the two outputs read alike, so the profile has to add the author's own habits, not only remove noise. A second round rescanned with the new writer prompt and a commit-body wrap rule, judge 13 of 15, but the author stopped quizzing there. The quiz stands at chance, not above it, and the project moved on with that known

**Done when:** running on the author's own repos produces a profile where every rule has evidence and the author agrees with most of it.

### M4 Eval harness (`eval`)
- Task file (`packages/eval/tasks/*.yaml`): id, language, kind (code or commit), prompt. 15 Kotlin tasks and 5 TypeScript tasks ship with the package. The task language picks the generator's persona, the analyzer for the metric distance and the reference samples, so a repo with both languages gets scored per language and the metric names carry the language when a run mixes them
- For each task, generate code **with** and **without** the profile
- Scores:
  1. **Metric distance:** run the analyzer on the output, compare to the user's stats
  2. **LLM judge:** pairwise, "which output matches these reference samples from the developer"
  3. **Blind quiz:** two outputs in random order, the developer picks which sounds like them. `idiolect eval --from <report> --quiz` replays a stored run so the quiz costs no LLM calls.
     The quiz opens in the browser from a localhost server built into the CLI: the two outputs side by side, shared lines dimmed, differing lines highlighted, keys A, B and S. The page never learns which side is the profile until the last pick. `--tty` keeps the terminal version for a shell without a browser. One HTML string in `cli/src/quiz.ts`, no framework, no dependency. This is where the dashboard starts if real usage asks for one
- **The quiz is the headline number.** The judge shares a model with the generator and may flatter its own styled output, so it is a cheap proxy for iteration. The quiz, taken seriously by the author, is the truth
- First real quiz, 2026-10-02, Dissent, 15 tasks, 55-rule profile: the author picked the profile output 5 of 15 times while the judge picked it 15 of 15. He took it several times and stands by it. That is below chance: the profile as served makes the output read less like him, not more, and the judge is flattering its own styled output. This is the verdict the harness was built to produce, and suggestion 13 is the response: fewer, sharper rules, then re-run the eval and the quiz until the quiz is clearly above chance. Context worth keeping in mind: much of Dissent was itself written by agents the author steered, so the profile partly describes an accepted agent style
- Every eval before 2026-10-03 had a tainted baseline. The headless Claude call loaded the author's CLAUDE.md, a SessionStart hook and the agent system prompt, 20 instructions in all, so the "without profile" side was already written under his own style rules. The provider now runs in safe mode with its own system prompt. The quiz has not been retaken since, so the numbers above stand as measured, not as the truth about the profile
- Borrowed styles were measured on 2026-10-03 with the Chris Banes profile on the 15 Kotlin tasks, in an empty repo so no project rules were served: comment lines 17 against 34, KDoc blocks 0 against 7, commit messages 5 to 6 lines against 10 to 12, metric distance to his real code 0.091 against 0.116, code 7% longer from the one-argument-per-line layout. The judge had no reference samples there and its 1 of 15 means nothing
- Output: report with win rate, quiz picks per task and metric distance per category, saved as JSON + Markdown under `<repo>/.idiolect/eval/`

**Done when:** `idiolect eval` prints a win rate, and re-running after a profile change shows the difference.

### M5 MCP server (`mcp`)
stdio transport. Tools:

| Tool | Input | Output |
|---|---|---|
| `get_style` | `file_path?`, `language?` | Rules that apply to that file (language + path scope + team), as Markdown |
| `check_style` | `code`, `language`, `file_path?` | Violations: `{rule_id, line, message, suggestion}` |
| `rewrite_like_me` | `code`, `language`, `scope: comments \| names \| all`, `file_path?` | Rewritten code + list of changes |
| `get_team_rules` | `path` | Team rules for that path with counts |

Also:
- Resource: `style://profile/{language}`
- Prompt: `write_like_me` (instructs the agent to call `get_style` before writing and `check_style` after)

How it works:
- The repo is detected from `file_path` with `git rev-parse --show-toplevel`, falling back to the directory the client started the server in.
  Project rules and the repo's confidence threshold come from there, so the server never needs a `--repo` flag.
- `check_style` is deterministic, no LLM. It runs the analyzer on the code and compares every served metric rule against it.
  A high rule fires when the code's ratio is under 0.5, a low rule over 0.5, an avoid rule on any occurrence, a value rule when the code is more than 1.5x the developer's number.
  Comment and `!!` rules report the offending lines, the rest report one aggregate violation. Voice rules backed only by examples are not checked, that is the LLM's job in Unbot deep mode.
- `rewrite_like_me` needs the configured LLM provider and returns an error that says so otherwise.
- The profile is re-read on every call, so a rescan shows up without restarting the server.

Install:
```
claude mcp add idiolect -- npx -y idiolect mcp
```
Config snippets for Cursor and other MCP clients go in the README at launch.
Published 2026-10-02 as `idiolect@0.0.1` on npm. The org name `idiolect` was taken, so the internal packages live under the author's user scope as `@shakibkhatri/idiolect-core`, `-eval` and `-mcp`. Nobody installs those directly. Grammars, tells and eval tasks ship inside their packages. Release with `pnpm -r publish` after bumping versions.

**Done when:** Claude Code calls `get_style` on a `.kt` file and gets only Kotlin + general rules. Built 2026-10-02, verified over stdio against the author's profile inside the Dissent repo.

### M6 Sync (`cli`)
- `idiolect sync` writes the rendered profile into:
  - `CLAUDE.md`
  - `AGENTS.md`
  - `.cursor/rules/idiolect.mdc`
  - `.github/copilot-instructions.md`
- Only between `<!-- idiolect:start -->` and `<!-- idiolect:end -->`. Never touch anything else.
  A missing block is appended at the end of the file, an existing block is replaced in place
- `GEMINI.md` is the fifth known file since 2026-10-03
- `idiolect use` creates more than sync does, because someone picking a style has no agent files yet: `AGENTS.md` always, `CLAUDE.md` when the `claude` command is installed or the repo has a `.claude` folder, the Cursor rule when it has a `.cursor` folder. The lookup uses `where` on Windows, `which` elsewhere
- Targets: without `sync.targets` in config, the known files are updated if they exist and only `AGENTS.md` is created.
  With `sync.targets` set, or `--target` on the command line, every listed file is written and created if missing.
  A fresh `.mdc` file gets the Cursor frontmatter with `alwaysApply: true`
- Project rules are included because sync runs inside one repo, the same as `idiolect show`

**Done when:** running sync twice changes nothing, and user content outside markers is untouched. Done 2026-10-02, verified on the author's Dissent repo: 78 inserted lines in CLAUDE.md, second run unchanged.

### M7 Unbot, the AI-tell linter (`core` + `cli`)
- `idiolect unbot [files]` checks for AI habits and profile violations. Without files it checks Kotlin files changed since HEAD plus untracked ones, `--staged` checks the index for hooks, `--all` every tracked Kotlin file
- Two modes: fast (`checkStyle`, AST + regex, no LLM) and deep (`--llm`, the LLM checks the example-backed voice rules and returns line-level violations, unknown rule ids and lines outside the file are dropped)
- Examples of AI tells: comments restating the code, "This function...", words like "robust", "seamless", "leverage", "comprehensive", docblocks on trivial private functions, over-generic names (`handleData`, `processItem`), try/catch around everything, emoji in comments. These come from the profile's avoid rules, so a tell the developer actually does is not flagged for them
- Quantity rules only fire with enough data in the file: at least 10 items for medians and ratios, 100 lines for densities, 3 items for ratio rules that point at lines, and a value rule needs 2x the developer's number. All four live in the repo config as `check.minItems`, `check.minLines`, `check.minLocated` and `check.excess`, and the MCP `check_style` reads the same values. Avoid rules fire on a single occurrence. Calibrated on the author's repo: 41 of 799 of his own files flagged, 18 of those real `!!`, emoji and TODO occurrences
- `--fix` rewrites each flagged file with the same `rewriteLikeMe` the MCP tool uses and re-checks it
- `idiolect hooks install` writes a pre-commit hook running `idiolect unbot --staged`, appends to `.husky/pre-commit` when present, and points at lefthook.yml instead of editing it
- Default: warn only. `--strict`: non-zero exit
- Unbot needs a profile, `idiolect scan --no-llm` makes one without any LLM

**Done when:** a file of typical AI-written Kotlin gets flagged and `--fix` produces something that passes the check and reads like the developer. Done 2026-10-02: `fixtures/kotlin/AiWritten.kt` gets 7 fast and 11 deep violations in Dissent, `--fix` left 0 and produced elvis guards, expression bodies and a one-line KDoc. The judge was not run on it, see suggestion 15

### M8 Auto refresh (`cli`)
- `idiolect refresh` compares HEAD with the head stored for this repo in the profile. At `refresh.everyCommits` new commits (default 50), or with `--force`, it starts `idiolect scan` detached and returns at once, logging to `.idiolect/cache/refresh.log`. Below the count it prints nothing
- `idiolect hooks install` adds it as a post-commit hook next to the pre-commit unbot hook
- Changed approved rules go to `pending`, the user decides with `idiolect rules`
- `idiolect status` shows profile age, rule counts, the pending rules, the last scan of this repo, commits since and when the refresh is due

### M9 Team mode (`team`)
- Source: GitHub (token or `gh` auth), GitLab later
- Fetch PR review comments + review bodies for last N months
- LLM classifies: convention/style comment vs other (bugs, questions, praise)
- Cluster similar comments, count them, map to file paths
- Generate team rules with `count` and links to example comments
- Write to `.idiolect/team.json` (committed, reviewed like code)
- Later: GitHub App that updates team rules automatically and comments on PRs

**Done when:** on a real repo with reviews, the top 5 team rules match what the team would say.

### M10 Dashboard (`cli`)
- `idiolect ui` starts a local web server and opens the browser, `--no-open` and `--port` for scripts
- Rules: every rule with its status, confidence, language and whether it is served here, filter by status, language and category, search, expand for the metric or the code examples, approve, reject and edit in place. A pending rule shows the approved text it replaced, which the profile keeps as `previousText` until a decision is made
- Profile: the STYLE.md as served in this repo, or one language alone, rendered from the live profile so a decision shows up on the next load
- Evals: every run in the repo with judge, quiz and metric distance, open one to read the pairs with the verdict and the pick. The quiz itself stays a command because it must stay blind
- Status: rule counts, languages with their share of lines, repos with commits since their scan
- Local only, no login. Not a package of its own: it is `cli/src/ui.ts`, one file, because the MCP server and the CLI already hold every function it calls
- Built 2026-10-02 against the author's live profile in Dissent, the first day the author asked for it. The spec said after real usage, and the author reviewing 82 rules was the real usage. Unbot in the browser and running an eval from it are not built

## 7. CLI

```
idiolect init                 # detect emails, languages, create config
idiolect scan [--repo ...]    # collect + analyze + write profile
idiolect show [--lang kotlin] [--email <profile>] # print STYLE.md as served here, or one stored profile in full
idiolect sync                 # write into agent instruction files
idiolect rules list|show|approve|reject|edit <id>   # decide on pending or wrong rules, decisions survive rescans
idiolect unbot [files] [--fix] [--llm] [--strict]
idiolect hooks install
idiolect eval [--quiz]
idiolect status
idiolect refresh [--force]
idiolect team scan            # team mode
idiolect mcp                  # start MCP server
idiolect ui [--repo] [--port] [--no-open]   # dashboard
idiolect styles [--all]       # shipped styles for the languages of this project
idiolect styles show <id>     # source project, licence, snapshot and rules of one style
idiolect styles build ...     # maintainers: cut a style from a scanned, reviewed profile
idiolect use [style...] [--all] [--target <file...>]   # pick styles by number, or by id, and sync
```

Commands that only read rules need no `~/.idiolect/config.json`: `use`, `styles`, `sync`, `show`, `rules`, `unbot` without `--llm` and `--fix`, `ui` and `mcp`.

## 8. Config

Developer, `~/.idiolect/config.json`:

```json
{
  "name": "Me",
  "emails": ["me@example.com", "me@work.com"],
  "llm": { "provider": "claude-cli" }
}
```

Other providers: `{ "provider": "anthropic", "model": "claude-opus-5-5", "apiKeyEnv": "ANTHROPIC_API_KEY" }` or `{ "provider": "openai-compatible", "baseUrl": "http://localhost:11434/v1", "model": "<model>" }`.

Repo, `<repo>/.idiolect/config.json`, every field optional:

```json
{
  "languages": ["kotlin"],
  "sampling": { "maxTokens": 40000 },
  "confidenceThreshold": 0.6,
  "minSampleSize": 20,
  "sync": { "targets": ["AGENTS.md", "CLAUDE.md", ".cursor/rules/idiolect.mdc"] },
  "refresh": { "everyCommits": 50 },
  "check": { "minItems": 10, "minLines": 100, "minLocated": 3, "excess": 2 },
  "ignore": ["**/build/**", "**/generated/**"],
  "styles": { "kotlin": "kotlin-tivi", "typescript": "typescript-vue", "commits": "kotlin-tivi" },
  "profile": "someone@example.com",
  "borrow": ["voice", "layout"]
}
```

`styles` is written by `idiolect use` and wins over `profile`.
`profile` names a stored profile to serve instead of the developer's own.
`borrow` lists the kinds of rules served from either, idiom is left out by default.
`<repo>/.idiolect/overrides.json` holds the rule decisions made on shipped styles in that repo and is safe to commit.

## 9. Privacy and security

- No telemetry by default
- Show exactly what will be sent to the LLM (`--dry-run` prints samples + token count)
- Redact secrets in samples (API keys, tokens, `.env` style values) before sending
- Fully offline option via any OpenAI-compatible local server (Ollama, LM Studio, vLLM, llama.cpp)
- `idiolect init` asks which provider to use and explains what each one receives
- The headless Claude Code call runs in safe mode with idiolect's own system prompt, so the user's CLAUDE.md, hooks, skills and plugins are neither sent along nor allowed to shape the rules
- A shipped style holds no author email, no code snippet and no project rule. A test checks every style file for all three
- Team mode tokens read from env or `gh`, never stored in plain config

## 10. Testing

- Unit tests for every analyzer metric with small fixture files and known expected values
- Fixture repos with multiple authors for the collector
- Snapshot tests for `STYLE.md` rendering and sync
- MCP tests: in-memory transport, call each tool, validate output schemas
- LLM calls mocked in unit tests, real calls only in `eval`

## 11. Build order

0. **Spike:** parse one real Kotlin file with `web-tree-sitter`, print the AST. Done 2026-10-02, see `packages/core/src/parser.test.ts`
1. **M1 Collector** + **M2 Analyzer** (Kotlin). Done 2026-10-02
2. **M3 Profile writer** + `STYLE.md`. Done 2026-10-02, author reviewed the rules from two repos and found them correct
3. **M4 Eval harness** - prove it works on the author's own repos before going further. Built 2026-10-02. Judge 7/7 for the profile on two repos. Metric table hinted the profile over-comments, so STYLE.md puts quantity rules first. Blind quiz on Dissent 5 of 15 on 2026-10-02, judge 15 of 15. Below chance, the author stands by it, suggestion 13 is next
4. **M5 MCP server** + **M6 Sync**. Both done 2026-10-02. `get_style` over stdio returns the same 46 rules as `idiolect show` inside the repo, sync is idempotent on the author's repo
4b. `idiolect rules` done 2026-10-02. Verified in Dissent: reject, approve and edit all survived `idiolect scan --no-llm`
5. **M7 Unbot linter**. Done 2026-10-02, verified in Dissent, see M7
6. **Launch:** README with before/after examples, post on Hacker News, r/programming, r/ClaudeAI
7. Add languages (Swift, TS, Python, Go), **M8 Auto refresh**. M8 done 2026-10-02. TypeScript, Python and Go done 2026-10-02, TypeScript and Python verified in Dissent, Go on its fixture. Swift still needs its grammar built
8. **M9 Team mode**, **M10 Dashboard** - only after real usage. M10 built 2026-10-02 as one page in the CLI, see M10
9. **Shipped styles**, 2026-10-03, released as 0.1.0 to 0.1.2. In order: a repo can serve another profile, borrowed profiles serve voice and layout only, the headless Claude leak fixed, the catalogue with `styles` and `use`, the short list with `styles show`, the numbered picker limited to the project's languages, Claude Code found on Windows. Installed from npm on a Windows laptop and picked a style there

## 12. Out of scope for v1

- Hosted backend, accounts, payments
- IDE plugins (MCP + sync cover this)
- Training or fine-tuning models

## 13. Open questions

- Grab domain (idiolect.dev) and GitHub org
- Pricing: free personal, paid team mode?
- Should profiles be shareable/exportable ("use my style on a new machine")? Shipped styles answer half of it: `styles build` already cuts a shareable file from a profile. Loading a style file from outside the package is not built
- Naming a style after its author needs that person's consent. Until someone asks one, styles are named after the project
- How the catalogue grows: one project and one main author per style. Merging four authors into one profile on 2026-10-03 produced rules that contradicted each other
