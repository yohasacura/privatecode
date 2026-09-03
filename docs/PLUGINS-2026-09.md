# Plugins, marketplaces, skills, agents, hooks and MCP — the Claude Code contract in PrivateCode

Status, 2026-09-03: phases A–E landed (commits d484c19, 269a329, 204b002, 454ba3a, b0f8813).
The user-facing description is `docs/PLUGINS.md`; this file is the design and the contract
it was built against. The live proof is `test/integration/plugins-live.test.ts`.

**Amended the same day, on the owner's review** — two decisions below are superseded:

1. **No `.claude/` reading.** §0's "standalone conventions" and the `.claude/`, `~/.claude/`
   and `.mcp.json` twins in §2 are gone. PrivateCode reads its own `.privatecode/` and
   `%APPDATA%\PrivateCode\` folders and the plugins it installed, nothing else. The plugin
   FORMAT (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) stays, because
   that is what a plugin is.
2. **No tool-name table.** The tools took Claude Code's names — `Read`, `Write`, `Edit`,
   `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Agent`, `TodoWrite`,
   `AskUserQuestion`, `Skill` — so §4's translation table and `plugins/tool-names.ts` no
   longer exist: a hook matcher, an agent's `tools:` line and a permission rule name the
   tool itself. The old names are still read from settings files written before the rename
   (`permissions/rules.ts`, `LEGACY_TOOL_NAMES`) and from sessions recorded before it (the
   window's `lib/tools.ts`). `Bash` runs bash — the Git for Windows bash and coreutils
   vendored in `vendor/git` (its PROVENANCE.md, `scripts/fetch-vendor.mjs`), the shell
   Claude Code itself uses on Windows — with Claude Code's arguments (`command`, `timeout`
   in ms, `description`, `run_in_background`) plus `cwd`. `background_task` runs the model's
   jobs under the same bash; the Terminal panel's own commands, and the `verify`, `format`
   and `after` hooks a person writes in settings, stay PowerShell.
3. Four skills ship with the app (`core/skills/`, staged beside the sidecar): `skill-creator`,
   `grill-me`, `mermaid` (the transcript renders ```mermaid blocks) and `pptx` (three
   python-pptx scripts beside it). Lowest precedence; a user or project skill of the same
   name replaces one.

## 0. The promise

A plugin written for Claude Code installs into PrivateCode with the instructions its author
wrote for Claude Code, unchanged. Concretely:

- `/plugin marketplace add anthropics/claude-plugins-official`, `/plugin install
  commit-commands@claude-code-plugins`, `/plugin list`, `/plugin enable`, `/plugin disable`,
  `/plugin uninstall`, `/plugin marketplace list|remove|update`, `/reload-plugins` — typed in
  the composer or the REPL — do what they do in Claude Code.
