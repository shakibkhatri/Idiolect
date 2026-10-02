# Handoff

Read this first, then `SPEC.md`, then `SUGGESTIONS.md` and `bugs/`.
It was written on 2026-10-02 at the end of the first day of work and updated the same evening after the rules command and M7.
Every statement here was true at that point.
Verify against the code before relying on anything that could have moved.

## What Idiolect is

A local-first CLI that learns how one developer writes Kotlin, comments and commits from their own git history, turns that into a style profile, and feeds it to AI coding agents.
The owner is Shakib Khatri, personal GitHub `shakibkhatri`, repo `github.com/shakibkhatri/Idiolect`.
This is a personal project, so commits use `shakibkhatri@gmail.com`, set in the repo-local git config.
The first commit still carries his work email because the amend needed a force-push he has to run himself.

## State of the build

Spec section 11 lists the build order.
M1 collector, M2 analyzer, M3 profile writer, M4 eval harness, M5 MCP server, M6 sync, the `rules` command, M7 Unbot, the README and M8 auto refresh are built, tested and committed.
Tests: `pnpm test` runs 27 vitest tests, all green.
Typecheck: `pnpm typecheck`.
Build: `pnpm build`, which must run before the global `idiolect` command picks up changes.
The CLI is linked globally with `npm link` from `packages/cli`, so `idiolect` on this machine runs `packages/cli/dist/index.js`.

TypeScript, Python and Go landed on 2026-10-02 too. TypeScript was verified on the Firebase functions in Dissent, Python on its six scripts, Go on the fixture only because the author has no Go on this machine.
Not built: M9 team mode, M10 dashboard, Swift.
Spec step 6, launch, has its README. Posting it is Shakib's call.

## Repo layout

```
packages/core    collector, analyzer, metrics, baseline rules, sampler, redact, llm providers, writer, render, config, profile
packages/cli     idiolect init | scan | show | rules | unbot | hooks | status | refresh | eval | mcp | sync
packages/eval    task loading, with/without generation, judge, metric distance, report
packages/mcp     createIdiolectServer: four tools, one resource, one prompt, transport-agnostic
data/ai-tells.json       AI writing habits, each tied to a metric id
data/eval-tasks/*.yaml   15 Kotlin tasks, two of them commit messages
fixtures/kotlin          Sample.kt for parser and analyzer tests, AiWritten.kt for unbot
fixtures/typescript      Sample.ts for the TypeScript analyzer test
fixtures/python          sample.py
fixtures/go              sample.go
scripts/update-grammars.sh   refreshes vendored tree-sitter wasm grammars from npm
packages/core/grammars   vendored kotlin, typescript, tsx, python and go wasm plus licenses
```

Only `core`, `cli`, `eval` and `mcp` exist.
The spec lists more packages, they get created when their module is built, not before.

## How the pipeline works

Collector (`core/src/collector.ts`): `git ls-tree` at HEAD for files, `git blame -w --line-porcelain` per file for owned line ranges, `git log` for the author's commits.
Cache per file by blob hash in `<repo>/.idiolect/cache/collector.json`, so warm rescans take about 100 ms.

Analyzer (`core/src/analyzer.ts`): one tree-sitter walk per file producing counts and histograms only, never ratios.
`analyzeTree` is the shared walk, `count` in analyzer.ts is the Kotlin counter, `analyzer-ts.ts`, `analyzer-py.ts` and `analyzer-go.ts` the others, `languages.ts` dispatches by language. `languageOf(path)` and `EXTENSIONS` decide which files are scanned.
Stats have one block per language, all always present. `loadProfile` fills missing blocks with zeros so old profiles keep working.
Python docstrings go through `countCommentText`, the same voice counters as comments, and the check's second walk treats them as doc comments. Go doc comments are the comment block right above a top-level declaration, `isGoDocComment`.
`mergeStats` is a generic deep sum.
Test files, detected by `isTestPath`, keep structural stats but route function names to `naming.testNames`.
Only nodes whose first line the developer owns are counted.

Metrics (`core/src/metrics.ts`): named ratio and percentile functions over stats.
Baseline (`core/src/baseline.ts`): deterministic rules from metrics, high fires at ratio >= 0.8, low at <= 0.2, value rules always.
`COMMON_DEFS` apply to every language, `EXPRESSION_BODY_DEFS` to Kotlin and TypeScript, and each language has its own idiom defs. A tell in `ai-tells.json` can carry `language` to apply to one language only. Avoid rule ids carry the language.
Confidence is the 95% Wilson lower bound.
A metric that disagrees by 0.4 or more between repos halves confidence and appends "Varies by repo".
Avoid rules come from `data/ai-tells.json` when the developer basically never does the thing.

