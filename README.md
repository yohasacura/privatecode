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
