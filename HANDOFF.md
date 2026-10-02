# Handoff

Read this first, then `SPEC.md`, then `SUGGESTIONS.md` and `bugs/`.
It was written on 2026-10-02 at the end of the first day of work.
Every statement here was true at that point.
Verify against the code before relying on anything that could have moved.

## What Idiolect is

A local-first CLI that learns how one developer writes Kotlin, comments and commits from their own git history, turns that into a style profile, and feeds it to AI coding agents.
The owner is Shakib Khatri, personal GitHub `shakibkhatri`, repo `github.com/shakibkhatri/Idiolect`.
This is a personal project, so commits use `shakibkhatri@gmail.com`, set in the repo-local git config.
The first commit still carries his work email because the amend needed a force-push he has to run himself.

## State of the build

Spec section 11 lists the build order.
M1 collector, M2 analyzer, M3 profile writer, M4 eval harness, M5 MCP server and M6 sync are built, tested and committed.
Tests: `pnpm test` runs 24 vitest tests, all green.
Typecheck: `pnpm typecheck`.
Build: `pnpm build`, which must run before the global `idiolect` command picks up changes.
The CLI is linked globally with `npm link` from `packages/cli`, so `idiolect` on this machine runs `packages/cli/dist/index.js`.

Not built: M7 Unbot linter, M8 auto refresh, M9 team mode, M10 dashboard.
M7 is the obvious next step, and `checkStyle` in core is already its fast mode.

## Repo layout

```
packages/core    collector, analyzer, metrics, baseline rules, sampler, redact, llm providers, writer, render, config, profile
packages/cli     idiolect init | scan | show | eval | mcp | sync
packages/eval    task loading, with/without generation, judge, metric distance, report
packages/mcp     createIdiolectServer: four tools, one resource, one prompt, transport-agnostic
data/ai-tells.json       AI writing habits, each tied to a metric id
data/eval-tasks/*.yaml   15 Kotlin tasks, two of them commit messages
fixtures/kotlin          one Kotlin file used by parser and analyzer tests
scripts/update-grammars.sh   refreshes vendored tree-sitter wasm grammars from npm
packages/core/grammars   vendored kotlin.wasm plus license
```

Only `core`, `cli`, `eval` and `mcp` exist.
The spec lists more packages, they get created when their module is built, not before.

## How the pipeline works

Collector (`core/src/collector.ts`): `git ls-tree` at HEAD for files, `git blame -w --line-porcelain` per file for owned line ranges, `git log` for the author's commits.
Cache per file by blob hash in `<repo>/.idiolect/cache/collector.json`, so warm rescans take about 100 ms.

Analyzer (`core/src/analyzer.ts`): one tree-sitter walk per file producing counts and histograms only, never ratios.
`mergeStats` is a generic deep sum.
Test files, detected by `isTestPath`, keep structural stats but route function names to `naming.testNames`.
Only nodes whose first line the developer owns are counted.

Metrics (`core/src/metrics.ts`): named ratio and percentile functions over stats.
Baseline (`core/src/baseline.ts`): deterministic rules from metrics, high fires at ratio >= 0.8, low at <= 0.2, value rules always.
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
The same function will be Unbot's fast mode.

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

1. Get the real blind quiz result from Shakib and record it in the spec M4 line.
2. If the quiz is near chance, work `SUGGESTIONS.md` item 13: cap voice rules, ask for fewer sharper rules.
3. Shakib runs `claude mcp add idiolect -- idiolect mcp` and tries `get_style` and `check_style` from Claude Code inside Dissent.
4. Shakib runs `idiolect sync` inside Dissent and commits the block in CLAUDE.md if he likes it.
   Running `idiolect scan` once more also drops the new `.idiolect/.gitignore`, until then `.idiolect/` shows as untracked there.
5. `idiolect rules approve|reject|edit` so pending rules have a path (suggestion 7).
6. Then M7 Unbot: `idiolect unbot [files]` is `checkStyle` per file, `--llm` adds voice, `--fix` calls the rewrite.

## Things that bit us, so you do not repeat them

Running `idiolect scan --no-llm` used to wipe LLM rules, fixed, but any change to `writeRules` should keep the test that covers it.
Backtick and camelCase sentence test names pollute verb stats unless routed to `testNames`.
`claude -p --bare` cannot see the user's login, do not add `--bare`.
Claude Code's `--json-schema` rejects the `$schema` key zod emits, `jsonSchema()` strips it.
zod is v4 because the Anthropic helper needs it, use `.prefault({})` not `.default({})` for nested objects.
The vendored Kotlin grammar errors on semicolon-separated class members, see `bugs/001`.
