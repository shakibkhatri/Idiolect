# Idiolect

Idiolect gives AI coding agents a style to write in, so their code stops sounding like AI.

If you write code yourself, it learns how you write code, comments and commits from your own git history, and what the agent writes reads like you wrote it.
If an agent writes most of your code, you pick a house style, the way one well-known open source project writes its code, and the agent writes clean code in that.

It runs on your machine.
It reads only the lines you authored, measures them, and turns the numbers and a few real examples into a style.
Claude Code, Cursor, Copilot, Gemini CLI, anything that reads `AGENTS.md` and any MCP client can read the style.
Unbot, the linter, flags code that breaks the style or sounds like AI, and can rewrite it.

Kotlin, TypeScript, Python and Go. Swift comes next.

## Before and after

A file of typical AI-written Kotlin:

```kotlin
/**
 * This class is responsible for managing user data in a robust and seamless manner.
 * It leverages the repository pattern to ensure that data handling is comprehensive.
 */
class UserDataManager(private val repository: UserRepository) {

    /**
     * Retrieves the user by their ID.
     * @param id The ID of the user.
     * @return The user object.
     */
    fun getUserById(id: String): User {
        // Fetch the user from the repository
        val user = repository.findById(id)
        // Return the user, force unwrapping since we know it exists
        return user!!
    }

    /**
     * Helper function to process the data.
     */
    private fun processData(data: List<User>): List<User> {
        // TODO: implement the filtering logic
        try {
            // Iterate over the data and filter it
            return data.filter { it.isActive }
        } catch (e: Exception) {
            // Log the error and return an empty list 🚀
            println("Error: ${e.message}")
            return emptyList()
        }
    }
}
```

`idiolect unbot --fix` on it, with a style learned from 130,000 lines of one developer's Kotlin:

```kotlin
class UserDataManager(private val repository: UserRepository) {

    /** The user stored under [id] - callers only ask for ids they know exist. */
    fun getUserById(id: String): User =
        repository.findById(id) ?: throw NullPointerException("No user with id $id.")

    private fun activeUsers(users: List<User>): List<User> = try {
        users.filter { it.isActive }
    } catch (e: Exception) {
        // A failing filter yields no users rather than taking the caller down with it.
        println("Active user filter failed: $e")
        emptyList()
    }
}
```

Nothing in the rewrite was invented.
Every rule it followed is backed by a number or a cited line from that developer's repos, for example:

- Comment sparingly. About 7.9 comments per 100 lines of code.
- Bail out of a function or lambda on missing values with an elvis return.
- Write short KDoc as one plain sentence that states the contract or the edge case, not the mechanics.
- Set off an aside in a comment with a spaced plain hyphen " - ", never an em dash.
- Do not start comments with "This function", "This method" or "This class".

## Install

Needs Node 22 and git.
Works on macOS, Linux and Windows.

```
npm install -g idiolect
```

Or run it without installing: `npx -y idiolect <command>`.

Then type `idiolect` in your project.
It says where the project stands and lists what you can do next by number.

```
> idiolect
This project has no style yet.
idiolect gives your AI coding agent a style to write in.
Pick a house style, or learn your own from this project's git history.

  1  Pick a house style                      idiolect use
  2  Learn my own style from my git history  idiolect init, then idiolect scan

Type a number, or Enter to leave:
```

Enter leaves without changing anything, and each step names the command it runs, so you know what to type next time.
In a script, in CI or with `--no-prompt` it only prints the report and the commands.
`idiolect --help` lists every command in three groups.

## No code of your own yet

If an AI writes most of your code, there is no history to learn from.
Pick a house style instead.
A house style is the way one project writes its code, and a few ship with idiolect.
Each one was learned from a well-known open source project, reviewed by a person and frozen.

```
cd your-project
npx -y idiolect use
```

`use` looks at what the project is written in, shows the house styles for those languages as a numbered list, and asks for a number.

```
This project is written in Kotlin and TypeScript.

Kotlin
   1  kotlin-quiet      Few comments, no KDoc, noun-phrase names, short plain commits

TypeScript
   2  typescript-terse  No semicolons, terse lowercase comments, short functions

Type the number of the style you want, one per language [1 2]:
```

