# Idiolect

Idiolect learns how you write code, comments and commits from your own git history and feeds that to AI coding agents, so what they write reads like you wrote it.

It runs on your machine.
It reads only the lines you authored, measures them, and turns the numbers and a few real examples into a style profile.
Claude Code, Cursor, Copilot and any MCP client can read the profile.
Unbot, the linter, flags code that breaks your habits or sounds like AI, and can rewrite it in your voice.

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

```
npm install -g idiolect
```

Or run it without installing: `npx -y idiolect <command>`.

## Use

```
cd your-repo
idiolect init      # picks your author emails, asks which LLM to use
idiolect scan      # reads your lines, writes ~/.idiolect/profiles/<email>.json and STYLE.md
idiolect show      # the profile as the agent reads it
```

The scan works without any LLM and gives you the metric rules.
With an LLM it also phrases voice rules from real samples, and every one of them cites the file and line it came from.
The default LLM is the Claude Code you already have, run headless under your own login, so no API key.
Anthropic, OpenAI, Gemini and any OpenAI-compatible local server such as Ollama work too.
Run `idiolect scan --dry-run` to see exactly what would be sent.

Scan more than one repo and the profile merges them.
Rules that only hold in one repo, like a team's commit prefixes, are kept as project rules and served only inside that repo.

### Feed it to your agent

```
idiolect sync                               # writes STYLE.md into CLAUDE.md, AGENTS.md, Cursor and Copilot files
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
idiolect unbot                  # Kotlin files changed since HEAD
idiolect unbot --all            # the whole repo
idiolect unbot --llm            # the LLM also checks voice rules, with line numbers
idiolect unbot --fix            # rewrite flagged files in your style
idiolect unbot --strict         # exit 1 when anything is flagged
idiolect hooks install          # warn-only pre-commit hook
```

Fast mode is deterministic: it measures the file and compares it to your numbers, in any supported language.
AI tells like buzzwords, restating comments, `!!`, emoji and TODOs are flagged only if you never do them yourself.

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

## Status

Personal project, early.
`SPEC.md` is the design, `HANDOFF.md` the current state, `SUGGESTIONS.md` and `bugs/` the backlog.
