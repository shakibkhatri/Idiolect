# Verifying an analyzer against a second opinion

Nobody on this project writes every supported language, so each analyzer is checked against an independent counter on a real repo instead of by eye.

`count.mjs <language> <files...>` runs the idiolect analyzer over whole files, no blame ranges, and prints the totals as JSON.
`ast_count.py <files...>` counts the same things for Python with the standard library `ast` module.
`ts_count.mjs <files...>` does it for TypeScript with the TypeScript compiler API already in the dev dependencies.
It misses comments that sit right before a closing brace, because it walks nodes and not tokens, so expect it a few percent under on comments.
It counts overload signatures as function declarations, idiolect does not.
`go_count.sh <files...>` is a regex second opinion for Go, used because this machine has no Go toolchain. Top-level declarations only, so expect small differences on nested funcs and trailing comments.
`kotlin_count.sh <files...>` is the same kind of regex count for Kotlin. It does not count `companion object` as a class.

Run both over the same file list and diff the numbers:

```
cd /path/to/repo
git ls-files '*.py' | xargs node /path/to/Idiolect/scripts/verify/count.mjs python
git ls-files '*.py' | xargs python3 /path/to/Idiolect/scripts/verify/ast_count.py
```

To check the rules a language produces without touching your own profile, scan with an isolated home:

```
HOME=/tmp/idiolect-home idiolect init --email <author email> --provider none -y
HOME=/tmp/idiolect-home idiolect scan --no-llm
HOME=/tmp/idiolect-home idiolect show --lang go
```

## Results so far, 2026-10-02

Python, sly, 15 files: matched `ast` exactly on every count except f-strings, 103 against 106, because `ast` also counts the nested format spec of an f-string.
Go, gjson, 2 files: matched the regex count on functions, types, error checks and panics.
TypeScript, ky, 87 files: exact on classes, doc comments, try, non-null assertions, any, arrow functions, type aliases, interfaces and the parameter histogram. Functions 578 against 580, the two are overload signatures. Comments 734 against 702, the compiler counter's closing-brace gap.
Kotlin, picnic, 14 files: functions 149 against 149, comment nodes match grep per file exactly, classes 39 against 38 where the regex skips a companion object.

Lesson from picnic: the author has three emails and `shortlog | head -3` hid one, so the first scan owned no test functions. Always read the whole author list before `init --email`. The real `init` prompt shows every author for exactly this reason.
Adding the third email and rescanning changed nothing, which exposed a real bug: the blame cache ignored the email list. It is keyed on the emails now and a changed list throws it away. With all three emails picnic owns 2208 lines and 41 test functions.

Reading the rules each author got is the other half of the check. gjson: no named returns, two parameters, short comments. sly: no type hints, f-strings, few docstrings, three-line functions. ky: const arrow functions, type aliases, camelCase constants, short imperative subjects without bodies. picnic: comments end with a period, no doc comments, imperative subjects. All four read like their authors.
