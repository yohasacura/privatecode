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

**Deliberately absent:** no images or screenshots — the model this is built for has no
vision tower (DESIGN.md §6). And the app itself opens exactly one network connection: the
server URL you configured.

## Building it yourself

```bash
npm ci --prefix core
npm ci --prefix app
node scripts/fetch-vendor.mjs      # downloads and hash-verifies node/ripgrep, builds the two .NET helpers
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
```

## Licence

[MIT](LICENSE). The binaries the release bundles keep their own licences, which travel with
them under `vendor/`.
