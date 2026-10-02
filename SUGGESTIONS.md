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

## 7. Approve, reject and edit rules from the CLI (open)

Reconcile already honours approved, edited and rejected statuses across rescans, but nothing sets them yet.
`idiolect rules list|approve|reject|edit <id>` is a small addition and unblocks the pending-rule flow before the dashboard exists.

## 8. Gemini CLI and Codex CLI providers (open)

Same pattern as `claude-cli`: run the installed binary headless, pass the prompt on stdin, parse JSON.
Neither is installed here so their flags were not verified.
Check `gemini -p` and `codex exec` output formats and whether they support a JSON schema.

## 9. MCP prompt that lets the agent write the rules (open)

Once M5 exists, add a `learn_my_style` prompt plus `get_profile_input` and `submit_rules` tools.
The agent fetches metrics, baseline rules and samples, writes the rules itself, and submits them.
That removes the CLI dependency entirely for anyone using an MCP client.
