# Idiolect

Idiolect gives AI coding agents a style to write in, so their code stops sounding like AI.

If you write code yourself, it learns how you write code, comments and commits from your own git history, and what the agent writes reads like you wrote it.
If an agent writes most of your code, you pick a style that ships with idiolect, learned from a well-known open source project, and the agent writes clean code in that.

It runs on your machine.
It reads only the lines you authored, measures them, and turns the numbers and a few real examples into a style profile.
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

`idiolect unbot --fix` on it, with a profile learned from 130,000 lines of one developer's Kotlin:

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

## No code of your own yet

If an AI writes most of your code, there is no history to learn from.
Pick a style that ships with idiolect instead.
Each one was learned from a well-known open source project, reviewed by a person and frozen.

```
cd your-project
npx -y idiolect use
```

`use` looks at what the project is written in, shows the styles for those languages as a numbered list, and asks for a number.

```
This project is written in Kotlin and TypeScript.

Kotlin
   1  kotlin-tivi     Few comments, no KDoc, noun-phrase names, short plain commits

TypeScript
   2  typescript-vue  No semicolons, terse lowercase comments, short functions

Type the number of the style you want, one per language [1 2]:
```

A language with under 5% of the project's source files is left out, `--all` shows every style.
`idiolect styles` prints the same list without asking, `idiolect styles show kotlin-tivi` says where a style comes from and lists its rules, and `idiolect use kotlin-tivi typescript-vue` picks by name for scripts.

`use` always creates `AGENTS.md`, the file most agents read.
It creates `CLAUDE.md` only when Claude Code is in use, meaning it is installed or the repo has a `.claude` folder, and a Cursor rule only when the repo has a `.cursor` folder.
It updates `.github/copilot-instructions.md` and `GEMINI.md` when they exist, and `--target <file>` writes any other file.
The files it did not write are named in one line at the end.

That is the whole setup: no scan, no LLM call, no account.
Your agent now writes fewer and shorter comments, plainer names and short commit messages, and `idiolect unbot` flags code that sounds like AI.

A shipped style shapes naming, comments, commit messages and layout.
It leaves the choice of language features to the agent, because the code it was learned from has a date and languages move.
The code already in your repo and your formatter always win over it.
`idiolect rules reject <id>` and `idiolect rules edit <id>` change a style for your repo only, the decisions live in `.idiolect/overrides.json`.
Styles marked experimental have not been reviewed by someone who writes that language.

## Learn your own style

```
cd your-repo
idiolect init      # picks your author emails, asks which LLM to use
idiolect scan      # reads your lines, writes ~/.idiolect/profiles/<email>.json and STYLE.md
idiolect show      # the profile as the agent reads it
```

The scan works without any LLM and gives you the metric rules.
With an LLM it also phrases voice rules from real samples, and every one of them cites the file and line it came from.
The default LLM is the Claude Code you already have, run headless under your own login, so no API key.
It runs in safe mode with idiolect's own prompt, so your `CLAUDE.md`, hooks and plugins do not leak into the rules it writes.
Anthropic, OpenAI, Gemini and any OpenAI-compatible local server such as Ollama work too.
Run `idiolect scan --dry-run` to see exactly what would be sent.

Scan more than one repo and the profile merges them.
Rules that only hold in one repo, like a team's commit prefixes, are kept as project rules and served only inside that repo.

### Feed it to your agent

```
idiolect sync                               # writes STYLE.md into CLAUDE.md, AGENTS.md, GEMINI.md, Cursor and Copilot files
claude mcp add idiolect -- npx -y idiolect mcp     # MCP server: get_style, check_style, rewrite_like_me
```

Sync only writes between `<!-- idiolect:start -->` and `<!-- idiolect:end -->` and never touches anything else.
The MCP server re-reads the profile on every call, so a rescan or a rule decision is live at once.

### Serve another profile in a repo

```
{ "profile": "chris@banes.me" }      # in <repo>/.idiolect/config.json
```

`sync`, `show`, `rules`, `unbot`, `eval`, `ui` and the MCP server then use that profile from `~/.idiolect/profiles/` inside this repo.
A scan still writes your own profile, so this is how you serve a style learned from someone else's code while yours keeps growing.

A profile that is not yours is borrowed, and a borrowed profile is served differently.
Only its voice and layout rules are served: naming, comments, commit messages, formatting.
Its idiom rules, the choice of language features and APIs, are left out because they date with the language.
Its project rules are never served, and every language rule says which language it is for.
The header tells the agent the style is borrowed, how old the code behind it is, and that the repo's own code and formatter win.
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

Your decisions survive rescans.
A rule whose evidence changed after you approved it comes back as pending.

### Unbot

```
idiolect unbot                  # source files changed since HEAD
idiolect unbot --all            # the whole repo
idiolect unbot --llm            # the LLM also checks voice rules, with line numbers
idiolect unbot --fix            # rewrite flagged files in your style
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
idiolect status                 # profile age, pending rules, commits since the last scan
idiolect refresh                # rescans in the background once enough commits have landed
```

`idiolect hooks install` runs the refresh after each commit.

### Measure it

```
idiolect eval            # generates each task with and without the profile, a judge picks blind
idiolect eval --quiz     # you pick blind
```

The judge shares a model with the generator, so the quiz is the number that counts.

## Privacy

Code never leaves your machine except the samples sent to the LLM you chose.
Samples are redacted for secrets first.
Your identity lives in `~/.idiolect/config.json`, never in a repo.
`<repo>/.idiolect/config.json` holds repo settings only and is safe to commit.
No telemetry, no accounts, no backend.

A shipped style holds rules and numbers only: no author emails and no code from the project it was learned from.
`idiolect styles show <style>` names that project, its licence and the date of the code.

## Status

Personal project, early.
Four styles ship: `kotlin-tivi` and `typescript-vue` are reviewed, `python-httpx` and `go-caddy` are experimental until someone who writes those languages has read them.
`SPEC.md` is the design, `HANDOFF.md` the current state, `SUGGESTIONS.md` and `bugs/` the backlog, `scripts/styles/README.md` the recipe for adding a style.
