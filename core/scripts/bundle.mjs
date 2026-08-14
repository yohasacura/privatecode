#!/usr/bin/env node
/**
 * Bundles the sidecar into a single, dependency-free CommonJS file and stages everything
 * it needs at runtime into `core/dist/sidecar/`:
 *
 *   core/dist/sidecar/
 *     agent.cjs                    -- esbuild output of src/host/stdio-main.ts (execa and
 *                                     every other node_modules dependency inlined; nothing
 *                                     is resolved via node_modules at runtime)
 *     vendor/ripgrep/rg.exe        -- copied from <repo>/vendor/ripgrep/rg.exe
 *     vendor/tree-sitter/*.wasm    -- copied from <repo>/vendor/tree-sitter/*.wasm
 *
 * This layout is deliberate: PRIVATECODE_RG and PRIVATECODE_TS_WASM_DIR (see
 * tools/search-code.ts and outline/tree-sitter.ts) are read by whatever launches the
 * sidecar -- never guessed by the sidecar itself (stdio-main.ts's own doc comment) -- so
 * the launcher (the dev driver used in this task's verification, or
 * app/src-tauri/src/main.rs from Task 4 on) sets both env vars to point at the `vendor/`
 * subtrees staged right here, next to agent.cjs. That is what lets this whole directory be
 * copied anywhere -- a Tauri resources folder, a zip on a USB stick -- and still resolve
 * both assets with no knowledge of where core/ or node_modules used to be.
 *
 * ws-bridge.ts is DELIBERATELY not reachable from this bundle: the only entry point given
 * to esbuild is stdio-main.ts, which never imports ws-bridge.ts, so esbuild's own
 * tree-shaken module graph cannot pull dev-bridge code into agent.cjs. Task 3's
 * verification step greps the built agent.cjs for "ws-bridge" to confirm this directly
 * rather than trusting the entry-point argument alone.
 *
 * Run `npm run bundle` from core/. Also serves as this task's staging-manifest check (see
 * `verifyManifest` below) -- Plan 4 Task 3 explicitly sanctions a script-level check here
 * in place of a vitest file for "the bundle script's staging manifest".
 */
import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const coreRoot = join(here, '..')
const repoRoot = join(coreRoot, '..')
const distDir = join(coreRoot, 'dist')
const sidecarDir = join(distDir, 'sidecar')

/**
 * Copies `files` — or, when null, everything in the directory that is not documentation —
 * from `vendor/<name>` in the repo root into `dist/sidecar/vendor/<name>`.
 *
 * The null case used to mean "every .wasm file", which was the tree-sitter case written as
 * though it were the general one. It is the same set for tree-sitter and the wrong set for a
 * helper whose runtime dependency is a `.dll`: a named list is how one of a pair gets left
 * behind, and a `.wasm` filter is how BOTH do, loudly, by staging nothing at all.
 */
function stageVendor(name, files) {
  const src = join(repoRoot, 'vendor', name)
  const dst = join(sidecarDir, 'vendor', name)
  mkdirSync(dst, { recursive: true })
  const names = files ?? readdirSync(src).filter((f) => !f.toLowerCase().endsWith('.md'))
  if (names.length === 0) {
    throw new Error(`bundle.mjs: no files found to stage from ${src}`)
  }
  for (const f of names) {
    copyFileSync(join(src, f), join(dst, f))
  }
}

/**
 * The staging-manifest check: every file this bundle is supposed to have produced must
 * exist and be non-empty. Thrown, not merely logged -- a broken bundle must fail
 * `npm run bundle` itself (and therefore any CI/packaging step that runs it), not silently
 * ship an empty rg.exe or a zero-byte wasm grammar.
 */
