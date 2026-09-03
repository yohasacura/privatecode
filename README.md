# PrivateCode

A coding agent that runs entirely on your own machine. No cloud, no telemetry, no account —
the model is a local [llama.cpp](https://github.com/ggml-org/llama.cpp) server you start
yourself, and the agent talks to nothing else.

It is deliberately **not** model-agnostic. PrivateCode is built for one model on one server,
so every layer can use facts about that model a general tool cannot assume — how its cache
behaves, what an output token costs against an input token, when its context can be appended
to and when it must not be rewritten. Those measurements, and what was built on them, are in
[`docs/DESIGN.md`](docs/DESIGN.md).

## What it does

- reads, writes and edits files in a workspace you point it at, with a permission gate in
  front of every write and every command
- searches with ripgrep, understands C# through Roslyn, outlines code through tree-sitter,
  and can query a SQL Server read-only
- checks its own work before it says it is finished: it distils your request into a contract,
  asks when its own readings of that request disagree, states what it is assuming and verifies
  the quotes, runs your project's own build or test command, and audits the result against the
  contract — each of those is a gate that can hand the work back
- keeps going on long tasks by compacting its own history rather than losing the thread

## Requirements

- Windows x64
- a running llama.cpp server (`--jinja`, a single slot); the app asks for its URL on first run
- nothing else — the release carries its own Node runtime, ripgrep, tree-sitter grammars and
  the two .NET helpers

## Install

There is no installer. Download the portable archive from
[Releases](../../releases), unpack it anywhere — a folder, a USB stick — and run
`PrivateCode.exe`. Everything it needs sits beside the executable.

Windows will warn about an unsigned application the first time — the build is not
code-signed. "More info" → "Run anyway".

The app never starts the model server for you, by design: you start llama.cpp yourself and
give the app its URL.

**It updates itself.** Twenty seconds after launch, and twice a day while it stays open, it
looks at the latest release; when there is a newer one a green strip says so, with the size of
what would actually be downloaded (usually a few MB — the 120 MB of pinned binaries only move
when they change). Press the tick and the strip follows the update step by step — the download
by bytes, then verifying, unpacking, installing, restarting — and the new version opens with a
line saying what it replaced. The tick waits while a turn is running, and sending waits while
an update runs. A stalled download ends in an error and a "try again" rather than a frozen
bar; a failure after the swap puts the old version and the old sidecar back; "Not now" is
remembered for that version. "Check for updates" in the command palette asks right away and
says what it found, including "this is the latest". When the pinned binaries do move, the
agent is stopped for the swap (Windows will not rename a folder something is running from)
and comes back if the swap fails. A folder whose app is current but whose binaries are not —
what an updater older than 0.4.1 leaves, having been able to swap only the app — is offered
the binaries on their own: "needs its agent runtime updated".

## Using it

**Modes**, chosen per session: *normal* asks before every edit and every command · *plan* is
read-only · *auto-edit* stops asking about edits · *autopilot* asks once and then runs (red
banner, so the window never looks like normal by accident).

**"Always allow"** writes a permission rule to whichever layer you pick — the user layer in
`%APPDATA%\PrivateCode\settings.json`, or the project layer in
`<workspace>\.privatecode\settings.json`. Settings shows what currently holds standing
permission and takes it back.

**Esc** interrupts a running turn. The partial reply is kept, so continuing is cheap: the
prompt is still a prefix of what the server has cached.

**`<workspace>\.privatecode\`** is split so that opening it shows something readable. What
*you* write is at the top — `settings.json`, `skills\`, `commands\`,
`checkpoints.exclude`. What the tool writes for itself is under `state\` (sessions, logs,
the work log, the checkpoint stores) and there is nothing in there to edit. An existing
workspace is rearranged into this shape the first time it is opened. The whole folder stays
out of git, so nothing in it travels with the project — copy a skill across by hand.

Nothing follows you between machines automatically. `%APPDATA%\PrivateCode\` holds the
user-scope settings, `AGENTS.md` and skills; copy that folder if you want them elsewhere.

**Plugins are Claude Code's plugins.** `/plugin marketplace add owner/repo` and
`/plugin install name@marketplace`, typed in the composer, do what they do in Claude Code —
a plugin's README works as written — and Settings → Plugins has the same commands behind
buttons: Installed, Discover (Anthropic's four catalogs are registered for you and fetched
on first use), Marketplaces. A plugin's skills, slash commands, agents, hooks and MCP
servers all arrive. The tools carry Claude Code's names — `Read`, `Edit`, `Write`, `Bash`,
`Glob`, `Grep`, `WebSearch`, `WebFetch`, `Agent`, `Skill` — so a plugin's hook matchers and
agent files mean here what they mean there. `Bash` is bash: the app ships Git for Windows'
bash and coreutils (`vendor/git`), the same shell Claude Code uses on Windows, so `&&`,
pipes, `grep`, `sed` and `find` work as written; the model's PATH also reaches the
machine's own `git`, `node`, `python` and `dotnet`. Four skills ship with the app: `/skill-creator`,
`/grill-me`, `/mermaid` (diagrams render in the transcript) and `/pptx` — a JSON deck spec
becomes a designed deck (six themes; cards, stats, charts, tables, timelines) with every text
box checked to fit, rendered to PNG through PowerPoint; existing decks are outlined, edited and
validated by the same tool, which is plain Node. Everything the console does, the window
does: Settings → Plugins adds marketplaces, browses and installs, reloads and validates;
Settings → Skills makes a skill or an agent from a template and edits SKILL.md, the scripts
beside it and the agent files in place; Settings → MCP servers edits the JSON. The model
may do the same when asked — the `plugins` tool runs `/plugin …` lines behind the
permission gate, and everything under `.privatecode/` except `state/` is writable
(the settings and hooks always ask first). Details, the hook
contract and what is not supported: [docs/PLUGINS.md](docs/PLUGINS.md).

**Two numbers in `settings.json` shape how much the model is told up front.**
`"prefix": { "mapChars": 20000 }` is how much of the cached prefix the project map may take
— every folder with a file count, then the most-referenced files with their definitions and
line numbers. Bigger means fewer `list_dir` and `Glob` steps on a large workspace, paid
once when the workspace opens (the prefix is prewarmed then, while you type).
`"compaction": { "triggerTokens": 140000 }` is where a long session folds its history.
A configured `verify` command runs by itself right after every step that edits files, and
the model is told so; it should not be running the build itself.

**C# edits are checked by the compiler before the build gets a turn.** After a step that
edited only `.cs` files, the Roslyn helper re-reads those files into its compilation and
reports the errors they introduced — with file, line and code — in a few hundred
milliseconds on a small project and two or three seconds on a three-hundred-file backend,
where `dotnet build` is two and ten seconds respectively. The verify command still runs
once when the turn ends; the compiler's answer is faithful enough to say "you broke X"
right after the edit, not faithful enough to replace the build. It needs nothing configured:
the helper takes the base library and the shared frameworks (ASP.NET Core, WPF, Windows
Forms) from the .NET installation on the machine, the project's packages from its last
build, and the sources the SDK generated into `obj/`. Errors the tree already had when the
session opened are never blamed on an edit.

**Resuming a session is instant when the server can save its state.** Start llama.cpp with
`--slot-save-path <a directory>` and PrivateCode writes the model's state for the session you
are in to that directory every few minutes (one file per workspace, ~23 MB per thousand
tokens) and reads it back when you resume — half a second, measured, where a long
conversation used to be re-read for minutes. Without the flag nothing changes: the transcript
is prefilled in the background as before.

**`"gates"` decides how much checking a task-shaped request buys.** `thorough` (the default)
is everything: the request is distilled into a contract, the plan is seeded, what the change
assumes about the code is checked against the files, the request is read three ways for a
disagreement worth asking about, the work is audited against the contract and an independent
reviewer reads the diff. Measured, that is about a minute on top of a task whose own work
takes fifty seconds. `fast` keeps the contract and the audit — what holds a task to its goal
and catches "done" said early — and drops the rest; `off` runs a turn the way it ran before
contracts existed. The **Checks on / off** chip in the composer is the other axis, per
session: off means nothing checks by itself — not the build after an edit, not the
first-write checks, not the audit — until you ask with `/check` (the build) or `/review` (the
independent read of the diff). An explicit `/review` runs whatever the profile says.

**Deliberately absent:** no images or screenshots — the model this is built for has no
vision tower (DESIGN.md §6). And the app itself opens exactly one network connection: the
server URL you configured.

## Building it yourself

```bash
npm ci --prefix core
npm ci --prefix app
node scripts/fetch-vendor.mjs      # downloads and hash-verifies node, ripgrep and Git Bash; builds the two .NET helpers
npm run bundle --prefix core       # stages the agent sidecar
npm run tauri build --prefix app
```

`scripts/fetch-vendor.mjs` needs the .NET 10 SDK and network access. The binaries it stages
are not in this repository — they are 382 MB and one of them is past GitHub's per-file limit —
but every one of them is pinned: see the `PROVENANCE.md` beside each, which records the exact
source and the SHA-256 the script verifies before staging anything.

## Tests

```bash
npm test --prefix core     # the agent, its gates and its tools
npm test --prefix app      # the window
npm run eval --prefix core # fifteen tasks on two real projects, against the live server
```

The eval (`eval/README.md`) is the number that says whether a change made the agent better:
each task runs in a throwaway copy of a real project and is checked by the project's build,
by hidden xunit tests dropped in afterwards, and by grep — none of which the model sees.

## Licence

[MIT](LICENSE). The binaries the release bundles keep their own licences, which travel with
them under `vendor/`.
