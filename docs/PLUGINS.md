# Plugins, marketplaces, skills, agents, hooks and MCP servers

PrivateCode runs Claude Code's plugin system. A plugin written for Claude Code installs here
with the instructions its author wrote for Claude Code — the same `/plugin …` commands, the
same files, the same settings keys. If a README says

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

The key is Claude Code's: `"enabledPlugins": { "name@marketplace": true }`. PrivateCode also
**reads** it from `.claude/settings.json`, `.claude/settings.local.json` and
`~/.claude/settings.json`, so a team's `.claude/settings.json` that enables a plugin is
honoured — a plugin enabled there but not installed is listed with the command that installs
it. `extraKnownMarketplaces` in any of those files registers the marketplace.

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

## What a plugin contributes

| in the plugin | in PrivateCode |
|---|---|
| `skills/<name>/SKILL.md` | a skill `plugin:name`, listed to the model and callable as `/plugin:name` |
| `commands/<name>.md` (`sub/name.md` → `sub:name`) | `/plugin:name`; `$ARGUMENTS`, `$1`…`$9`, frontmatter `description` and `argument-hint` |
| `agents/<name>.md` | a `delegate` role `plugin:name`; `tools`, `permissionMode`, `maxTurns` honoured |
| `hooks/hooks.json` | Claude Code's hook contract, run by PrivateCode (below) |
| `.mcp.json` / `mcpServers` | servers `plugin:<plugin>:<server>`, tools `mcp__plugin_<plugin>_<server>__<tool>` |
| `bin/` | on PATH for `run_command` |

`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_PROJECT_DIR}` are substituted
and exported. `${VAR:-default}` works in `.mcp.json`.

The standalone conventions work too: `.claude/skills`, `.claude/commands`, `.claude/agents`,
`.mcp.json` at the project root, `mcpServers` and `hooks` in `.claude/settings*.json`, and
their `~/.claude/` twins. PrivateCode's own `.privatecode/` and `%APPDATA%\PrivateCode\`
folders are read after them and win a name clash.

## Hooks

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `SessionEnd`. Matchers are Claude Code's
(`*`, `Edit|Write`, a regex) and match either the Claude Code tool name (`Edit`) or
PrivateCode's (`edit_file`).

A hook reads JSON on stdin (`session_id`, `cwd`, `hook_event_name`, `tool_name`,
`tool_input`, `tool_response`, `prompt`, …). `tool_input` carries PrivateCode's arguments and
the Claude Code aliases (`file_path`, `old_string`, `new_string`, `command`), so a script
that reads `.tool_input.file_path` works. Exit 0 continues (a JSON object on stdout is read
for `permissionDecision`, `updatedInput`, `additionalContext`, `decision: "block"`,
`continue`, `systemMessage`); exit 2 blocks, with stderr as the reason; anything else is a
non-blocking error, and three in a row switch the hook off for the session.

A `PreToolUse` deny is a deny — it reaches the model as one, before the permission gate. An
`ask` sends the call to the approval card. An `allow` skips the ask tier but never a deny
rule. Hooks run under Git Bash when it is installed (Claude Code's own choice on Windows),
PowerShell otherwise. Only `type: "command"` hooks run; `prompt`, `agent` and `http` hooks
are reported as unsupported.

PrivateCode's own `"hooks": [{ "after": "edit_file(src/**)", "command": "…" }]` list keeps
working exactly as before.

## Tool names

| Claude Code | PrivateCode |
|---|---|
| Bash | run_command, background_task |
| Edit, MultiEdit | edit_file |
| Write | write_file |
| Read | read_file |
| Glob | find_files |
| Grep | search_code |
| WebFetch, WebSearch | web |
| Task | delegate |
| TodoWrite | todo_write |
| AskUserQuestion | ask_user |
| Skill | use_skill |
| `mcp__*` | `mcp__*` |

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
