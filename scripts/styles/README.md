# Adding a shipped style

A style is learned from one open source project and, as far as possible, one author.
More projects mean more styles, not bigger ones: four authors merged into one profile gave rules that contradicted each other.

Everything below runs under an isolated home, so the maintainer's own profile and `~/.idiolect` are never touched.

## 1. Clone the project at a commit from before 2024

```
git clone --single-branch https://github.com/<owner>/<project>.git
cd <project>
git checkout --detach $(git rev-list -1 --before=2024-01-01 HEAD)
```

The cutoff keeps agent-written code out.
A full clone is needed, blame does not work on a shallow one.

## 2. Find every email of the main author

```
git shortlog -sne --no-merges HEAD | head -20
```

Read the whole list.
The same person often commits under three or four addresses, and a missed one silently drops their lines.

## 3. Scan it

```
export H=/path/to/isolated-home
mkdir -p $H/.idiolect
echo '{ "name": "<Project> lead", "emails": ["<email>", "<email>"], "llm": { "provider": "claude-cli" } }' > $H/.idiolect/config.json
mkdir -p .idiolect && echo '{ "languages": ["<language>"] }' > .idiolect/config.json
HOME=$H idiolect scan
```

With `HOME` changed, the headless Claude Code cannot find its login.
Put a small `claude` script first on the `PATH` that resets `HOME` to the real one and then runs the real `claude`.

## 4. Review every rule the LLM wrote

```
HOME=$H idiolect ui
```

Approve, edit or reject each example-backed rule.
The same code scanned twice gives different LLM rules, so nothing ships unreviewed.
Reject a habit that is real but not worth handing to someone else, such as marking commits "WIP".
Edit out project vocabulary and personal asides.
Project rules and idiom rules need no decision: project rules never ship, idiom rules ship but are not served by default.

## 5. Build the style

```
HOME=$H idiolect styles build \
  --email <first email> --id <language>-<word> --title "<Project>" \
  --summary "<at most 60 characters on what the style feels like>" \
  --language <language> --project github.com/<owner>/<project> --license <SPDX id>
```

Add `--experimental` when nobody who writes the language has reviewed it.
The file lands in `packages/core/styles/`.
It holds the metric rules as measured and the reviewed voice rules, no emails, no code snippets and no project rules, and a test checks that for every style in the folder.

## 6. Check it

```
pnpm build && pnpm test
idiolect styles --all
idiolect styles show <id>
```

Then run `idiolect use <id>` in a throwaway folder and read the block it writes.

## Naming

The id is the language and one word for how the style reads, like `kotlin-quiet`.
It is never the project or the author, a house style is idiolect's own.
`--title`, `--project` and `--license` record where it was learned, in the style file only.
A second style for a language needs a word that sets it apart from the first.
When a style is renamed, put the old id into `aliases` in its file so repo configs keep working.

## What exists today

| Style | Project | Reviewed by |
|---|---|---|
| kotlin-quiet, was kotlin-tivi | Tivi | Shakib |
| typescript-terse, was typescript-vue | Vue core | Shakib |
| python-spare, was python-httpx | HTTPX | nobody who writes Python, experimental |
| go-annotated, was go-caddy | Caddy | nobody who writes Go, experimental |

Each was learned from the lines of the project's lead author only.
Their names and emails stay out of the repo, the docs and the style files.
`idiolect styles show <id>` gives the address of the source project, which is the one place a GitHub handle appears.

On Shakib's machine the clones, the isolated homes with the review decisions and the scripts are in `~/idiolect-oss/`.
