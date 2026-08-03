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

/** Copies `files` (or, when null, every `.wasm` file present) from `vendor/<name>` in the
 * repo root into `dist/sidecar/vendor/<name>`. */
function stageVendor(name, files) {
  const src = join(repoRoot, 'vendor', name)
  const dst = join(sidecarDir, 'vendor', name)
  mkdirSync(dst, { recursive: true })
  const names = files ?? readdirSync(src).filter((f) => f.endsWith('.wasm'))
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
