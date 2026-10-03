# Handoff

Read this first, then `SPEC.md`, then `SUGGESTIONS.md` and `bugs/`.
`CLI.md` is the brief for the next piece of work, the CLI redesign.
Written on 2026-10-02 at the end of the first day of work, rewritten the same night after the release, and again late that night after suggestion 13 and six smaller items.
Updated on 2026-10-03 after shipped styles and the 0.1.0, 0.1.1 and 0.1.2 releases.
Every statement here was true at that point.
Verify against the code before relying on anything that could have moved.

## What Idiolect is

A local-first CLI that learns how one developer writes code, comments and commits from their own git history, turns that into a style profile, and feeds it to AI coding agents through instruction files and an MCP server.
Unbot is its linter: flags code that breaks the developer's measured habits or sounds like AI, and can rewrite it.
Since 2026-10-03 it has a second audience: people whose code is written by an agent and who have no history to learn from. They pick a shipped style, a frozen profile learned from an open source project, and get "code that looks professional" instead of "code that sounds like me". It is an extension, the personal flow is unchanged.
The owner is Shakib Khatri, GitHub `shakibkhatri`, repo `github.com/shakibkhatri/Idiolect`.
Commits use `shakibkhatri@gmail.com`, set in the repo-local git config.
The first commit still carries his work email because the amend needs a force-push he has to run himself.

## Where things stand

Published on npm as `idiolect@0.1.2` with `@shakibkhatri/idiolect-core`, `-eval` and `-mcp` at the same version, tagged `v0.1.2`, pushed to GitHub. 0.0.1 was the first day, 0.1.0 added shipped styles, 0.1.1 the short list and the numbered picker, 0.1.2 found Claude Code on Windows.
Shakib installs each release with `npm install -g idiolect` on a Windows laptop. With 0.1.1 he listed the styles and picked `typescript-vue` by number in a TypeScript project there. Scans and other LLM calls are untested on Windows, suggestion 27.
Everything in the spec build order up to and including M8 exists: collector, analyzer, profile writer, eval, MCP server, sync, Unbot, auto refresh, plus the `rules` command.
Languages: Kotlin, TypeScript, Python, Go. Swift is the only spec language left and needs its grammar built with the tree-sitter CLI.
Built on top since: the dashboard `idiolect ui` (M10), shipped styles with `idiolect styles` and `idiolect use`. Not built: M9 team mode.
Tests: `pnpm test`, 58 vitest tests, all green. `pnpm typecheck`. `pnpm build` must run before the global `idiolect` picks up changes.
On this machine `idiolect` is the npm-linked dev build from `packages/cli`, not the published one. Keep it that way while developing.

## The verdict, where it stands

The quiz is the headline metric: the developer sees the profile output and the plain output blind and picks which sounds like them.
First quiz, 55-rule profile, 2026-10-02 afternoon: 5 of 15 for the profile, judge 15 of 15. Below chance.
Suggestion 13 followed the same night. Round 1 capped voice rules at three per section in the render: quiz 7 of 15, judge 11 of 15, and the profile output stopped carrying more comment lines than the plain one.
Round 2 rescanned Dissent with a writer prompt that asks for at most twelve rules and defines confidence as the share of samples, plus a new commit-body wrap rule: judge 13 of 15, metric distance 0.136 against 0.140.
Shakib stopped quizzing before grading round 2, so it has no quiz. The quiz stands at chance. He decided to move on with that known, and the spec says so.
What the lost pairs taught: once the over-commenting was gone, the two outputs read alike and his picks looked like noise. In composable-card he picked the plain output although it carried the only doc block. The profile needs to add his habits, not only remove noise, and suggestion 22 records that the question itself may be wrong for a repo mostly written by agents he steered.
The round 2 profile was scanned under a backup and his live profile was restored afterwards. His live profile is still the 79-rule one from before Python, the test names, the spread and the agent-trailer exclusion. One `idiolect scan` in Dissent rebuilds it with everything.
Reports in Dissent: `2026-10-02T15-08-05-753Z` is the first profile with his 6 of 15 retake, `2026-10-02T20-49-47-640Z` round 1 with 7 of 15, `2026-10-02T21-29-38-667Z` round 2 ungraded, `2026-10-02T21-38-39-950Z` a two-task TypeScript smoke test.

