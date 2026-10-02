# Kotlin grammar fails on semicolon-separated class members

`object K { const val A = 1; val b = 2 }` produces an ERROR node in the vendored Kotlin grammar (tree-sitter-grammars 1.1.0).
Rare in real code, zero occurrences in Dissent and the work repo.
Options: report upstream, or detect ERROR nodes per file and report a parse-error count in scan output so silent miscounts are visible.