function verifyManifest() {
  const manifest = [
    join(sidecarDir, 'agent.cjs'),
    join(sidecarDir, 'vendor', 'ripgrep', 'rg.exe'),
    ...readdirSync(join(sidecarDir, 'vendor', 'tree-sitter')).map((f) =>
      join(sidecarDir, 'vendor', 'tree-sitter', f)),
  ]
  // Once the runtime is vendored (Task 9), a bundle without it is broken -- releases
  // launch sidecar/node.exe, so its absence must fail the build, not ship silently.
  if (existsSync(join(coreRoot, '..', 'vendor', 'node', 'node.exe'))) {
    manifest.push(join(sidecarDir, 'node.exe'))
  }
  // The C# navigator is OPTIONAL: it is 92 MB and only earns its place on a machine that
  // works on C#. A build without it is a build whose csharp_nav says so and carries on, so
  // its absence must not fail the bundle -- but a staged copy that is empty must.
  if (existsSync(join(repoRoot, 'vendor', 'roslyn', 'roslyn-nav.exe'))) {
    manifest.push(join(sidecarDir, 'vendor', 'roslyn', 'roslyn-nav.exe'))
  }
  // Optional the same way, and checked as a PAIR. The SQL helper's native SNI library is
  // left beside the exe by a single-file publish, and an exe staged without it starts fine
  // and then cannot connect to anything -- a broken install that presents as a network
  // fault. Naming both here is what makes a half-staged copy fail the build instead.
  if (existsSync(join(repoRoot, 'vendor', 'sql', 'sql-probe.exe'))) {
    manifest.push(join(sidecarDir, 'vendor', 'sql', 'sql-probe.exe'))
    manifest.push(join(sidecarDir, 'vendor', 'sql', 'Microsoft.Data.SqlClient.SNI.dll'))
  }
  for (const path of manifest) {
    if (!existsSync(path)) throw new Error(`bundle.mjs: staging manifest failed -- missing ${path}`)
    const size = statSync(path).size
    if (size <= 0) throw new Error(`bundle.mjs: staging manifest failed -- ${path} is empty`)
  }
  console.log(`bundle.mjs: manifest check passed (${manifest.length} files, all present and non-empty)`)
  return manifest
}

async function main() {
  rmSync(sidecarDir, { recursive: true, force: true })
  mkdirSync(sidecarDir, { recursive: true })

  await build({
    entryPoints: [join(coreRoot, 'src', 'host', 'stdio-main.ts')],
    outfile: join(sidecarDir, 'agent.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    minify: false,
    sourcemap: true,
    logLevel: 'info',
  })

  stageVendor('ripgrep', ['rg.exe'])
  stageVendor('tree-sitter', null)
  // Optional, and staged only when it has been published — see verifyManifest. 92 MB of
  // self-contained .NET buys semantic C# navigation on a machine with no SDK installed;
  // on a machine that never touches C# it is 92 MB of nothing.
  if (existsSync(join(repoRoot, 'vendor', 'roslyn', 'roslyn-nav.exe'))) {
    stageVendor('roslyn', ['roslyn-nav.exe'])
  }
  // Whole directory rather than a named list: the helper is an exe plus a native library,
  // and a per-file copy is exactly how one of them gets left behind.
  if (existsSync(join(repoRoot, 'vendor', 'sql', 'sql-probe.exe'))) {
    stageVendor('sql', null)
  }
  // The vendored Node runtime (Task 9) rides at the sidecar root, next to agent.cjs,
  // so the release shell's launch line is simply `sidecar/node.exe sidecar/agent.cjs`.
  // Optional until vendor/node exists (pre-Task-9 checkouts still bundle for dev use,
  // where the developer's PATH node runs the bundle instead).
  const vendoredNode = join(repoRoot, 'vendor', 'node', 'node.exe')
  if (existsSync(vendoredNode)) {
    copyFileSync(vendoredNode, join(sidecarDir, 'node.exe'))
  }

  const manifest = verifyManifest()
  console.log(`bundle.mjs: staged sidecar at ${sidecarDir}`)
  for (const path of manifest) console.log(`  ${path} (${statSync(path).size} bytes)`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