The baseline of every quiz and eval above was tainted, found 2026-10-03: the headless Claude call carried Shakib's own CLAUDE.md, so the plain output was already written under his rules. See the leak entry under things that bit us. The quiz has not been retaken with the fixed provider, suggestion 29.
Borrowed styles were measured the same day with the profile learned from Tivi in an empty repo: comment lines 17 against 34, no KDoc against 7 blocks, commit messages half as long, code 7% longer. Shakib used it for real work in Dissent and judged it better than plain agent rules. Reports are in `~/idiolect-oss/reports/`.

## Repo layout

```
packages/core    collector, analyzers, metrics, baseline rules, sampler, redact, llm providers, writer, render, check, unbot, config, profile, styles, served
packages/cli     idiolect init | scan | show | rules | unbot | hooks | status | refresh | eval | mcp | sync | ui | styles | use
packages/eval    task loading, with/without generation, judge, metric distance, report; tasks/ holds 15 Kotlin and 5 TypeScript tasks
packages/mcp     createIdiolectServer: get_style, check_style, rewrite_like_me, get_team_rules, one resource, one prompt
packages/core/grammars   vendored kotlin, typescript, tsx, python, go wasm plus licenses
packages/core/data/ai-tells.json   AI writing habits tied to metric ids, some per language
packages/core/styles/    the shipped styles, one JSON file each: kotlin-tivi, typescript-vue, python-httpx, go-caddy
fixtures/kotlin|typescript|python|go   one parallel sample program per language, plus AiWritten.kt for Unbot
scripts/update-grammars.sh   refreshes the vendored grammars from npm, edit the table, run, commit
scripts/verify/              second-opinion counters per language and the recipe for checking a language on a real repo
scripts/styles/README.md     the recipe for adding a shipped style
```

## How the pipeline works

Collector (`core/src/collector.ts`): `git ls-tree` at HEAD for files, `git blame -w --line-porcelain` per file for owned line ranges, `git log` for the author's commits.
Commits whose message carries an agent trailer (Claude, Copilot, Codex, Gemini, Cursor, Devin, Aider) are listed once per scan with `git log --grep`. Their lines are dropped while parsing blame and their messages from the commit list, and `scan` prints how many were excluded. Dissent: 42 commits, owned lines 106792 down to 95536.
Cache per file by blob hash in `<repo>/.idiolect/cache/collector.json`. The cache records the email list it was built for and is discarded when the list changes.
`.d.ts` files and the usual build and vendor dirs are ignored by default, plus `.idiolectignore`.

Analyzer (`core/src/analyzer.ts` and `analyzer-ts.ts`, `analyzer-py.ts`, `analyzer-go.ts`): `analyzeTree` is one tree-sitter walk, each language supplies a node counter, `languages.ts` dispatches.
Output is counts and histograms only, never ratios, so `mergeStats` is a plain deep sum.
Only nodes whose first line the developer owns are counted. Test files, detected by `isTestPath`, keep structural stats but route names to `naming.testNames`.
TypeScript test files count `it()` and `test()` calls as test functions named by their string.
Python docstrings run through the same voice counters as comments and count as doc comments. Go doc comments are the comment block right above a top-level declaration.
Stats have one block per language, all always present. `loadProfile` fills missing blocks with zeros so older profiles keep working.

Metrics (`core/src/metrics.ts`): named ratio and percentile functions over stats. `fileSpread` counts, per ratio metric, how many files sit over and under 0.5.

Baseline (`core/src/baseline.ts`): deterministic rules from metrics. High fires at ratio >= 0.8, low at <= 0.2, value rules always, each language has common defs plus idiom defs.
Confidence is the 95% Wilson lower bound.
Confidence is halved and the text annotated when a metric disagrees by 0.4 between repos ("Varies by repo") or when 15% or more of files do the opposite ("Varies by file").
Avoid rules come from `ai-tells.json` when the developer basically never does the thing. Their ids carry the language.

Sampler (`core/src/sampler.ts`): deterministic stratified samples, 30 production functions, 100 comments, 100 commits, under a token budget, through `redact.ts`.

