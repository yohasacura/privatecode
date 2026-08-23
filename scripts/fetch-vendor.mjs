#!/usr/bin/env node
/**
 * Reconstructs `vendor/` from its sources, verifying every byte against the hashes recorded
 * in the PROVENANCE files.
 *
 * These binaries used to be committed. They are 382 MB, and `vendor/sql/sql-probe.exe` alone
 * is 159 MB — past GitHub's hard 100 MiB per-file limit, so the repository could not be
 * pushed at all. They are rebuilt here instead.
 *
 * The point of vendoring is NOT lost by doing this. The reason the PROVENANCE files give for
 * committing them is that the machine the app RUNS on has no toolchain — and it still does
 * not: the release ships the same pinned binaries. What changed is that the machine that
 * BUILDS them (CI, or a dev box) fetches them from the publisher and checks the publisher's
 * own hash first, which is a stronger guarantee than "someone committed a file once".
 *
 *   node scripts/fetch-vendor.mjs            # everything
 *   node scripts/fetch-vendor.mjs --downloads-only   # skip the two dotnet builds
 *
 * Every hash below is copied from the PROVENANCE file beside the binary it verifies. If a
 * download stops matching, this script fails loudly rather than staging an unverified
 * runtime into a privacy tool — which is the supply-chain hole the project exists to avoid.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const vendor = join(repo, 'vendor')

const downloadsOnly = process.argv.includes('--downloads-only')

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** Fetch, and refuse to go further if the publisher's own hash does not match. */
async function download(url, expected, what) {
  process.stdout.write(`  ${what}: downloading… `)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${what}: ${url} -> HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = sha256(buf)
  if (got !== expected) {
    throw new Error(
      `${what}: archive hash mismatch\n  expected ${expected}\n  got      ${got}\n` +
      `  url      ${url}\nRefusing to stage an unverified binary.`,
    )
  }
  process.stdout.write(`ok (${(buf.length / 1048576).toFixed(1)} MB, hash verified)\n`)
  return buf
}

/**
 * Unzip with what Windows already has, so this script keeps its "no dependencies" property.
 *
 * `System32\tar.exe` by its full path deliberately: a bare `tar` resolves to MSYS tar when
 * this runs from a Git Bash shell, and that one fails on a `C:\...` path with status 128.
 * PowerShell's Expand-Archive is the fallback for a Windows old enough to lack bsdtar.
 */
function unzip(buf, into) {
  mkdirSync(into, { recursive: true })
  const archive = join(into, 'archive.zip')
  writeFileSync(archive, buf)
  const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  if (existsSync(systemTar)) {
    execFileSync(systemTar, ['-xf', archive, '-C', into], { stdio: 'inherit' })
  } else {
    execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}' -Force`,
    ], { stdio: 'inherit' })
  }
  rmSync(archive, { force: true })
}

function verifyFile(path, expected, what) {
  const got = sha256(readFileSync(path))
  if (got !== expected) {
    throw new Error(`${what}: extracted file hash mismatch\n  expected ${expected}\n  got      ${got}`)
  }
  console.log(`  ${what}: staged and hash verified`)
}

