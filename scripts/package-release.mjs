#!/usr/bin/env node
/**
 * Turns a finished build into the release artefacts, and writes the manifest the in-app
 * updater reads.
 *
 * Three archives rather than one, and the reason is arithmetic. The sidecar is ~368 MB —
 * node.exe, the two self-contained .NET helpers, ripgrep, the wasm grammars — and it changes
 * when a PROVENANCE file changes, which is maybe twice a year. The app and the agent are a
 * few MB and change every day. One archive would make every bugfix a 380 MB download.
 *
 *   PrivateCode-<version>-win-x64.zip   everything: what a first download gets
 *   PrivateCode-app-<version>.zip       PrivateCode.exe + sidecar/agent.cjs: what an update gets
 *   sidecar-<sha12>.zip                 the heavy half, named by its own content hash
 *   latest.json                         version and SHA-256 of each part
 *
 * The sidecar archive is named by its hash on purpose: two releases that did not touch the
 * vendored binaries produce the same name, so the updater sees the same hash in the manifest
 * and downloads nothing.
 *
 *   node scripts/package-release.mjs [--out release]
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const outDir = join(repo, process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'release')

const version = JSON.parse(readFileSync(join(repo, 'app', 'src-tauri', 'tauri.conf.json'), 'utf8')).version
const built = join(repo, 'app', 'src-tauri', 'target', 'release')
// `app.exe`, not `PrivateCode.exe`: the cargo package is named `app`, and Tauri only renames
// the binary while building an INSTALLER. A portable build never goes through one, so the
// rename happens here -- verified by building and looking, not assumed.
const exe = join(built, 'app.exe')
const sidecarSrc = join(repo, 'core', 'dist', 'sidecar')

if (!existsSync(exe)) throw new Error(`no build at ${exe} — run \`npm run tauri build --prefix app -- --no-bundle\` first`)
if (!existsSync(sidecarSrc)) throw new Error(`no sidecar at ${sidecarSrc} — run \`npm run bundle --prefix core\` first`)

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Every file under a directory, sorted, so the tree hash below is stable across machines. */
function walk(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path, base))
    else out.push(relative(base, path).split('\\').join('/'))
  }
  return out
}

/** A directory's identity: its file list and every file's content, hashed as one. */
function treeHash(dir) {
  const h = createHash('sha256')
  for (const rel of walk(dir)) {
    h.update(rel)
    h.update(readFileSync(join(dir, rel)))
  }
  return h.digest('hex')
}

/** Zip with what Windows already has — no dependency, same reasoning as fetch-vendor.mjs. */
function zip(sourceDir, archive) {
  execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${join(sourceDir, '*')}' -DestinationPath '${archive}' -Force -CompressionLevel Optimal`,
  ], { stdio: 'inherit' })
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const staging = join(outDir, '.staging')

// --- the heavy half, named by its own content -------------------------------------------
// Everything under sidecar/ EXCEPT agent.cjs, which is our code and moves constantly.
const heavyDir = join(staging, 'sidecar-payload', 'sidecar')
mkdirSync(heavyDir, { recursive: true })
for (const name of readdirSync(sidecarSrc)) {
  if (name === 'agent.cjs' || name === 'agent.cjs.map') continue
  cpSync(join(sidecarSrc, name), join(heavyDir, name), { recursive: true })
}
const sidecarHash = treeHash(heavyDir)
const sidecarName = `sidecar-${sidecarHash.slice(0, 12)}.zip`
zip(join(staging, 'sidecar-payload'), join(outDir, sidecarName))

// --- the light half: the window and the agent --------------------------------------------
const appDir = join(staging, 'app-payload')
mkdirSync(join(appDir, 'sidecar'), { recursive: true })
cpSync(exe, join(appDir, 'PrivateCode.exe'))
cpSync(join(sidecarSrc, 'agent.cjs'), join(appDir, 'sidecar', 'agent.cjs'))
const appName = `PrivateCode-app-${version}.zip`
zip(appDir, join(outDir, appName))

// --- and the whole thing, for a first download -------------------------------------------
const fullDir = join(staging, 'full-payload')
mkdirSync(fullDir, { recursive: true })
cpSync(appDir, fullDir, { recursive: true })
cpSync(heavyDir, join(fullDir, 'sidecar'), { recursive: true })
cpSync(join(repo, 'LICENSE'), join(fullDir, 'LICENSE'))
cpSync(join(repo, 'README.md'), join(fullDir, 'README.md'))
const fullName = `PrivateCode-${version}-win-x64.zip`
zip(fullDir, join(outDir, fullName))

// --- the manifest the updater reads -------------------------------------------------------
const size = (name) => statSync(join(outDir, name)).size
const manifest = {
  version,
  releasedAt: new Date().toISOString(),
  // Each part carries its own hash. The updater downloads a part only when the hash it holds
  // differs from the one here, which is what makes a routine update ~15 MB instead of ~380.
  app: { file: appName, sha256: sha256(join(outDir, appName)), bytes: size(appName) },
  sidecar: { file: sidecarName, sha256: sha256(join(outDir, sidecarName)), bytes: size(sidecarName), tree: sidecarHash },
  full: { file: fullName, sha256: sha256(join(outDir, fullName)), bytes: size(fullName) },
}
writeFileSync(join(outDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

writeFileSync(join(outDir, 'NOTES.md'), [
  `## PrivateCode ${version}`,
  '',
  'Portable — there is no installer. Unpack anywhere and run `PrivateCode.exe`.',
  '',
  `- **First download:** \`${fullName}\` (${(manifest.full.bytes / 1048576).toFixed(0)} MB) — everything.`,
  `- Already running an older version? It updates itself: the app fetches only what changed,`,
  `  which is usually just \`${appName}\` (${(manifest.app.bytes / 1048576).toFixed(1)} MB).`,
  '',
  'Needs a running llama.cpp server; the app asks for its URL on first run.',
  '',
].join('\n'))

rmSync(staging, { recursive: true, force: true })

for (const f of readdirSync(outDir)) {
  console.log(`  ${f.padEnd(40)} ${(statSync(join(outDir, f)).size / 1048576).toFixed(1)} MB`)
}
// Consumed by the workflow's artifact name.
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`, { flag: 'a' })
}