Writer (`core/src/writer.ts`): sends metrics, baseline rules, existing personal rules and samples to the LLM. Output is zod validated.
Every LLM rule must cite a sample that was actually sent or it is dropped. Rules are personal or project. Project rules carry `repo` and are served only inside that repo.
Each LLM rule carries `learnedIn`, a rescan replaces only rules learned in that repo, existing personal rules are confirmed by id instead of duplicated.
`reconcile` keeps approved, edited and rejected statuses across rescans. An approved rule whose text changed becomes pending. Auto rules are replaced in place.

Render (`core/src/render.ts`): STYLE.md with Naming, Comments, Structure, Errors, Framework, Commits, Avoid, then Project conventions. Metric rules first in each section.
Every metric rule and every approved or edited rule is served, then the top three example-backed rules per section by confidence, `VOICE_RULES_PER_SECTION`. The Comments section gets a lead-in tying the voice rules to the quantities above.
A language under 5% of the developer's lines is left out of the full render and only served when asked for by language or file.
When more than one language is served, language-specific rules get a language label, and identical texts print once.

Check (`core/src/check.ts`): `checkStyle` compares every served metric rule against a snippet, deterministic. Comment, force-unwrap and `any` rules get line numbers from a second walk, the rest are one aggregate violation.
Floors: avoid rules fire on one occurrence, located ratio rules need 3 items, aggregates need 10 items or 100 lines, value rules need 2x the developer's number. Calibrated so about 5% of Shakib's own files are flagged. They live in the repo config under `check` and both Unbot and the MCP `check_style` read them.

Unbot (`core/src/unbot.ts`, `cli/src/unbot.ts`): fast mode is `checkStyle`, `--llm` adds `deepCheck` where the LLM checks the example-backed voice rules with line numbers, `--fix` rewrites with `rewriteLikeMe`, which the MCP tool shares.
Default files are what changed since HEAD, `--staged` for hooks, `--all` for everything. `--strict` exits 1.
`hooks install` writes a warn-only pre-commit hook and a post-commit refresh hook, honours `.husky`, points at lefthook.yml instead of editing it.