- The files a plugin is made of are read as Claude Code reads them: `.claude-plugin/plugin.json`,
  `skills/<name>/SKILL.md`, `commands/<name>.md`, `agents/<name>.md`, `hooks/hooks.json`,
  `.mcp.json`, with `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and
  `${CLAUDE_PROJECT_DIR}` substituted.
- A marketplace is `.claude-plugin/marketplace.json` with the same schema and the same
  `source` forms (relative path, `github`, `url`, `git-subdir`, `archive`; see §7 for `npm`
  and `command`).
- The settings keys are the same and live in the same kind of file: `enabledPlugins` and
  `extraKnownMarketplaces` in the user, project or local settings file. PrivateCode writes
  them to its own `.privatecode/settings*.json` and `%APPDATA%\PrivateCode\settings.json`,
  and ALSO reads them from `.claude/settings*.json` and `~/.claude/settings.json`, so a
  README that says "add this to your `.claude/settings.json`" works.
- The standalone conventions work too: `.claude/skills/`, `.claude/commands/`,
  `.claude/agents/`, `.claude/settings.json` hooks and `mcpServers`, `.mcp.json` at the
  project root, and their `~/.claude/` user-level twins — read after PrivateCode's own
  `.privatecode/` and `%APPDATA%\PrivateCode\` equivalents, which win on a name clash.

What the promise is NOT: that every Claude Code feature exists here. §7 lists what a plugin
can declare that PrivateCode ignores, and how it says so (the Errors tab, never silence).

## 1. Sources of truth

Read on 2026-09-02 from code.claude.com/docs: `plugins`, `plugin-marketplaces`,
`plugins-reference`, `discover-plugins`, `hooks`, `skills`, `sub-agents`, `mcp`, `settings`.
The two Anthropic catalogs were read raw: `anthropics/claude-plugins-official` (400+ entries,
`git-subdir`/`url`/relative sources, SHA-pinned) and `anthropics/claude-plugins-community`
(`claude-community`, 1000+ entries, all SHA-pinned).

## 2. The store

`%APPDATA%\PrivateCode\plugins\` — Claude Code's layout under `~/.claude/plugins/`, moved:

```
plugins/
  known_marketplaces.json      { name: { source, installLocation, lastUpdated, autoUpdate } }
  installed_plugins.json       { version: 2, plugins: { "name@marketplace": { version, installPath, installedAt, scopes… } } }
  marketplaces/<name>/         a git clone, or a directory holding a fetched marketplace.json
  cache/<marketplace>/<plugin>/<version>/   the plugin's files (${CLAUDE_PLUGIN_ROOT})
  data/<plugin>@<marketplace>/ persistent across updates (${CLAUDE_PLUGIN_DATA})
```

Enabled state is in settings, exactly as in Claude Code:

```json
{ "enabledPlugins": { "commit-commands@claude-code-plugins": true },
  "extraKnownMarketplaces": { "my-team": { "source": { "source": "github", "repo": "org/repo" } } } }
```

Scope decides the file: `user` → `%APPDATA%\PrivateCode\settings.json`, `project` →
`.privatecode/settings.json`, `local` → `.privatecode/settings.local.json`. The same keys
are honoured when found in `.claude/settings.json`, `.claude/settings.local.json` and
`~/.claude/settings.json` (a plugin enabled there whose marketplace is unknown is reported,
not installed — the same rule Claude Code applies since v2.1.195).

Version resolution, as documented: `plugin.json` `version` → marketplace entry `version` →
the resolved commit SHA (git sources) → the file hash (local/URL sources). A plugin updates
only when that resolves to something new.

## 3. Sources

| form | how it is fetched |
|---|---|
| `owner/repo`, `owner/repo@ref` | `git clone --depth 1 [--branch ref] https://github.com/owner/repo` |
| `https://…/repo.git`, `git@host:…`, `…#ref` | git clone (a `github.com`/`gitlab.com` URL without `.git` is a repo too) |
| `https://…/marketplace.json` | fetched with `fetch`, stored as `marketplaces/<name>/marketplace.json`; relative plugin sources inside it are resolved against the URL's directory |
| `./dir`, `C:\dir`, `./dir/marketplace.json` | read in place (the marketplace directory IS the clone) |
| entry `source: "./x"` | a path inside the marketplace clone, or under `metadata.pluginRoot` |
| entry `{ source: "github", repo, ref?, sha? }` | clone, then `git checkout sha` when pinned |
| entry `{ source: "url", url, ref?, sha? }` | same, any git host |
| entry `{ source: "git-subdir", url, path, ref?, sha? }` | clone, then the subdirectory is the plugin |
| entry `{ source: "archive", url, sha256? }` | downloaded and unzipped; the digest is checked when given |

A pinned `sha` is honoured — it is the one thing that makes the community catalog safe to
install from — and a marketplace update that moves the pin is what "update" means.

## 4. What a plugin contributes, and how each maps

