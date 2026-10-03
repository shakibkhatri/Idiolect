# CLI redesign

A brief for the agent who implements it.
Written 2026-10-03 against `idiolect@0.1.2`.
Nothing in here is built yet.
Read `HANDOFF.md` first, it holds the working agreements and the things that bit us.

## Why

The CLI grew one command at a time while the tool was being built, and it shows.
It has every feature it needs.
What it lacks is an order: everything is presented at the same level, in the voice of a tool built for its own author.
Shakib's words: "it feels pretty basic and cluttered".

There are two audiences since shipped styles landed, and the CLI treats them as one.
A person whose agent writes all the code needs one command, once.
A developer who learns their own style needs four commands and comes back to review rules.
Neither is told which commands are theirs.

## What is wrong today

Each point was observed in the running tool, not guessed.

1. **No front door.**
   `idiolect` with no arguments prints the commander help: fourteen commands in a flat list, `init`, `scan`, `show`, `sync`, `styles`, `use`, `rules`, `unbot`, `hooks`, `status`, `refresh`, `ui`, `eval`, `mcp`.
   Nothing says where to start.
2. **Three words for one thing.**
   "Profile", "style" and "rules" are used for the same object.
   There are three different show commands: `show`, `rules show` and `styles show`.
   The top-level description still reads "Learn your coding style and feed it to AI agents", which leaves out the second audience.
3. **Output written for debugging.**
   `scan` prints a block of statistics per language: verbs, boolean prefixes, errors per thousand lines.
   `use` prints its internal mapping, `commits    typescript-vue`.
   `rules list` prints one truncated line per rule led by a long id.
4. **Nothing says what happens next.**
   After `use` succeeds the user is not told that their agent now behaves differently, how to check it, or how to undo it.
   There is no way to remove a style except editing `.idiolect/config.json` by hand.
5. **Long waits are silent.**
   An LLM scan prints `asking claude-cli default (9906 tokens)...` and then nothing for minutes.
6. **`status` ignores what the repo serves.**
   In Dissent, which serves two shipped styles, `idiolect status` reports the developer's own profile and its 82 rules.
   It never mentions the styles the agent is actually reading.
7. **It looks unfinished.**
   No colour, alignment done per command by hand, and `unbot` means nothing until explained.

## Principles

- **Few dependencies, no build step.**
  The CLI depends on `commander` and nothing else for its interface.
  Colour and a spinner need a few lines of ANSI, not a library.
  No terminal UI framework.
- **A pipe gets plain text.**
  Colour, spinners and prompts only when stdout is a TTY.
  Honour `NO_COLOR`.
  CI, hooks and scripts must see stable, greppable lines.
- **Nothing published breaks.**
  Every command and flag in 0.1.2 keeps working.
  A rename ships with the old name as an alias.
- **The first minute is the product for the second audience.**
  They run one command once and never open the CLI again.
  Depth belongs to the developer, and for reviewing rules the dashboard is already the better surface.
- **Windows is a first-class terminal.**
  Shakib tests each release in PowerShell inside VS Code on a Windows laptop.
  No output may rely on a width over 100 columns, a test already holds the style list to that.

## The design

### 1. Bare `idiolect` is a guided start

`idiolect` with no arguments stops printing help and reports where this project stands, then offers the next step.
`idiolect --help` and `idiolect help` keep printing the help.

It has four states, decided from the repo config, `~/.idiolect` and the agent files.

**No style served, no personal profile.**
Say what the tool does in two lines, then offer the two paths: pick a house style, or learn your own from this repo's history.
In a TTY this is a two-item numbered prompt that runs `use` or `init` then `scan`.
In a pipe it prints the two commands and exits 0.

**A shipped style is served.**
One line per language with the style id and its summary, the files it was written into, and whether they are current with what would be rendered now.
Then the three things a user can do: change the style, review its rules, check the project with Unbot.

**The developer's own profile is served.**
Profile age, rule counts, pending rules, commits since the last scan of this repo, whether the agent files are current.
This is today's `status`, with the served style first.

**A personal profile exists but this repo was never scanned.**
Say so and offer `scan`.

