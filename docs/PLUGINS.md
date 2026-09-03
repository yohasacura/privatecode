# Plugins, marketplaces, skills, agents, hooks and MCP servers

PrivateCode runs Claude Code's plugin system. A plugin written for Claude Code installs here
with the instructions its author wrote for Claude Code — the same `/plugin …` commands, the
same files, the same settings keys, the same tool names. If a README says

```
/plugin marketplace add owner/repo
/plugin install some-plugin@some-marketplace
```

type exactly that into the composer (or the REPL), and it works.

## Where to type it

- **The composer.** `/plugin …` lines are run by PrivateCode, never sent to the model, and
  the answer appears as a note in the transcript. `/plugin` alone opens Settings → Plugins.
- **Settings → Plugins.** Three views — Installed, Discover, Marketplaces. Every button runs
  the same `/plugin …` line you could have typed, and shows the same report.
- **The REPL.** The same commands; `/reload-plugins` starts a new session with the plugins
  as they are now.

## The commands

```
/plugin marketplace add <source>     owner/repo, owner/repo@ref, a git URL (…#ref), a
                                     https://…/marketplace.json URL, or a folder
/plugin marketplace list
/plugin marketplace update [name]
/plugin marketplace remove <name>    its plugins are uninstalled first
/plugin install <name>[@marketplace] [--scope user|project|local]
/plugin uninstall <name>[@marketplace] [--scope …]
/plugin enable <name>[@marketplace]
/plugin disable <name>[@marketplace]
/plugin update <name>[@marketplace]
/plugin list [--enabled|--disabled]
/plugin details <name>[@marketplace]
/plugin validate <path>              the checks `claude plugin validate` makes
/reload-plugins
```

`market` for `marketplace`, `i` for `install`, `rm` for `remove` and `-s` for `--scope`
work too. A bare name is enough when only one marketplace offers it.

In the window a change applies at once: the plugin's commands, agents, hooks and MCP
servers are live after the command returns. A **skill** is listed to the model in the system
message, which is fixed when a session starts, so a newly installed skill reaches the model
from the next session (New session) — the same rule `AGENTS.md` follows.

## Scopes

| scope | written to | meaning |
|---|---|---|
| `user` (default) | `%APPDATA%\PrivateCode\settings.json` | every workspace on this machine |
| `project` | `.privatecode/settings.json` | this workspace |
| `local` | `.privatecode/settings.local.json` | this workspace, this machine |

The keys are Claude Code's: `"enabledPlugins": { "name@marketplace": true }` and
`"extraKnownMarketplaces": { "name": { "source": { … } } }`. The files are PrivateCode's:
nothing is read from another tool's `.claude/` folder. A plugin enabled in a settings file
but not installed is listed with the command that installs it.

## Marketplaces on first run

Registered for you, fetched the first time you open Discover or install from them:

| name | source |
|---|---|
| `claude-plugins-official` | `anthropics/claude-plugins-official` — Anthropic's curated catalog, every entry pinned to a commit |
| `claude-community` | `anthropics/claude-plugins-community` — screened community plugins, every entry pinned |
| `claude-code-plugins` | `anthropics/claude-code` — Anthropic's examples: commit-commands, code-review, feature-dev, security-guidance … |
| `anthropic-agent-skills` | `anthropics/skills` — the document skills (docx, pptx, xlsx, pdf) and examples |

Offered with one click in the Marketplaces view, never registered unasked:
`superpowers-marketplace` (obra) and `claude-code-workflows` (wshobson/agents).

The names Claude Code reserves for Anthropic's catalogs cannot be taken by a third-party
marketplace; a name that merely resembles one is accepted and noted.

## The tools have Claude Code's names

`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Agent`,
`TodoWrite`, `AskUserQuestion`, `Skill`, plus PrivateCode's own (`list_dir`, `move_file`,
`delete_file`, `background_task`, `git_status`, `symbol_outline`, `browser`, `database`,
`csharp_nav`, `sql_deploy`, `remember`, `recall`, `sessions`) and MCP tools as
`mcp__<server>__<tool>`. A hook matcher, an agent's `tools:` line and a permission rule
name the tool itself. The three names Claude Code retired — `Task` (now `Agent`),
`MultiEdit` (now `Edit`), `LS` (`list_dir`) — are read as what they became.

`Bash` is bash. PrivateCode ships Git for Windows' bash and coreutils (`vendor/git`, see its
`PROVENANCE.md`) and runs the tool under them, as Claude Code does on Windows; a machine with
Git for Windows installed is the fallback, `PRIVATECODE_BASH` the override. The arguments are
Claude Code's: `command`, `timeout` (milliseconds), `description`, `run_in_background`, plus
`cwd` for a workspace of several folders. The vendored coreutils come first on the command's
PATH, a plugin's `bin/` next, the machine's PATH after that, so `git`, `node`, `python` and
`dotnet` are the machine's own.

Settings files written before 2026-09-03 keep working: `edit_file(src/**)` is read as
`Edit(src/**)`, `run_command(npm test:*)` as `Bash(npm test:*)`, and so on. A session
recorded before then is shown with the tools' current names.

## What a plugin contributes

| in the plugin | in PrivateCode |
|---|---|
| `skills/<name>/SKILL.md` | a skill `plugin:name`, listed to the model and callable as `/plugin:name` |
| `commands/<name>.md` (`sub/name.md` → `sub:name`) | `/plugin:name`; `$ARGUMENTS`, `$1`…`$9`, frontmatter `description` and `argument-hint` |
| `agents/<name>.md` | an `Agent` role `plugin:name`; `tools`, `disallowedTools`, `permissionMode`, `maxTurns` honoured |
| `hooks/hooks.json` | Claude Code's hook contract, run by PrivateCode (below) |
| `.mcp.json` / `mcpServers` | servers `plugin:<plugin>:<server>`, tools `mcp__plugin_<plugin>_<server>__<tool>` |
| `bin/` | on PATH for `Bash` |