| component | Claude Code | PrivateCode |
|---|---|---|
| skill | `skills/<n>/SKILL.md`, invoked as `/plugin:n`, listed to the model | same folder read, name `plugin:n` in the catalogue and in `Skill`; frontmatter `name`, `description`, `when_to_use`, `disable-model-invocation`, `user-invocable`, `argument-hint`, `allowed-tools` (mapped tool names, session-allow for the turn), `$ARGUMENTS`/`$N` when invoked as a command |
| command | `commands/<n>.md` → `/plugin:n` | a custom command named `plugin:n`; frontmatter `description`/`argument-hint` read, `$ARGUMENTS`, `$1…` substituted; `@file` attaches; `` !`cmd` `` is NOT executed (a template is data — the line is left in place with a note) |
| agent | `agents/<n>.md` frontmatter + body | a `Agent` role named `plugin:n`: `description` → purpose, body → brief, `tools`/`disallowedTools` → mapped tool set, `permissionMode` → mode (`plan`→plan, `acceptEdits`→auto-edit, `bypassPermissions`/`auto`→autopilot, else the caller's), `maxTurns` → maxSteps (default 12); `model`, `color`, `memory`, `hooks`, `skills` are read and reported as ignored |
| hooks | `hooks/hooks.json`, events, matchers, stdin JSON, exit codes, JSON output | the hook engine of §5 |
| MCP | `.mcp.json` / inline `mcpServers`, `${CLAUDE_PLUGIN_ROOT}` | registered as `plugin:<plugin>:<server>`, tools named `mcp__plugin_<plugin>_<server>__<tool>`; stdio and http; env/`${VAR:-default}` expansion |
| `bin/` | on PATH for Bash | prepended to PATH for `Bash` while enabled |
| `settings.json` (`agent`) | main-thread agent | ignored, reported |
| LSP, monitors, output styles, themes, workflows, channels, userConfig, dependencies | | ignored, reported (§7) |

Tool names, both directions (hook matchers, `allowed-tools`, agent `tools`, `permissions`):

| Claude Code | PrivateCode |
|---|---|
| Bash | Bash (and background_task) |
| Edit, MultiEdit | Edit |
| Write | Write |
| Read | Read |
| Glob | Glob |
| Grep | Grep |
| WebFetch, WebSearch | web |
| Task | delegate |
| TodoWrite | TodoWrite |
| AskUserQuestion | AskUserQuestion |
| Skill | Skill |
| NotebookEdit | (none) |
| `mcp__*` | `mcp__*` |

A hook's stdin `tool_name` is the Claude Code name, and `tool_input` carries BOTH shapes —
PrivateCode's arguments and the Claude Code aliases (`file_path`, `old_string`,
`new_string`, `content`, `command`) — so a script written against `.tool_input.file_path`
reads it.

## 5. Hooks

Configured in `hooks/hooks.json` (plugins), in settings files under `"hooks"` (the Claude
Code object shape), and still in PrivateCode's own `[{ after, command }]` list, which keeps
working as a `PostToolUse` hook.

Events implemented: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `SessionEnd`.
Matchers: `*`/empty = all; `A|B` lists; anything else a JavaScript regex (unanchored),
matched against the Claude Code tool name. Only `type: "command"` runs; `http`, `mcp_tool`,
`prompt` and `agent` hooks are listed in Errors as unsupported.