Served profile (`core/src/profile.ts`, added 2026-10-03): `loadServedProfile(repo)` returns the profile named by `profile` in the repo config, otherwise the developer's own. `sync`, `show`, `rules`, `unbot`, `eval`, `ui` and the MCP server use it, `scan`, `status` and `refresh` do not.
Borrowed profiles (2026-10-03): when the named profile is not the developer's own, `loadServedProfile` sets `profile.borrowed` to the kinds in `borrow` from the repo config, default voice and layout. `isServed(rule, threshold, profile.borrowed)` then drops idiom rules and project rules, `ruleKind` in `core/src/profile.ts` decides the kind. The render gets a borrowed header with the snapshot date and always labels language rules. `saveProfile` strips the marker.
Shipped styles (2026-10-03): `core/src/styles.ts` has `buildStyle`, `listStyles`, `composeStyles`, `core/src/served.ts` has `loadServedProfile` and the repo overrides, `cli/src/styles.ts` has `idiolect styles`, `styles build` and `use`. Four styles ship in `packages/core/styles/`: kotlin-tivi, typescript-vue, and the experimental python-httpx and go-caddy.
The review behind them was done by the agent, not by Shakib: every personal LLM rule approved except three rejected (TypeScript non-null assertions on invariants, Python `# pragma: no cover`, Caddy's candid commit bodies) and three edited (Tivi "Tidy up" without WIP and [ci skip], the Tivi bug URL rule without its em dash, Caddy comments without the "yikes" asides). Shakib read the Kotlin and TypeScript rules on 2026-10-03 and confirmed them without changes. Python and Go stay experimental. The decisions live in the profiles under `~/idiolect-oss/homes/`, rebuild with `idiolect styles build` from there.
Commands that only read rules no longer need `~/.idiolect/config.json`, so `use`, `sync`, `show`, `rules`, `unbot` and `mcp` work for someone who never ran `init`.
Four single-author profiles learned from pre-2024 open source code sit in `~/.idiolect/profiles/`: the lead author of Tivi (Kotlin), of Vue core (TypeScript), of HTTPX (Python) and of Caddy (Go). The repos, isolated homes, scan and eval scripts and two eval reports are in `~/idiolect-oss/`. 
Render labels a text shared by some served languages with exactly those, "Kotlin, TypeScript: ...", and leaves the label off only when every served language shares it.
`init` keeps the other keys of an existing repo config, it used to rewrite the file with languages and ignore only.

Rules (`cli/src/rules.ts`): `list|show|approve|reject|edit` over `updateRules`. Decisions survive rescans.

Refresh (`cli/src/refresh.ts`): `status` and `refresh`. Commits since the last scan come from `git rev-list --count <source.head>..HEAD`. At `refresh.everyCommits` it spawns `scan` detached and logs to `.idiolect/cache/refresh.log`.

MCP (`packages/mcp/src/index.ts`): `createIdiolectServer(deps)` takes a profile loader and a provider factory. `idiolect mcp` wires it to stdio and re-reads `~/.idiolect` on every call.
Repo comes from `git rev-parse --show-toplevel` on the file's directory, falling back to the cwd the client started in.

Sync (`cli/src/sync.ts`): writes between `<!-- idiolect:start -->` and `<!-- idiolect:end -->` only. Updates the four known files when they exist, creates only AGENTS.md unless targets are explicit.

LLM providers (`core/src/llm.ts`): `claude-cli` runs the installed Claude Code headless with `--json-schema`, no API key. Also `anthropic`, `openai`, `openai-compatible`, `gemini`. OpenAI and Gemini need `llm.model`.

Eval (`packages/eval/src/index.ts`): each task generated with and without STYLE.md, a judge picks blind against reference samples, metric distance compares outputs to the developer's stats per language. 15 Kotlin and 5 TypeScript tasks. The task language picks the persona, the analyzer and the reference samples.
The eval system prompt says "Write the way this developer writes. Their style profile:" and nothing about following it strictly, because CLAUDE.md gives agents no such push either.
`--from <report> --quiz` replays a stored run for the human quiz, `--from latest` takes the newest report in the repo. The quiz opens in the browser from `cli/src/quiz.ts`: a localhost server, one HTML string, two clickable cards, shared lines dimmed only when the outputs mostly overlap, keys A, B and S, a result screen with chance marked. The page never learns which side is the profile until the last pick. `--tty` is the old terminal quiz.
Screenshots for checking the page were taken headless with Playwright's chromium shell under `~/Library/Caches/ms-playwright`, there is no Chrome on this machine. A `--virtual-time-budget` lets the fade-in finish first.

## Publishing

`pnpm -r publish --no-git-checks` after bumping the version in all four package.json files and in the `McpServer` version in `packages/mcp/src/index.ts`, then `git tag -a vX.Y.Z -m vX.Y.Z` and `git push --follow-tags`.
`--no-git-checks` is needed because pnpm refuses to publish with untracked files and the Android Studio files, `.idea/` and `Idiolect.iml`, are untracked.
Shakib runs `npm login` and the publish himself, this machine is not logged in to npm between releases.
Before publishing, pack the four packages, install the tarballs into a clean folder with an empty `HOME` and run the CLI from there. That is how 0.1.0 was checked.
Every package has `files`, `license`, `repository`, `publishConfig.access: public`, and excludes compiled tests. Grammars and tells ship inside core, tasks inside eval, and the styles inside core, so nothing resolves outside its package. The CLI copies the root README in `prepack`.
The npm org name `idiolect` is taken by someone else, which is why the internal packages sit under Shakib's user scope.

## Config and storage

`~/.idiolect/config.json`: name, all emails, LLM provider. Never inside a repo. `init` accumulates emails, it never removes one.
`<repo>/.idiolect/config.json`: languages, ignore, sync targets, thresholds, plus `styles`, `profile` and `borrow` for what is served, all optional, safe to commit. `<repo>/.idiolect/overrides.json`: rule decisions made on shipped styles in that repo.
`~/.idiolect/profiles/<first email>.json` and `.STYLE.md` next to it: one profile per developer, merged over every repo.
Shakib's profile is under `shakib.khatri@ires.de`. A stray second profile from a mis-click during `init` is safe to delete. The same folder holds the four scanned author profiles and a merged `oss-baseline@idiolect.local` from the first attempt, which nothing serves.

## Real data so far

Dissent, personal, 794 Kotlin files, 56 TypeScript, 6 Python, 523 commits. device-manager-app, work, four authors, 449 Kotlin files owned, 391 commits.
Shakib's live profile has 79 rules from his own rescan of Dissent on 2026-10-02 with the LLM. He has not rescanned since the per-file spread, the `it()` test names, the Python analyzer, the fewer-rules writer prompt, the commit wrap rule and the agent-trailer exclusion landed, so one `idiolect scan` in Dissent picks all of that up.
Shakib reviewed the earlier 55 rules and called them mostly correct.
Eval on Dissent, 15 tasks: judge 15/15, quiz 5/15 on the first profile; 11/15 and 7/15 with the capped render; 13/15 and no quiz after the rescan. Eval on the work repo, 7 tasks: judge 7/7, no quiz.

Other developers' repos, scanned with an isolated `HOME` so nothing of Shakib's was touched: gjson (Go), sly (Python), ky (TypeScript), picnic (Kotlin). Each analyzer matched an independent counter within a few percent and exactly on the idiom counters. `scripts/verify/README.md` has the numbers and the recipe.

## Decisions and why

tree-sitter grammars are vendored wasm files. `tree-sitter-wasms` is stale and the official grammar packages run node-gyp. Swift publishes no wasm and must be built once.
Node floor is 22: 20 is end of life and 22 has `path.matchesGlob`.
No API key by default. Most developers have a plan, not a key. The default provider is the agent they already have, run headless.
Identity lives outside the repo after a personal email showed up untracked in the work repo.
Project versus personal rule scope exists because team conventions leaked into the personal profile.
The quiz, not the judge, is the headline eval metric, because the judge shares a model with the generator. The first real quiz proved the point: 15/15 judge, 5/15 human.
Unbot has no `lint` package. The pieces live in core because the MCP server shares them.
Quantity rules in the check have floors because a per-file median over three functions is noise. Located ratio rules have a lower floor because each located line is concrete.
The doc-ratio rule has no line finder on purpose: a developer who documents some files fully and others not at all would see every doc comment flagged.
Avoid rule ids carry the language because the same tell for two languages produced one id twice.

Dissent serves the shipped styles `kotlin-tivi` and `typescript-vue` since 2026-10-03, with commit rules from Tivi. Its config still carries an ignored `profile` key. Its Kotlin is indented with 4 spaces and the styles carry layout rules, so `"borrow": ["voice"]` is worth adding there.

## Working agreements with Shakib

The spec is a draft. Question it, change it, say what changed.
Keep moving: out-of-scope bugs go to `bugs/NNN-title.md`, ideas to `SUGGESTIONS.md`, only bugs inside the module being built get fixed on the spot.
Never add an agent name as commit co-author. Never use em dashes, plain hyphen instead. Short comments, two lines at most.
Commit at module boundaries and after real fixes, short imperative subject, prose body.
He tests as an end user and pastes terminal output or screenshots. Treat what he pastes as ground truth over unit tests. When numbers look surprising, check them against the real repo.
He wants modules built, verified in `~/AndroidStudioProjects/Dissent`, committed, and the next one started without waiting for him. Restore anything you change there, and back up `~/.idiolect/profiles/` before a test scan and restore it after.
Never run anything that changes his repos or his Claude Code config without asking. Scanning is read-only apart from `.idiolect/` inside the repo.
He uses a global `~/.claude/CLAUDE.md` with his general rules, read it.
He decides step by step: he asks what you understood and what you will build, then says go. Explain first, recommend one option, and build after the go.
He wants a branch per piece of work. A fast-forward merge into `main` once the work is verified is fine as long as it is reported. Pushing and publishing are his to run.
The agent cannot start headless `claude` in his setup, the permission classifier blocks it, and cannot edit its own permission settings. Anything that calls the LLM, a scan with voice rules or an eval, is written as a script for him to run with `!`, and he pastes the output.

## Open items, in order

1. The CLI redesign in `CLI.md`. Shakib finds the CLI basic and cluttered. He asked for the brief on 2026-10-03 and has not yet said go, and every decision in it is made: bare `idiolect` prompts in every state and only reports without a terminal. What is missing is his go to start building. He already decided that shipped styles are called "house styles" in everything a user reads, and that `idiolect remove` lets a user take out everything idiolect did in a project, at a level they choose. Steps 1 to 7 ship as 0.2.0, he decided that on 2026-10-03. The picker preview comes later.
1. Shakib's own profile is the stale 79-rule one from before the leak fix, and Dissent no longer serves it. One `idiolect scan` in Dissent rebuilds it clean. To serve it again he removes `styles` from Dissent's config.
2. Retake the quiz with the clean baseline, suggestion 29. It is the only way to know whether the chance-level verdict was real.
3. More styles, suggestion 31. Shakib wants to learn from more open source projects. One project and one main author per style, recipe in `scripts/styles/README.md`.
4. Reviewers for `python-httpx` and `go-caddy`, suggestion 30.
5. The unwanted-function check for Unbot, suggestion 26. He named it as part of what the second audience wants.
6. Windows: the LLM calls are untested there, suggestion 27.
7. Smaller: the TODO avoid rule, suggestion 24, and the Python name count, suggestion 25.
8. Swift (suggestion 3). `tree-sitter-swift` 0.7.1 ships no wasm and `tree-sitter build --wasm` needs emscripten or docker, neither is installed. Installing emscripten with Homebrew changes his machine, ask first.
9. Launch post. The README now leads with both audiences and has the before and after.
10. Suggestion 15's judge half, suggestion 22, the "do less" rule family from suggestion 13, then the older open suggestions, or M9 after real usage.
11. There are no local branches besides `main`. The sixteen from 2026-10-03 were merged and deleted.

## Things that bit us, so you do not repeat them

`idiolect scan --no-llm` once wiped LLM rules. Fixed, keep the test on `writeRules`.
Backtick and camelCase sentence test names pollute verb stats unless routed to `testNames`.
`claude -p --bare` cannot see the user's login, do not add `--bare`.
Headless `claude -p` loads the user's CLAUDE.md, SessionStart hooks and the agent system prompt unless told not to. A probe on 2026-10-03 found 20 such instructions in every scan and eval call, so the "without profile" side of every eval before that date was not a plain baseline and the rules of every scan were phrased with them in view. The provider now passes `--safe-mode` and `--system-prompt`, the same probe sees none. `~/idiolect-oss/leak-probe.sh` repeats the check.
Claude Code's `--json-schema` rejects the `$schema` key zod emits, `jsonSchema()` strips it.
zod is v4 because the Anthropic helper needs it, use `.prefault({})` not `.default({})` for nested objects.
The vendored Kotlin grammar errors on semicolon-separated class members, `bugs/001`.
The blame cache ignored the email list until picnic's third author email changed nothing. Any new cache key input belongs in `readCache`.
`bump()` on a plain object read `Object.prototype.constructor` for a method named `constructor`. It uses `hasOwn` now.
A per-file ratio over a handful of items is noise. Every time Unbot flagged half of Shakib's own files, the fix was a floor, not a threshold.
zsh does not word-split `$files`. Pipe `git ls-files` into `xargs` or loop with `while read` in verification scripts.
`init` accumulates emails in `~/.idiolect/config.json`, so a test with fewer emails needs a fresh `HOME`.
A long timestamped `--from` path sent Shakib to the wrong report, he graded the old profile again and it looked like a result. `--from latest` and the run subtitle on the quiz page exist because of that.
zsh treats a bare `=word` argument as a command lookup, so `echo ====` fails. Quote it.
In a Python heredoc, a TypeScript template literal that contains `\\"` needs a raw string or doubled backslashes, otherwise the replacement silently never matches.
The same code scanned three times gave three sets of LLM rules, one contradicting another on whether lookups take a `get` prefix. A scan proposes, a person decides, and a shipped style is frozen after review.
Merging four authors into one profile made the rules contradict each other and mixed four commit styles. One main author per profile.
A search for comments piped through `grep -v test` hid a line that contained the word "test" for another reason. Count matches before and after a filter.
`which` does not exist on Windows. The check for an installed `claude` uses `where` there.
`pnpm -r publish` refuses to run with untracked files in the tree, and `pnpm pack --dry-run` in `packages/cli` runs `prepack` and copies the README in.
An eval judge with no reference samples still returns a confident verdict. An empty repo gives zero references, read the count in the first line of the eval output.
The eval inside the source repo of a borrowed profile serves that repo's project rules, which put a Tivi copyright header into 10 of 12 outputs. Measure a borrowed style in a neutral repo.

