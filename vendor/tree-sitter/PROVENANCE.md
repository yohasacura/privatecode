# Vendored tree-sitter WASM

These six `.wasm` files are the parsing engine behind the `symbol_outline` tool: the
tree-sitter runtime itself (`tree-sitter.wasm`) plus one compiled grammar per supported
language. They are committed rather than resolved from `node_modules` at runtime because
PrivateCode is an offline tool that must work on a machine with nothing set up, and because
a pinned copy behaves identically on both laptops, where a `node_modules` tree would drift
or simply not exist (this is not a build step; the CLI runs from source via `tsx`).

## What this is and where it came from

- **Runtime package:** `web-tree-sitter` **0.24.7** (satisfies the plan's
  `^0.24.5`), a normal `dependency` of `core`.
- **Grammar package:** `tree-sitter-wasms` **0.1.13** (satisfies the plan's
  `^0.1.11`), a `devDependency` of `core` — it exists only to be copied from once, at
  vendoring time; nothing at runtime imports it.
- **Source:** both resolved from the public npm registry via `npm install` on this dev
  machine (network available). Their integrity strings, as recorded by npm itself in
  `core/package-lock.json`:
  - `web-tree-sitter@0.24.7`:
    `sha512-CdC/TqVFbXqR+C51v38hv6wOPatKEUGxa39scAeFSm98wIhZxAYonhRQPSMmfZ2w7JDI0zQDdzdmgtNk06/krQ==`
  - `tree-sitter-wasms@0.1.13`:
    `sha512-wT+cR6DwaIz80/vho3AvSF0N4txuNx/5bcRKoXouOfClpxh/qqrF4URNLQXbbt8MaAxeksZcZd1j8gcGjc+QxQ==`
  - npm verifies these against the published tarball on every install; that is the
    publisher-verification step for these two files, the same role the ripgrep release's
    own `.sha256` file plays in `vendor/ripgrep/PROVENANCE.md`.
- **Vendored:** 2026-08-02
- **Licences:** `web-tree-sitter` is MIT; `tree-sitter-wasms` is Unlicense. Neither
  licence file is duplicated here (they govern the *source packages*, which remain in
  `core/package-lock.json`'s history); this file exists to identify what was copied and
  prove it, not to relicense it.

## ABI verification (done BEFORE vendoring, per the dependency policy)

`web-tree-sitter` and `tree-sitter-wasms` are published independently and are not
guaranteed to agree on the tree-sitter language ABI version — `tree-sitter-wasms`'s own
README makes no compatibility claim at all (checked directly: it only lists installation
instructions and a link to browse the available grammars). So instead of trusting the
`^0.24.5` / `^0.1.11` pin from the plan to just work, both packages were installed and
every grammar was loaded once, for real, in a throwaway script
(`node --input-type=module`, deleted after this check) before anything was copied:

```
web-tree-sitter: 0.24.7
tree-sitter-wasms: 0.1.13
Parser.init() ok
OK  tree-sitter-typescript.wasm  (language.version=14, nodeTypeCount=385)
OK  tree-sitter-tsx.wasm  (language.version=14, nodeTypeCount=405)
OK  tree-sitter-javascript.wasm  (language.version=14, nodeTypeCount=271)
OK  tree-sitter-c_sharp.wasm  (language.version=13, nodeTypeCount=490)
OK  tree-sitter-python.wasm  (language.version=14, nodeTypeCount=274)
```

Every grammar loaded and accepted `setLanguage()` without throwing — including
`tree-sitter-c_sharp.wasm`, whose ABI version (13) differs from the other four (14):
`web-tree-sitter@0.24.7` accepts a range of language ABI versions, not just its own, so a
same-major but older-ABI grammar is not by itself a mismatch. Since the installed pair
(the newest versions satisfying the plan's own `^0.24.5` / `^0.1.11` ranges) verified
clean, there was no need to hunt for a different `tree-sitter-wasms` version — the
"pick the newest compatible one and record why" branch of the policy did not trigger.

## The five copied files + the runtime's own wasm

Copied from `core/node_modules/tree-sitter-wasms/out/` (five grammars) and
`core/node_modules/web-tree-sitter/` (the runtime), then hashed with `Get-FileHash`:

| File | SHA-256 |
| --- | --- |
| `tree-sitter-typescript.wasm` | `8515404DCEED38E1ED86AA34B09FCF3379FFF1B4FF9DD3967BCD6D1EB5AC3D8F` |
| `tree-sitter-tsx.wasm` | `6AA3B2C70E76F5D48EAFEF1093E9C4DE383E13F2FDDE2F4E9B98A378F6A8F1B6` |
| `tree-sitter-javascript.wasm` | `63812B9E275D26851264734868D27A1656BD44A2EF6EB3E85E6B03728C595AB5` |
| `tree-sitter-c_sharp.wasm` | `6266A7E32D68A3459104D994DC848DF15D5672B0EA8E86D327274B694F8E6991` |
| `tree-sitter-python.wasm` | `9056D0FB0C337810D019FAE350E8167786119DA98F0F282ACEAE7AB89EE8253B` |
| `tree-sitter.wasm` | `70AA2B222E10A91306A85F5B9C8E028E3DC09943854AA63640C643FC7E051C2F` |

`symbol_outline` covers `.ts .tsx .js .jsx .mjs .cjs .cs .py`; the JS-family extensions all
share `tree-sitter-javascript.wasm`, `tree-sitter-typescript.wasm`, or
`tree-sitter-tsx.wasm` as appropriate (see `core/src/outline/tree-sitter.ts`'s language
table) — there is no separate `.jsx`/`.mjs`/`.cjs` grammar to vendor.

## Rules

- **Upgrade the runtime and the grammars together, and re-run the ABI check first.**
  `web-tree-sitter`'s language ABI window moves between minor versions; bumping either
  package alone, without re-verifying every grammar against the *other* package's new
  version, is exactly the unverified-pin failure this check exists to catch. Re-run the
  scratch script above (or an equivalent), confirm every grammar still loads, and update
  this file's versions, hashes, and date together in the same change.
- Do not read wasm files from `node_modules` at runtime under any resolution path —
  `tree-sitter-wasms` is a devDependency precisely so it is absent from a production
  install; the runtime only ever reads from `vendor/tree-sitter` (or
  `PRIVATECODE_TS_WASM_DIR`, for tests and overrides).
- A missing or unreadable wasm file must fail loudly, naming the exact path it looked at —
  the ripgrep lesson (`vendor/ripgrep/PROVENANCE.md`): a silent "no symbols" for a missing
  binary is indistinguishable from a genuinely symbol-free file.
- **Bundling:** When the Tauri shell is built, these wasm files ship as bundled resources.
  The resolution order in `core/src/outline/tree-sitter.ts` (env override →
  package-root vendor dir) must keep working from the packaged layout; the env var
  `PRIVATECODE_TS_WASM_DIR` is the escape hatch if the packaged path differs.
