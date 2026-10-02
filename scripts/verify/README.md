# Verifying an analyzer against a second opinion

Nobody on this project writes every supported language, so each analyzer is checked against an independent counter on a real repo instead of by eye.

`count.mjs <language> <files...>` runs the idiolect analyzer over whole files, no blame ranges, and prints the totals as JSON.
`ast_count.py <files...>` counts the same things for Python with the standard library `ast` module.
`go_count.sh <files...>` is a regex second opinion for Go, used because this machine has no Go toolchain. Top-level declarations only, so expect small differences on nested funcs and trailing comments.

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

Done on 2026-10-02 with tidwall/gjson for Go and dabeaz/sly for Python.
Python matched `ast` exactly on every count except f-strings, 103 against 106, because `ast` also counts the nested format spec of an f-string.
Go matched the regex count on functions, types, error checks and panics.