`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_PROJECT_DIR}` are substituted
and exported. `${VAR:-default}` works in `.mcp.json`.

## Skills that ship with the app

Four skills are bundled (Settings → Skills lists them under "bundled"), each also a slash
command:

| skill | what it is for |
|---|---|
| `/skill-creator` | writing a new skill: where it lives, the frontmatter, a description that fires, what to bundle |
| `/grill-me` | interrogating a plan one question at a time, each with a recommended answer, reading the code first |
| `/mermaid` | diagrams as Mermaid; a ```mermaid block in the reply is rendered in the transcript |
| `/pptx` | PowerPoint decks: a JSON deck spec becomes a designed deck (six themes, cards, stats, charts, tables, timelines, notes) with every text box checked to fit; existing decks are outlined, text-replaced, trimmed, validated and rendered to PNG through PowerPoint. One Node tool, `pptx.cjs`, beside the skill — no Python |

A skill of the same name in `.privatecode/skills/` or `%APPDATA%\PrivateCode\skills\`
replaces the bundled one.

## Hooks

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `SessionEnd`. Matchers are Claude Code's
(`*`, `Edit|Write`, a regex) against the tool's name.

A hook reads JSON on stdin (`session_id`, `cwd`, `hook_event_name`, `tool_name`,
`tool_input`, `tool_response`, `prompt`, …). `tool_input` carries the tool's arguments as
PrivateCode names them, and beside them the field names Claude Code's tools use
(`file_path`, `old_string`, `new_string`, `command`), so a script that reads
`.tool_input.file_path` works. Exit 0 continues (a JSON object on stdout is read for
`permissionDecision`, `updatedInput`, `additionalContext`, `decision: "block"`,
`continue`, `systemMessage`); exit 2 blocks, with stderr as the reason; anything else is a
non-blocking error, and three in a row switch the hook off for the session.

A `PreToolUse` deny is a deny — it reaches the model as one, before the permission gate. An
`ask` sends the call to the approval card. An `allow` skips the ask tier but never a deny
rule. Hooks run under Git Bash when it is installed (Claude Code's own choice on Windows),
PowerShell otherwise. Only `type: "command"` hooks run; `prompt`, `agent` and `http` hooks
are reported as unsupported.

PrivateCode's own `"hooks": [{ "after": "Edit(src/**)", "command": "…" }]` list keeps
working exactly as before.

## Safety

A plugin runs code: its hooks are shell, its MCP servers are processes, its `bin/` is on
PATH. Install says what a plugin adds and names its hooks and servers in one sentence.
Hooks and servers from a plugin obey the permission engine exactly as your own do. Pinned
commits are checked out; an entry that moves its pin is an update, shown as one. A path
inside a plugin cannot escape it. `npm` and `command` sources are refused.

Not supported, and said so in Settings → Plugins rather than silently dropped: LSP
servers, monitors, output styles, themes, workflows, channels, `userConfig`,
`dependencies`, a plugin's own `settings.json`, `context: fork` skills (run inline), and
`` !`cmd` `` inside a command (left in the text, marked as not run).

## Where things live

```
%APPDATA%\PrivateCode\plugins\
  known_marketplaces.json
  installed_plugins.json
  marketplaces\<name>\               a clone, or a fetched marketplace.json
  cache\<marketplace>\<plugin>\<version>\   ${CLAUDE_PLUGIN_ROOT}
  data\<plugin>@<marketplace>\       ${CLAUDE_PLUGIN_DATA}, kept across updates
```

The design and its phases: `docs/PLUGINS-2026-09.md`.

## The window does what the console does (2026-09-03)

Everything the REPL's slash commands do has a place in the window, and the model may do it too
when asked:

| Console | Window | Model |
|---|---|---|
| `/plugin marketplace add|list|update|remove` | Settings → Plugins → Marketplaces | the `plugins` tool, gated like a command |
| `/plugin install|uninstall|enable|disable|update|list|details` | Settings → Plugins → Discover / Installed | the `plugins` tool |
| `/plugin validate <folder>` | Settings → Plugins → Marketplaces → Validate | the `plugins` tool |
| `/reload-plugins` | Settings → Plugins → Reload plugins | after an install through the tool, automatic |
| `/skills`, writing a skill by hand | Settings → Skills: New skill (project or user folder), Edit SKILL.md and the files beside it, Open folder | `Write`/`Edit` under `.privatecode/skills/` or the user folder; `skill-creator` guides it |
| an agent file by hand | Settings → Skills → Agents: New agent, Edit, Open folder | `Write`/`Edit` under `.privatecode/agents/` |
| `mcpServers` in `settings.json` | Settings → MCP servers (the JSON, in place) | `Edit` on `.privatecode/settings.json` — asked in every mode |

**Agents of your own.** `.privatecode/agents/*.md` (this workspace) and
`%APPDATA%\PrivateCode\agents\*.md` (every workspace) are read like a plugin's agents — the
same frontmatter (`name`, `description`, `tools`, `permissionMode`, `maxTurns`) — and offered
to the model through the `Agent` tool by name. A project agent shadows a user one, both
shadow a plugin's.

**What the model may write under `.privatecode/`.** Only `state/` (sessions, logs,
checkpoints) is refused outright — the owner's ruling, after the model could not create a
skill because the whole folder was walled off. Skills, agents, commands and notes go through
the ordinary permission gate. `settings.json`, `settings.local.json` and `hooks/` are always
put to the user first, in every mode (autopilot parks the question), because they decide what
the next session runs without asking; a deny rule still wins, and plan mode refuses.