Contract: JSON on stdin (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`,
`tool_use_id`, `tool_response`, `prompt`, `permission_mode`); exit 0 = continue (stdout JSON
parsed when it is an object, else shown to the model for `UserPromptSubmit`/`SessionStart`);
exit 2 = block, stderr goes to the model; anything else = a non-blocking error in the
transcript. JSON fields honoured: `hookSpecificOutput.permissionDecision` (allow/deny/ask),
`permissionDecisionReason`, `updatedInput`, `additionalContext`, `updatedPrompt`,
`continue`, `stopReason`, `systemMessage`, `suppressOutput`. Timeout 60 s (per-hook
`timeout` honoured, in seconds), `async` runs detached. Shell: `bash` when Git Bash is on
this machine (Claude Code's own choice on Windows), else PowerShell; `${CLAUDE_PLUGIN_ROOT}`,
`${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}` substituted and exported.

A `PreToolUse` deny is a deny: it reaches the permission gate before the engine's own
verdict, and the transcript records "refused by hook <plugin>: <reason>". `ask` sends the
call to the approval card. `allow` bypasses the ask tier but never a deny rule — the engine's
deny is consulted first, as it is for every other allow.

## 6. Marketplaces on first run

Registered automatically the first time the plugin store is created, as Claude Code registers
its official one:

| name | source | why it is in |
|---|---|---|
| `claude-plugins-official` | `anthropics/claude-plugins-official` | Anthropic's curated catalog; SHA-pinned entries |
| `claude-community` | `anthropics/claude-plugins-community` | Anthropic's community catalog; every entry passed automated validation and safety screening and is pinned to a commit |
| `claude-code-plugins` | `anthropics/claude-code` | Anthropic's example plugins (commit-commands, code-review, feature-dev, security-guidance…) |
| `anthropic-agent-skills` | `anthropics/skills` | Anthropic's document skills (docx, pptx, xlsx, pdf) and examples |

Offered as one click in the Marketplaces tab, not registered by default — they are
single-author or third-party code, however popular:

| name | source | note |
|---|---|---|
| `superpowers-marketplace` | `obra/superpowers-marketplace` | Jesse Vincent's curated set (superpowers itself is also in the official catalog) |
| `claude-code-workflows` | `wshobson/agents` | 92 plugins, all in-repo relative sources, MIT/Apache |

Not offered: catalogs whose repository has no `.claude-plugin/marketplace.json`
(`davila7/claude-code-templates` distributes through its own CLI) and single-plugin repos
that publish a one-entry marketplace pointing at themselves.

Reserved names (`claude-plugins-official`, `claude-community`, `anthropic-*`, …) are refused
for a third-party marketplace, as Claude Code refuses them.

## 7. Security, and what is not supported

- A plugin runs code: its hooks are shell, its MCP servers are processes, its `bin/` is on
  PATH. Install shows what it will add before enabling — hooks and servers by name — and
  says so in one sentence. Hooks and servers from a plugin obey the permission engine exactly
  as the user's own do: MCP tools ask by default; a hook cannot widen a deny.
- Pinned SHAs are checked out; an entry that moves its pin is an update, shown as one.
- Paths inside a plugin cannot escape it: `../` in a manifest path is rejected, symlinks out
  of the cache are not followed.
- Not supported, reported in the Errors tab and in `/plugin list`: LSP servers, monitors,
  output styles, themes, workflows, channels, `userConfig`, `dependencies`, plugin
  `settings.json`, `npm` and `command` sources, `--plugin-dir` zips, synced plugins,
  `context: fork` skills (run inline), `!\`cmd\`` injection in commands and skills.

## 8. Phases

| phase | what | done when |
|---|---|---|
| A | core `plugins/`: store, marketplaces (all §3 sources), install/uninstall/enable/disable/update, settings writing, manifest reading and validation, `/plugin …` and `/reload-plugins` parsing and execution, default marketplaces | unit tests over local git repositories and a fixture marketplace; `claude plugin validate`'s rules |
| B | the components of §4 loaded into a session: namespaced skills and commands, agents as roles, MCP servers, `bin/`; the `.claude/` and `~/.claude/` standalone conventions | tests per component; a fixture plugin exercised end to end |
| C | the hook engine of §5, with PrivateCode's old `after` hooks running through it | the documented contract tested event by event |
| D | host RPCs and the window: Settings → Plugins (Discover / Installed / Marketplaces / Errors), install scope, details, the composer's `/plugin` and `/reload-plugins`, palette entries, REPL commands | DOM tests; a real install through the bridge |
| E | docs (`docs/PLUGINS.md` for users, README section), a rebuilt app, one real plugin installed from the official catalog and used | the owner's eyes |