Whether the agent files are current is a comparison of the block between the idiolect markers with a fresh render.
`syncTargets` already computes "unchanged", so a dry-run mode of it answers this without writing.

`status` becomes an alias of the bare command's report, without the prompt.
That fixes point 6.

### 2. Help grouped by audience

`idiolect --help` shows three groups, each command on one line of at most 80 columns.

```
Get a style
  use        pick a house style for this project
  init       set up learning your own style from your git history
  scan       learn or update your own style
  sync       write the style into your agent's instruction files

Review and check
  show       print the style your agent reads
  rules      approve, reject or edit rules
  ui         do the same in the browser
  unbot      flag code that breaks the style or sounds like AI
  styles     list the house styles

Advanced
  mcp, hooks, status, refresh, eval
```

The Advanced group names its commands without descriptions, `idiolect help <command>` gives the detail.
`styles build` is a maintainer command and is not listed anywhere except under `idiolect help styles`.
The top-level description becomes one line that covers both audiences, for example "Give your AI coding agent a style to write in: your own, or a house style".
commander supports this with `configureHelp` or `addHelpText`, no new dependency.

### 3. One vocabulary

The user-facing word is **style**, whether shipped or learned.
"Profile" stays an internal word for the stored JSON and stays in file names, code and the spec.
"Rules" are what a style is made of.

| Today, in user-facing text | After |
|---|---|
| your profile, your style profile | your style |
| shipped styles | house styles |
| the profile as served | the style your agent reads |
| project rules | rules for this repo only |
| borrowed | not shown to users, the header in the agent files keeps it |

**House styles** is the name for the styles that ship with idiolect, decided by Shakib on 2026-10-03.
In publishing a house style is the way one publisher writes, here it is the way one project writes its code, which fits naming a style after the project and not the person.
Say "the house style of Vue core" and "pick a house style", the command stays `idiolect styles` and the ids stay as they are.
"Shipped style" remains the internal word in code, the spec and this brief.
"Voices" was the runner-up and was dropped because voice is already one of the three rule kinds.

Every `description`, every error message and every line of output in `packages/cli/src` gets this pass.
`NO_PROFILE` in `rules.ts` is the one message most new users see, it should read as a next step and not as an error.
The rule text and the rendered block in the agent files are not part of this, they are written for the agent.

### 4. Quiet by default

Every command ends with one result line and one next-step line, and prints nothing a user cannot act on.

**`scan`**
Today it prints the per-language statistics for this repo, again for the merged profile, a rule count by status, the profile path and a next step.
After: one line per language with files, lines and rule count, one line of totals, one next step.
The statistics move behind `--verbose`.
The numbers below are illustrative.

```
Kotlin      794 files, 95536 lines, 41 rules
TypeScript   56 files,  8210 lines, 23 rules

Learned 79 rules, 12 of them from examples of your code.
Next: idiolect show to read them, idiolect sync to give them to your agent.
```

**`use`**
Drop the language to style mapping lines when one style per language was picked from the menu, the user just chose them.
End with what changed for them and how to undo.

```
Written to AGENTS.md and CLAUDE.md.
Your agent follows the style from its next session.
Check existing code: idiolect unbot --all.  Undo: idiolect use --none.
```

The single line naming the agent files that were not written stays.

**`rules list`**
Group by section the way the rendered style does, lead with the rule text, and put the id last and dimmed.
A marker shows served, held back, pending or rejected.
The id column is what makes it cluttered today and is only needed to type a command.

**`sync`**
Print only the files written, as `use` does since 0.1.2, then one line.
The "skipped" rows it still prints are the same noise that was removed from `use`.

**Errors**
One line saying what is wrong, one line saying what to run.
No stack traces.
Today's `error: ...` prefix stays so scripts can match it.

### 5. Progress for long steps

`scan` with an LLM, `eval`, `unbot --llm` and `unbot --fix` wait on the model for up to minutes.
In a TTY, show a spinner with the elapsed seconds on the line that announces the call.
In a pipe, print the announcing line once and a "done in 84s" line after, which is what scripts and the background refresh log need.
The blame pass of a first scan on a large repo also takes seconds, a file counter there is enough.