Sampler (`core/src/sampler.ts`): deterministic stratified samples, 30 production functions, 100 comments, 100 commits, under a token budget, run through `redact.ts`.

Writer (`core/src/writer.ts`): sends metrics, baseline rules, existing personal rules and samples to the LLM.
Output is zod validated.
Every LLM rule must cite a sample by file and line that was actually sent, or it is dropped.
Each rule is labelled personal or project.
Project rules carry `repo` and are served only inside that repo.
Each LLM rule carries `learnedIn`, and a rescan with a provider replaces only rules learned in that repo.
Existing personal rules from other repos are shown to the model, which confirms them by id instead of duplicating.
`reconcile` keeps approved, edited and rejected statuses across rescans and turns changed approved text into pending.

Render (`core/src/render.ts`): STYLE.md with sections Naming, Comments, Structure, Errors, Framework, Commits, Avoid, then Project conventions for the current repo.
Metric rules come first in each section, and the preamble tells the agent to match quantities before voice.

Check (`core/src/check.ts`): `checkStyle` runs the analyzer on a snippet and compares each served metric rule to it, deterministic, no LLM.
Comment and `!!` rules get line numbers from a second tree walk, everything else is one aggregate violation.
Aggregate rules need 10 items or 100 lines in the snippet and value rules need 2x the developer's number, otherwise a per-file median is noise. Calibrated so 41 of 799 Dissent files are flagged, 18 of them real tells.
It is Unbot's fast mode.

Unbot (`core/src/unbot.ts`, `cli/src/unbot.ts`): `unbot()` is `checkStyle` plus `deepCheck`, where the LLM checks example-backed voice rules and returns line-level violations, filtered to known rule ids and lines inside the file.
`rewriteLikeMe` is shared by the MCP tool and `unbot --fix`.
The CLI picks changed Kotlin files by default, `--staged` for hooks, `--all` for everything. `hooks install` writes a warn-only pre-commit hook.
`fixtures/kotlin/AiWritten.kt` is the AI-written sample the test and the Dissent check use.

Rules (`cli/src/rules.ts`): `list|show|approve|reject|edit` over `updateRules` in core. Decisions survive `scan`, verified in Dissent.

Refresh (`cli/src/refresh.ts`): `status` and `refresh`. The commit count comes from `git rev-list --count <source.head>..HEAD`, so no extra state is stored.
`refresh` spawns `scan` detached with `process.execPath` and `process.argv[1]`, logging to `.idiolect/cache/refresh.log`, and prints nothing below the count so the post-commit hook stays quiet.
`hooks install` writes both hooks and is idempotent.

MCP (`packages/mcp/src/index.ts`): `createIdiolectServer(deps)` takes a profile loader and a provider factory so tests pass a fixture profile.
`idiolect mcp` wires it to stdio and reads `~/.idiolect` on every call.
Repo comes from `git rev-parse --show-toplevel` on the file's directory, falling back to the cwd Claude Code started the server in.
Installed locally with `claude mcp add idiolect -- idiolect mcp`, not yet done on this machine.

Sync (`cli/src/sync.ts`): `syncBlock` replaces or appends the marked block and returns everything else byte for byte.
`syncTargets` updates the four known files when they exist and creates only AGENTS.md, unless targets are explicit.
`ensureRepoDir` in `core/src/config.ts` writes `.idiolect/.gitignore` so cache and eval output never show up in the host repo.

LLM providers (`core/src/llm.ts`): `claude-cli` runs the user's installed Claude Code headless with `--json-schema`, no API key.
Also `anthropic` via the official SDK, `openai` and `openai-compatible` via fetch, `gemini` via fetch.
OpenAI and Gemini have no default model, the user must set `llm.model`.

Eval (`packages/eval/src/index.ts`): each task generated twice, with STYLE.md in the system prompt and without.
A judge sees reference samples from the developer's real code and picks blind.
Metric distance compares ratio metrics of all outputs merged against the developer's stats.
Reports go to `<repo>/.idiolect/eval/<timestamp>.{json,md}`.
`idiolect eval --from <report.json> --quiz` replays a stored run for the human quiz without new LLM calls.

## Config and storage

