# Vendored ripgrep

`rg.exe` here is the search engine behind the `search_code` tool. It is committed rather
than installed because PrivateCode is an offline tool that must work on a machine with
nothing set up — and because a pinned binary behaves identically on both laptops, where a
system install would drift.

## What this is and where it came from

- **Version:** ripgrep 14.1.1 (`rev 4649aa9700`), `x86_64-pc-windows-msvc`
- **Source:** the official GitHub release,
  `https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip`
- **Archive SHA-256:** `d0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1`
  — verified against the publisher's own `.sha256` file at download time, before extraction.
- **Extracted `rg.exe` SHA-256:** `f162b54de2adfc72d78adb1dbada2dedda111ae0a5e2f6e9500f4f909664c5d2`
- **Vendored:** 2026-08-02
- **Licence:** MIT / Unlicense (dual), both included alongside the binary.

## Why it is here at all

The plan originally recorded "ripgrep 14.1.1, already on PATH". That was wrong. The `rg`
seen during the initial toolchain probe was a copy vendored inside the development
harness, visible only to its own shells. Checked directly through PowerShell, **ripgrep is
not installed on this machine**, and `search_code` would have failed on the user's laptop —
silently, reporting "no matches" for every query, because a missing binary and an empty
result were indistinguishable.

## Rules

- Verify the publisher's checksum before replacing this binary. An unverified search
  binary in a privacy tool is exactly the supply-chain hole the project exists to avoid.
- Update this file whenever the binary changes: version, URL, both hashes, and the date.
- When the Tauri shell is built, this becomes the sidecar binary. Nothing about the
  resolution order in `search-code.ts` should change — it already prefers this copy.

## Where this file comes from now

It is **not committed**. `scripts/fetch-vendor.mjs` recreates it from the source named above,
verifying the publisher's own SHA-256 before staging, and CI runs that script before every
build. The binaries were removed from git because they total 382 MB and one of them is past
GitHub's hard 100 MiB per-file limit, so a repository carrying them cannot be pushed.

Nothing about the vendoring rationale changed: the machine the app RUNS on still has no
toolchain, and the release still ships this exact pinned binary. What changed is that the
machine that BUILDS it fetches from the publisher and checks the hash first — which is a
stronger guarantee than a blob somebody committed once.