A language with under 5% of the project's source files is left out.
Type `all` in the menu, or run `idiolect use --all`, to see every style.
`idiolect styles` prints the same list without asking, `idiolect styles show kotlin-quiet` lists the rules of one style, and `idiolect use kotlin-quiet typescript-terse` picks by name for scripts.
A style is named for its language and for how it reads, not for the project it was learned from.
The ids from before 0.2.1, `kotlin-tivi`, `typescript-vue`, `python-httpx` and `go-caddy`, still work everywhere.

`use` always creates `AGENTS.md`, the file most agents read.
It creates `CLAUDE.md` only when Claude Code is in use, meaning it is installed or the repo has a `.claude` folder, and a Cursor rule only when the repo has a `.cursor` folder.
It updates `.github/copilot-instructions.md` and `GEMINI.md` when they exist, and `--target <file>` writes any other file.
The files it did not write are named in one line at the end.

```
Written to AGENTS.md and CLAUDE.md.
Your agent follows the style from its next session.
Check existing code: idiolect unbot --all.  Undo: idiolect remove.
```

That is the whole setup: no scan, no LLM call, no account.
Your agent now writes fewer and shorter comments, plainer names and short commit messages, and `idiolect unbot` flags code that sounds like AI.

A house style shapes naming, comments, commit messages and layout.
It leaves the choice of language features to the agent, because the code it was learned from has a date and languages move.
The code already in your repo and your formatter always win over it.
`idiolect rules reject <id>` and `idiolect rules edit <id>` change a house style for your repo only, the decisions live in `.idiolect/overrides.json`.
Styles marked experimental have not been reviewed by someone who writes that language.

## Take it out again

```
idiolect remove
```

`remove` first lists everything idiolect left behind, with the real paths, and changes nothing.
Then you pick how far it goes:

1. **The style.** The block comes out of every agent file and the choice of style out of `.idiolect/config.json`. `idiolect use --none` does the same.
2. **Everything in this project.** Also the two git hook lines and the whole `.idiolect/` folder.
3. **Everything on this machine.** Also `~/.idiolect/`, your own learned style.

Your own text in an agent file stays byte for byte.
A file that idiolect created and that holds nothing but its block is deleted.
Levels 2 and 3 name what cannot be brought back, such as eval reports, and ask before they delete it: `yes` removes, `no` or Enter keeps everything.
For scripts: `idiolect remove --style`, `--project` or `--everything`, with `--yes` to skip the question and `--dry-run` to only list.

It cannot undo a file that `unbot --fix` rewrote, git has the old version.
The MCP server registration lives in your agent's own config, remove it with `claude mcp remove idiolect`.

## Learn your own style

```
cd your-repo
idiolect init      # picks your author emails, asks which LLM to use
idiolect scan      # reads your lines, writes ~/.idiolect/profiles/<email>.json and STYLE.md
idiolect show      # the style as your agent reads it
```

A scan ends with one line per language, the total and the next step.
`idiolect scan --verbose` also prints the measured statistics.

```
Kotlin      794 files, 95536 lines, 41 rules
TypeScript   56 files,  8210 lines, 23 rules
Commits     481 commits, 15 rules, 42 written by an agent left out

Learned 79 rules, 12 of them from examples of your code.
Next: idiolect show to read them, idiolect sync to give them to your agent.
```

The scan works without any LLM and gives you the metric rules.
With an LLM it also phrases voice rules from real samples, and every one of them cites the file and line it came from.
The default LLM is the Claude Code you already have, run headless under your own login, so no API key.
It runs in safe mode with idiolect's own prompt, so your `CLAUDE.md`, hooks and plugins do not leak into the rules it writes.
Anthropic, OpenAI, Gemini and any OpenAI-compatible local server such as Ollama work too.
Run `idiolect scan --dry-run` to see exactly what would be sent.
While the model works you see a spinner with the elapsed seconds, and in a pipe one line before and one after.
If the call fails, for example because your Claude Code login expired, the error is followed by what to run, and `idiolect scan --no-llm` always gives you the metric rules.

