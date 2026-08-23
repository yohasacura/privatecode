# Vendored Node.js runtime

`node.exe` here is the runtime that executes the bundled agent sidecar (`agent.cjs`)
inside the packaged Tauri app. It is committed rather than assumed because the work
laptop has NO toolchain by design — the entire point of the packaging plan — and because
a pinned runtime behaves identically on both machines, where a system install would drift.

## What this is and where it came from

- **Version:** Node.js v24.19.0 (LTS "Krypton"), win-x64
- **Source:** the official distribution,
  `https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip`
- **Archive SHA-256:** `57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73`
  — verified against the publisher's own `SHASUMS256.txt` (same dist directory) BEFORE
  extraction.
- **Extracted `node.exe` SHA-256:** `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`
- **Vendored:** 2026-08-03. Smoke-run after extraction: `node.exe --version` → v24.19.0.
- **Licence:** MIT-style (Node.js licence) — the archive's LICENSE file is committed
  alongside the binary.
- Matches the dev machine's major (v24.18.1 installed) so the bundle target
  (`target: node20` floor, `engines.node >= 20.3`) and every measured behavior carry over.

## Rules

- Verify the publisher's checksum before replacing this binary. An unverified runtime in
  a privacy tool is exactly the supply-chain hole the project exists to avoid (see
  `vendor/ripgrep/PROVENANCE.md` — the precedent this file mirrors).
- Update this file whenever the binary changes: version, URL, both hashes, and the date.
- **Bundling rule:** `core/scripts/bundle.mjs` stages this into `core/dist/sidecar/`,
  and the Tauri bundle ships that whole directory as resources; the release shell
  launches `resources/sidecar/node.exe resources/sidecar/agent.cjs`. In `tauri dev` the
  shell uses the developer's PATH node instead — that dev/release difference is
  documented in `app/src-tauri/src/main.rs`.
- Upgrade together with the dev machine's major, never past `agent.cjs`'s esbuild target.

## Where this file comes from now

It is **not committed**. `scripts/fetch-vendor.mjs` recreates it from the source named above,
verifying the publisher's own SHA-256 before staging, and CI runs that script before every
build. The binaries were removed from git because they total 382 MB and one of them is past
GitHub's hard 100 MiB per-file limit, so a repository carrying them cannot be pushed.

Nothing about the vendoring rationale changed: the machine the app RUNS on still has no
toolchain, and the release still ships this exact pinned binary. What changed is that the
machine that BUILDS it fetches from the publisher and checks the hash first — which is a
stronger guarantee than a blob somebody committed once.
