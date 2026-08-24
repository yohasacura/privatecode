#!/usr/bin/env node
/**
 * Refuses a release whose tag and version do not agree.
 *
 * The updater compares the `version` in the manifest with the running app's own, and the
 * manifest's version comes from `tauri.conf.json` — not from the tag. So tagging `v0.1.1`
 * without bumping that file produces a release that calls itself 0.1.0, which every running
 * 0.1.0 then reads as "nothing new". The release would be published, correct, downloadable —
 * and invisible to the thing that exists to find it. Nothing would look broken.
 *
 * That is the failure this guards. It is cheap and it runs before anything is built.
 *
 *   node scripts/check-version.mjs           # just check the files agree with each other
 *   node scripts/check-version.mjs v0.1.1    # and that they match the tag
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts) => JSON.parse(readFileSync(join(repo, ...parts), 'utf8'))

/** The `version` of the first `[package]` table, without taking on a TOML parser for one line. */
function cargoVersion() {
  const toml = readFileSync(join(repo, 'app', 'src-tauri', 'Cargo.toml'), 'utf8')
  const after = toml.split(/^\[package\]$/m)[1] ?? ''
  // Stops at the next table header, so a dependency's own `version = ` cannot be mistaken
  // for the package's.
  const body = after.split(/^\[/m)[0] ?? ''
  return /^\s*version\s*=\s*"([^"]+)"/m.exec(body)?.[1]
}

const sources = {
  'app/src-tauri/tauri.conf.json': read('app', 'src-tauri', 'tauri.conf.json').version,
  'app/package.json': read('app', 'package.json').version,
  'core/package.json': read('core', 'package.json').version,
  // Not load-bearing — tauri.conf.json's version is what the binary and the updater use, so
  // this one drifted to 0.1.0 while three releases shipped and nothing noticed. It is what
  // cargo prints in every build error and what `cargo metadata` reports, so a stale number
  // here is a small lie told often. Cheap to check; checked.
  'app/src-tauri/Cargo.toml': cargoVersion(),
}

const problems = []
const authoritative = sources['app/src-tauri/tauri.conf.json']
for (const [file, version] of Object.entries(sources)) {
  if (version !== authoritative) {
    problems.push(`${file} says ${version}, but tauri.conf.json says ${authoritative}`)
  }
}

const tag = process.argv[2]
if (tag !== undefined) {
  const wanted = tag.replace(/^v/, '')
  if (wanted !== authoritative) {
    problems.push(
      `the tag is ${tag} but tauri.conf.json says ${authoritative}. ` +
      'A release whose version does not match its tag is invisible to the updater: every ' +
      `running ${authoritative} would compare the manifest's ${authoritative} with its own ` +
      'and conclude there is nothing new.',
    )
  }
}

if (problems.length > 0) {
  console.error('version check failed:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`version ${authoritative}${tag ? ` matches tag ${tag}` : ''}, and all ${Object.keys(sources).length} files agree`)