Scan more than one repo and your style is merged over all of them.
Rules that only hold in one repo, like a team's commit prefixes, are kept as rules for that repo only.

### Feed it to your agent

```
idiolect sync                               # writes the style into CLAUDE.md, AGENTS.md, GEMINI.md, Cursor and Copilot files
claude mcp add idiolect -- npx -y idiolect mcp     # MCP server: get_style, check_style, rewrite_like_me
```

Sync only writes between `<!-- idiolect:start -->` and `<!-- idiolect:end -->` and never touches anything else.
The MCP server re-reads the style on every call, so a rescan or a rule decision is live at once.

### Serve someone else's style in a repo

```
{ "profile": "shakib@example.com" }      # in <repo>/.idiolect/config.json
```

`sync`, `show`, `rules`, `unbot`, `eval`, `ui` and the MCP server then use the style stored under that email in `~/.idiolect/profiles/` inside this repo.
A scan still updates your own style, so this is how you serve a style learned from someone else's code while yours keeps growing.

A style that is not yours is served differently.
Only its voice and layout rules are served: naming, comments, commit messages, formatting.
Its idiom rules, the choice of language features and APIs, are left out because they date with the language.
Its rules for one repo only are never served, and every language rule says which language it is for.
The header tells the agent the style comes from other code, how old that code is, and that the repo's own code and formatter win.
`"borrow": ["voice"]` in the same file narrows it further, `["voice", "layout", "idiom"]` serves everything.
A rule you approve or edit with `idiolect rules` is served whatever its kind.

### Decide on rules

```
idiolect rules list
idiolect rules show kotlin.structure.elvis-return-guards
idiolect rules approve <id...>
idiolect rules reject <id...>
idiolect rules edit <id> "new text"
```

`rules list` groups the rules by section the way the style is rendered, with a marker in front and the id last:
`+` served, `-` held back, `?` pending, `x` rejected.

Your decisions survive rescans.
A rule whose evidence changed after you approved it comes back as pending.

### Unbot

```
idiolect unbot                  # source files changed since HEAD
idiolect unbot --all            # the whole repo
idiolect unbot --llm            # the LLM also checks voice rules, with line numbers
idiolect unbot --fix            # rewrite flagged files in the style
idiolect unbot --strict         # exit 1 when anything is flagged
idiolect hooks install          # warn-only pre-commit hook
```

Fast mode is deterministic: it measures the file and compares it to your numbers, in any supported language.
AI tells like buzzwords, restating comments, `!!`, emoji and TODOs are flagged only if you never do them yourself.

### Dashboard

```
idiolect ui                     # opens in your browser, local only
```

Review every rule with its evidence, approve, reject or edit in place, read the style as it is served in this repo, and browse eval runs.

### Keep it fresh

```
idiolect status                 # the report of bare idiolect, without the prompt
idiolect refresh                # rescans in the background once enough commits have landed
```

`idiolect hooks install` runs the refresh after each commit.

### Measure it

```
idiolect eval            # generates each task with and without the style, a judge picks blind
idiolect eval --quiz     # you pick blind
```

The judge shares a model with the generator, so the quiz is the number that counts.

## Privacy

Code never leaves your machine except the samples sent to the LLM you chose.
Samples are redacted for secrets first.
Your identity lives in `~/.idiolect/config.json`, never in a repo.
`<repo>/.idiolect/config.json` holds repo settings only and is safe to commit.
No telemetry, no accounts, no backend.

A house style holds rules and numbers only: no author emails and no code from the project it was learned from.
The project, its licence and the commit it was learned from are recorded in the style's file in `packages/core/styles/`.

## Status

Personal project, early.
Four styles ship: `kotlin-quiet` and `typescript-terse` are reviewed, `python-spare` and `go-annotated` are experimental until someone who writes those languages has read them.
`SPEC.md` is the design, `HANDOFF.md` the current state, `CLI.md` the planned CLI redesign, `SUGGESTIONS.md` and `bugs/` the backlog, `scripts/styles/README.md` the recipe for adding a style.
