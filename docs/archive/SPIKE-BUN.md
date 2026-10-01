# Spike: `bun build --compile` as the sidecar

**Run 2026-08-13. Bun 1.3.14, Node 24.18.1, same machine, same workspace, warm cache.**

## The question

The sidecar currently ships as **two** artifacts: a vendored `node.exe` (88.5 MB,
SHASUMS-verified) and an esbuild bundle `agent.cjs` (0.87 MB), with the Rust shell handing
the second to the first as a main-module path. `bun build --compile` would make it **one**
executable with no main-module path at all — which is interesting because that path is
exactly where this project has now been bitten twice: `Path::canonicalize` in the dev branch
(July) and Tauri's own `resource_dir()` in the release branch (2026-08-13), both producing a
`\\?\` verbatim path that Node refuses in `resolveMainPath` with `EISDIR: lstat 'D:'`.

So: does it work, and what does it cost?

## It works — everywhere, identically

Three things a compiled single-file binary can plausibly break were exercised directly
(`spike-probe.ts`, deleted with this write-up), then the whole sidecar was driven over its
real ndjson stdio protocol:

| | node + `agent.cjs` | bun `--compile` |
|---|---|---|
| tree-sitter wasm (`outlineFile`) | 4 symbols, 25 ms | **4 symbols, 26 ms** |
| vendored ripgrep (`search_code`) | match found | **byte-identical output** |
| child process (`run_command`) | `exit 0`, output captured | **identical** |
| `init` (boot + repo map) | ok, no problems | **ok, no problems** |
| `terminal.run` → `jobs.list` | output read back | **output read back** |
| `fs.tree` | ok | **ok** |
| exits on stdin close (no `process.exit()`) | yes, 103 ms | **yes, 100 ms** |

Nothing needed a shim, a flag or a code change. The wasm grammars and the ripgrep exe are
found through `PRIVATECODE_TS_WASM_DIR` / `PRIVATECODE_RG` exactly as before — which is the
payoff of `stdio-main.ts`'s rule that locating vendored assets is the launcher's job, never
the sidecar's guess.

## And it costs more than it saves

| | bytes shipped | `init` latency (n=3) |
|---|---|---|
| node.exe + agent.cjs | **93,691,801** | **146 / 160 / 160 ms** |
| bun `--compile` | 99,220,480 (**+5.5 MB**) | 219 / 220 / 221 ms (**+40 %**) |
| bun `--compile --minify --bytecode` | 102,792,704 (**+9.1 MB**) | 225 / 235 ms warm, 553 cold |

`--minify --bytecode` was tried precisely because it might have flipped the verdict. It does
not: bytecode adds more than minification removes, and startup gets slower, not faster.

Build time goes the other way and is the one clear win: **2.4 s for bun against esbuild's
71 ms** — irrelevant either way at this scale.

## Verdict: not now, and the reason is not "it doesn't work"

The case for switching rested on killing the `resolveMainPath` bug class. That class is
already dead — killed twice by hand, and the second fix is one line in the branch that had
never been exercised. Buying it a third time for **+5.5 MB and +65 ms on every session
boot** is paying for a fix already in the tree.

Two things this spike deliberately does **not** claim:

- **It does not solve the staleness trap.** A bun binary still has to be rebuilt and
  re-staged when core changes; the failure of 2026-08-13 (a staged `agent.cjs` two hours
  older than the host code it was supposed to carry) would have happened identically.
- **It does not shrink the installer.** That was the intuition going in — one binary instead
  of a 88 MB interpreter plus a bundle — and the measurement says the opposite.

**What would flip it:** the vendored `node.exe` becoming a maintenance cost (a version bump
with a SHASUMS re-verification per release), or a second platform to ship to, where "one
file per target" starts to beat "an interpreter per target plus a bundle". Neither is true
today.

Re-run it with the two scripts in this spike's commit message if either becomes true.
