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