One small module, `cli/src/term.ts`, holds colour, the spinner and the TTY check, so no command writes ANSI codes itself.
`cli/src/theme.ts` already holds the colours the quiz page and the dashboard share, reuse its palette for the terminal.

### 6. A better picker

- **Preview.**
  In the menu, typing `?` and a number prints that style's rules, what `styles show` prints, and returns to the prompt.
- **Remove.**
  `idiolect use --none` removes `styles` from the repo config and the idiolect block from every agent file it finds.
  A file that held nothing but the block and was created by idiolect is deleted, a file with other content keeps it.
  Removing the block is new code in `sync.ts`, it must leave everything outside the markers byte for byte like `syncBlock` does.
- **Arrow keys are optional.**
  Number entry works everywhere and stays the baseline.
  Add arrow-key selection only if it needs no dependency and degrades to numbers in a pipe.

## Compatibility

- No command is removed.
- `status` stays as an alias of the bare report.
- Output that scripts are known to read keeps its shape: `idiolect --version`, `unbot` violation lines and exit codes, `sync` status words, the `error: ` prefix.
- The pre-commit and post-commit hooks call `idiolect unbot --staged` and `idiolect refresh`, both must stay silent when they have nothing to say.
- The changes are user-visible, so they ship as 0.2.0.

## Out of scope

- New features beyond `use --none`.
- A terminal UI framework, a full-screen interface, mouse support.
- Renaming `unbot`.
  It is the product's name for the linter and is in the README, a one-line description in the help is enough.
- The dashboard.
  It is a separate surface and already does rule review well.
- Localisation.

## Order of work

Each step is a branch, verified, merged and reported before the next starts.

1. **`term.ts`**: TTY check, colour with `NO_COLOR`, spinner.
   Done when a unit test shows plain output in a pipe and coloured output in a fake TTY.
2. **Vocabulary pass** over every user-facing string.
   Done when no user-facing line says "profile" or "shipped", the styles that ship are called house styles everywhere a user reads, and `grep` over `packages/cli/src` shows "profile" only in identifiers and paths.
   The README's section "No code of your own yet" and the list printed by `idiolect styles` get the same wording.
3. **Grouped help** and the new top-level description.
   Done when `idiolect --help` fits 80 columns and shows the three groups.
4. **Bare `idiolect`** with its four states, and `status` as its alias.
   Done when each state is shown in a throwaway repo: empty, shipped style, own profile, profile without a scan of this repo.
5. **Quiet output** for `scan`, `use`, `sync` and `rules list`, with `--verbose` on `scan`.
   Done when each ends with a result line and a next-step line, and `scan --verbose` prints what `scan` prints today.
6. **Progress** on the four LLM commands and the blame pass.
7. **Picker preview and `use --none`.**
   Done when `use --none` in a repo with a hand-written `CLAUDE.md` leaves that file exactly as it was before `use`.
8. **README and SPEC** updated to the new output, then release 0.2.0.

Steps 1 to 5 are the redesign.
Steps 6 and 7 are polish and can ship in a later release.

## How to verify

- Every step is checked in the real terminal, not only in unit tests.
  Shakib tests as an end user and pastes what he sees, treat that as ground truth.
- Check each command three ways: in a TTY, piped through `cat`, and with `NO_COLOR=1`.
- Run the new-user path in a folder with an empty `HOME`, the way 0.1.0 was checked before publishing.
- Ask Shakib to run the release candidate on the Windows laptop before publishing.
  `which` not existing there was only found that way.
- The agent cannot start headless `claude` on his machine.
  Anything that needs an LLM call, such as watching the spinner on a real scan, is a script he runs.

## Open decisions for Shakib

1. Whether bare `idiolect` should prompt at all, or only report and print the commands.
2. Whether `use --none` should delete an `AGENTS.md` that idiolect created and that holds nothing else.
3. Whether 0.2.0 waits for steps 6 and 7 or ships after step 5.

Decided: the user-facing name for shipped styles is "house styles", see the vocabulary section.
