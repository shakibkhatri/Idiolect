# Suggestions

Ideas and improvements noticed while building, so work does not stop to discuss them.
One entry per idea, newest at the bottom.
Status: open, done, or dropped.

## 1. Detect team conventions leaking into the personal profile (open)

Commit style and test naming differ sharply between Dissent and the work repo (2% vs 75% conventional prefixes, backtick vs camelCase sentence test names).
Per-source stats already exist in the profile.
The profile writer should compare a metric across sources and, when they disagree strongly, lower confidence and mark the rule as varying by repo instead of blending.
Long term this is the seed of team mode: a convention that holds in one repo but not another is probably the team's, not yours.

## 2. Compose modifier metric should be "first optional parameter" (open)

The Compose convention is modifier as the first parameter with a default, after required ones.
The analyzer currently records absolute position, which makes "later" the common case and hides the real signal.

## 3. Swift grammar must be built and vendored (open)

tree-sitter-swift publishes no wasm on npm.
When Swift arrives, build once with the tree-sitter CLI, commit the wasm next to kotlin.wasm, and add a row to scripts/update-grammars.sh.

## 4. Verify early-return and nesting definitions against real intent (open)

Early return is "a return inside a conditional that is not the last statement".
Nesting counts if, when, loops, try and lambdas.
Both produce plausible numbers but nobody has confirmed they match what the developer means.
Check during M3 when rules get phrased.

## 5. Fill in default models for OpenAI and Gemini (open)

`core/llm.ts` has a defaults table.
Anthropic defaults to claude-opus-5-5.
OpenAI and Gemini have no default and require `llm.model` in config, because their current model ids were not verified when the adapters were written.
Verify against the provider docs and fill them in.

## 6. Baseline confidence for "value" rules is a flat formula (open)

Percentile rules like "functions are about 10 lines" get `0.3 + 0.5 * min(1, n/100)`.
That is fine for serving, but a proper spread measure (how tight the distribution is) would make the number mean something.

## 7. Approve, reject and edit rules from the CLI (done 2026-10-02)

Reconcile already honours approved, edited and rejected statuses across rescans, but nothing sets them yet.
`idiolect rules list|approve|reject|edit <id>` is a small addition and unblocks the pending-rule flow before the dashboard exists.
Built as `packages/cli/src/rules.ts` over `updateRules` in core, plus `rules show <id>` for the evidence.

## 8. Gemini CLI and Codex CLI providers (open)

Same pattern as `claude-cli`: run the installed binary headless, pass the prompt on stdin, parse JSON.
Neither is installed here so their flags were not verified.
Check `gemini -p` and `codex exec` output formats and whether they support a JSON schema.

## 9. MCP prompt that lets the agent write the rules (open)

Once M5 exists, add a `learn_my_style` prompt plus `get_profile_input` and `submit_rules` tools.
The agent fetches metrics, baseline rules and samples, writes the rules itself, and submits them.
That removes the CLI dependency entirely for anyone using an MCP client.

## 10. Dedupe personal rules learned from different repos (open)

Personal LLM rules accumulate across repos by design, but two repos can produce near-identical rules with different ids.
A cheap pass: when a new personal rule's text is very similar to an existing one, merge the examples instead of adding a rule.
Could be done by the same LLM call if it is shown the existing personal rules.

## 11. Eval judge shares a model with the generator (open)

`idiolect eval` generates and judges with the same provider, so the judge may prefer its own styled output for reasons other than resemblance.
The blind quiz is the unbiased check and should be the headline number once a few people have run it.
Options: judge with a different provider when two are configured, or add a control arm where the judge compares "without" against a second "without" and should land near 50%.

## 12. Metric distance on eval output is small-sample (open)

Seven tasks give a handful of functions and one commit message, so per-metric numbers like commits.body-ratio swing between 0 and 1.
Weight each metric by its output sample size, or require a minimum before it counts, and say in the report how many samples each number rests on.

## 13. Profile over-application: cap voice rules per section (open)

Metric table from the first eval: with the profile the agent wrote more comments per line than the developer does, without it fewer.
Weak evidence from seven tasks, and the first quiz was answered at random so it says nothing.
Reordering quantities first is the cheap precaution.
If the quiz still sits near chance, cap example-backed rules to the top N per section by confidence, and ask the LLM for fewer, sharper rules.
Also consider a "do less" rule family learned from what the developer does NOT do in the samples: no KDoc on private members, no preview composables, no sealed error hierarchies.

## 14. check_style cannot point at lines for naming and structure rules (open)

The analyzer only counts, so `check_style` reports a line for comment rules and `!!` by re-walking the tree in `core/check.ts`, and one aggregate violation for everything else.
Naming and structure violations (a camelCase constant, a 40-line function) would be more useful with a line.
Option: let the analyzer optionally collect `{metric, line}` occurrences, then both the checker and Unbot get lines for free.

## 15. Unbot calibration knobs and judge check (open)

`core/check.ts` hard-codes the sample floors (10 items, 100 lines) and the 2x excess for value rules, tuned so about 5% of the author's own Dissent files are flagged.
Another developer with a flatter or spikier distribution may want them in `.idiolect/config.json`.
The M7 done criterion also asked for the eval judge to prefer the `--fix` output over the original.
It passed the check and read right by eye, but nobody ran the judge on a before and after pair. A `--judge` flag on unbot, or an eval task kind "fix", would close that.

## 16. Deep mode drops the message in CLI output (open)

`deepCheck` returns what is wrong (message) and how the line should read (suggestion).
The CLI prints only the suggestion for violations with a line, because for metric rules the message is boilerplate.
A `--verbose` flag, or printing the message when it is not the metric sentence, would give the why back.

## 17. TypeScript test names live in it() strings (open)

The analyzer counts `function` declarations in test files as test functions and routes their names to `naming.testNames`.
Vitest and Jest tests are `it("does x", () => ...)` callbacks, so a TypeScript test suite shows up as a handful of helper functions.
Read the first string argument of `it`, `test` and `describe` calls as the test name, and classify its style (sentence, should-style, given/when/then).

## 18. Ratio rules from bimodal habits flag whole files (open)

The author's TypeScript has JSDoc on 16% of comments overall, but some files are fully documented and others have none.
The merged ratio produces a "doc comments are rare" rule that then fires on every fully documented file.
Unbot no longer lists each doc comment for that rule, but the rule itself is still weak evidence.
Per-file counts during the scan would allow a spread check: a habit that varies this much between files is not a rule, or gets its confidence halved like a habit that varies between repos.

## 19. TypeScript eval tasks (open)

`idiolect eval` generates and judges Kotlin only, the task schema fixes the language.
Add a few TypeScript tasks and let the task language pick the analyzer for the metric distance.

## 20. Python and Go test names (open)

Python test functions are `def test_x` in test files, so `naming.testNames` gets their snake style, which is all pytest allows.
Go test functions are `func TestX`, classified by the camel-sentence heuristic.
Neither says much about the developer. Worth skipping both languages in the test-name rules, or classifying by the words after the prefix.