/** node.exe — see vendor/node/PROVENANCE.md */
async function stageNode() {
  const version = 'v24.19.0'
  const name = `node-${version}-win-x64`
  const buf = await download(
    `https://nodejs.org/dist/${version}/${name}.zip`,
    '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73',
    'node',
  )
  const tmp = mkdtempSync(join(tmpdir(), 'pc-node-'))
  try {
    unzip(buf, tmp)
    const out = join(vendor, 'node')
    mkdirSync(out, { recursive: true })
    cpSync(join(tmp, name, 'node.exe'), join(out, 'node.exe'))
    cpSync(join(tmp, name, 'LICENSE'), join(out, 'LICENSE'))
    verifyFile(
      join(out, 'node.exe'),
      '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237',
      'node.exe',
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** rg.exe — see vendor/ripgrep/PROVENANCE.md */
async function stageRipgrep() {
  const version = '14.1.1'
  const name = `ripgrep-${version}-x86_64-pc-windows-msvc`
  const buf = await download(
    `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${name}.zip`,
    'd0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1',
    'ripgrep',
  )
  const tmp = mkdtempSync(join(tmpdir(), 'pc-rg-'))
  try {
    unzip(buf, tmp)
    const out = join(vendor, 'ripgrep')
    mkdirSync(out, { recursive: true })
    for (const f of ['rg.exe', 'COPYING', 'LICENSE-MIT', 'UNLICENSE']) {
      const from = join(tmp, name, f)
      if (existsSync(from)) cpSync(from, join(out, f))
    }
    verifyFile(
      join(out, 'rg.exe'),
      'f162b54de2adfc72d78adb1dbada2dedda111ae0a5e2f6e9500f4f909664c5d2',
      'rg.exe',
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * The tree-sitter runtime and the five grammars the outline tool supports.
 *
 * Copied out of `core/node_modules` rather than downloaded: both packages are already
 * dependencies of `core` and npm verifies their integrity hashes (recorded in
 * `core/package-lock.json`) on every install — the same publisher-verification role the
 * `.sha256` files play above. Requires `npm ci` in core/ to have run.
 */
function stageTreeSitter() {
  const modules = join(repo, 'core', 'node_modules')
  const runtime = join(modules, 'web-tree-sitter', 'tree-sitter.wasm')
  if (!existsSync(runtime)) {
    throw new Error('tree-sitter: core/node_modules is missing — run `npm ci` in core/ first')
  }
  const out = join(vendor, 'tree-sitter')
  mkdirSync(out, { recursive: true })
  cpSync(runtime, join(out, 'tree-sitter.wasm'))
  // The five the outline tool actually parses. `tree-sitter-wasms` ships dozens; copying the
  // lot would add ~40 MB of grammars nothing loads.
  for (const lang of ['c_sharp', 'javascript', 'python', 'tsx', 'typescript']) {
    const from = join(modules, 'tree-sitter-wasms', 'out', `tree-sitter-${lang}.wasm`)
    if (!existsSync(from)) throw new Error(`tree-sitter: missing grammar ${lang} at ${from}`)
    cpSync(from, join(out, `tree-sitter-${lang}.wasm`))
  }
  console.log('  tree-sitter: 6 wasm files staged from core/node_modules')
}

/**
 * The two .NET helpers, built from source in this repository.
 *
 * Self-contained win-x64 single-file publishes, which is where nearly all of their size goes:
 * the machine the app runs on has no .NET SDK, so the runtime travels with the binary.
 */
function buildDotnet(name, dir, outDir, extraArgs) {
  console.log(`  ${name}: dotnet publish…`)
  execFileSync(
    'dotnet',
    ['publish', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', ...extraArgs,
      '-o', outDir],
    { cwd: join(repo, dir), stdio: 'inherit' },
  )
  console.log(`  ${name}: built into ${outDir}`)
}

async function main() {
  console.log('Staging vendor/ from its sources.\n')
  await stageNode()
  await stageRipgrep()
  stageTreeSitter()

  if (downloadsOnly) {
    console.log('\n--downloads-only: skipped the two dotnet builds.')
    return
  }
  // roslyn-nav publishes its exe among build output; the bundle only wants the exe, so it is
  // published to a scratch directory and the one file copied across. sql-probe is the
  // opposite: `PublishSingleFile` leaves native libraries BESIDE the exe and all of them are
  // needed, so its whole publish directory is the vendor directory. See its PROVENANCE.
  const scratch = mkdtempSync(join(tmpdir(), 'pc-roslyn-'))
  try {
    buildDotnet('roslyn-nav', join('tools', 'roslyn-nav'), scratch, [])
    const out = join(vendor, 'roslyn')
    mkdirSync(out, { recursive: true })
    cpSync(join(scratch, 'roslyn-nav.exe'), join(out, 'roslyn-nav.exe'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  const sqlOut = join(vendor, 'sql')
  buildDotnet('sql-probe', join('tools', 'sql-probe'), sqlOut, [])
  // `bundle.mjs` stages this whole directory, so anything left here ships. The publish drops
  // a .pdb beside the exe; it is debug symbols for a binary nobody debugs from the release,
  // and it was never among the three files this directory is documented to contain.
  rmSync(join(sqlOut, 'sql-probe.pdb'), { force: true })

  console.log('\nvendor/ is staged. `npm run bundle --prefix core` next.')
}

await main()