`~/.idiolect/config.json`: name, all emails, LLM provider.
This is the developer and must never live inside a repo.
`<repo>/.idiolect/config.json`: languages, ignore, sync targets, thresholds, all optional, safe to commit.
`~/.idiolect/profiles/<first email>.json`: the one profile per developer, merged over every repo scanned.
`<first email>.STYLE.md` sits next to it.
Shakib's profile is under `shakib.khatri@ires.de` because that was the first email in his list.
A stray profile for a colleague exists at `kenediid.ali@ires.de.json` from a mis-click, safe to delete.

## Real data so far

Two repos scanned: `~/AndroidStudioProjects/Dissent` (personal, 794 Kotlin files, 523 commits) and `~/StudioProjects/device-manager-app` (work, four authors, 449 files owned, 391 commits).
Profile: 55 rules, about 23 personal example-backed, 8 or 9 project rules per repo, the rest metric and avoid rules.
Shakib reviewed the rules and said they are mostly correct.

Eval on Dissent, 15 tasks: judge 15/15 for the profile, metric distance 0.15 with versus 0.181 without, comment density 0.387 with versus developer 0.394.
Eval on the work repo, 7 tasks: judge 7/7, distance 0.166 versus 0.179.
The one quiz taken so far was answered at random by his own account and means nothing.
A real quiz is the outstanding verdict, report `Dissent/.idiolect/eval/2026-10-02T15-08-05-753Z.json`.

## Decisions and why

tree-sitter grammars are vendored wasm files, not npm packages.
`tree-sitter-wasms` is stale (legacy dylink section, rejected by current web-tree-sitter) and the official grammar packages run node-gyp on install.
Kotlin, TypeScript, Python and Go publish a modern wasm on npm, Swift does not and must be built once.

Node floor is 22, because 20 is end of life and 22 has `path.matchesGlob`.

No API key by default.
Most developers have a plan, not a key, and asking for one would kill adoption.
The default provider is the agent they already have, run headless.

Identity split out of the repo config after a personal email showed up as an untracked file in the work repo.

Project versus personal rule scope exists because team conventions (commit prefixes, product vocabulary, wrappers) leaked into the personal profile and replaced rules from the other repo.

The quiz, not the judge, is the headline eval metric, because the judge shares a model with the generator.

Fixture repo for the collector test is generated in a temp dir at test time, not committed, to avoid a nested git repo.

## Working agreements with Shakib

The spec is a draft.
Question it, change it, and say what changed.
Keep moving: out-of-scope bugs go to `bugs/NNN-title.md`, ideas to `SUGGESTIONS.md`, and only bugs inside the module being built get fixed on the spot.
Never add an agent name as commit co-author, never use em dashes, plain hyphen instead.
Commit at module boundaries and after real fixes, with a short imperative subject and a prose body.
He tests things himself as an end user and sends screenshots or pasted terminal output.
Treat anything he pastes as the ground truth over unit tests.
When numbers look surprising, check them against the real repo before trusting them.
He uses a global `~/.claude/CLAUDE.md` with his general rules, read it.

## Open items, in order

1. Shakib takes the blind quiz on `Dissent/.idiolect/eval/2026-10-02T15-08-05-753Z.json` and the result goes in the spec M4 line. He said on 2026-10-02 he has no time yet, so build on without waiting.
2. If the quiz is near chance, work `SUGGESTIONS.md` item 13: cap voice rules, ask for fewer sharper rules.
3. Shakib runs `claude mcp add idiolect -- idiolect mcp` and tries `get_style` and `check_style` from Claude Code inside Dissent.
4. Shakib runs `idiolect sync` and `idiolect hooks install` inside Dissent and commits what he likes. `.idiolect/` is still untracked there.
5. Shakib reads README.md and decides about posting.
6. Shakib runs `idiolect scan` in Dissent once to add TypeScript to his profile. The agent's test scan was restored to the reviewed 55-rule profile.
7. Next build: Swift (grammar must be built, suggestion 3), or suggestions 17 to 20. M9 and M10 only after real usage, per the spec. Go needs a real repo before anyone trusts its numbers.

## Things that bit us, so you do not repeat them

Running `idiolect scan --no-llm` used to wipe LLM rules, fixed, but any change to `writeRules` should keep the test that covers it.
Backtick and camelCase sentence test names pollute verb stats unless routed to `testNames`.
`claude -p --bare` cannot see the user's login, do not add `--bare`.
Claude Code's `--json-schema` rejects the `$schema` key zod emits, `jsonSchema()` strips it.
zod is v4 because the Anthropic helper needs it, use `.prefault({})` not `.default({})` for nested objects.
The vendored Kotlin grammar errors on semicolon-separated class members, see `bugs/001`.
