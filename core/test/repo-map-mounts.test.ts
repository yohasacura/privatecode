import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Mount } from '../src/mounts.js'
import { buildRepoMap, DEFAULT_MAP_BUDGET } from '../src/outline/repo-map.js'

/**
 * One map over several folders.
 *
 * The two things that have to hold: a path in the map is a path the model can hand straight
 * back to Read, and no single folder can eat the map. The second is not hypothetical —
 * an attached upstream project is routinely ten times the size of the thing you are editing.
 */

let base: string

function project(name: string, files: number): string {
  const root = join(base, name)
  mkdirSync(join(root, 'src'), { recursive: true })
  for (let i = 0; i < files; i++) {
    writeFileSync(
      join(root, 'src', `mod${i}.ts`),
      `export class Thing${i} {\n  run() { return ${i} }\n}\nexport function helper${i}() {}\n`,
      'utf8',
    )
  }
  return root
}

beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'pc-map-mnt-')) })
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('a map of several folders', () => {
  test('every path names its folder, so it can be read back verbatim', async () => {
    const mounts: Mount[] = [
      { name: 'app', root: project('app', 3), access: 'write', primary: true },
      { name: 'engine', root: project('engine', 3), access: 'write', primary: false },
    ]
    const map = await buildRepoMap(mounts)
    expect(map).toContain('app/src/mod0.ts')
    expect(map).toContain('engine/src/mod0.ts')
    // Never the bare form: the jail refuses it, and the model copies what it sees.
    expect(map).not.toMatch(/^src\/mod0\.ts$/m)
  })

  test('a read-only folder says so, where the model will read it', async () => {
    const mounts: Mount[] = [
      { name: 'app', root: project('app', 2), access: 'write', primary: true },
      { name: 'upstream', root: project('upstream', 2), access: 'read', primary: false },
    ]
    const map = await buildRepoMap(mounts)
    expect(map).toContain('## upstream/')
    expect(map).toContain('read-only reference')
  })

  test('a big attached folder cannot squeeze a small one out of the map', async () => {
    // The failure this rules out: attach llama.cpp beside a six-file project, and the map
    // becomes a map of llama.cpp.
    const mounts: Mount[] = [
      { name: 'small', root: project('small', 4), access: 'write', primary: true },
      { name: 'huge', root: project('huge', 400), access: 'write', primary: false },
    ]
    const map = await buildRepoMap(mounts)
    for (let i = 0; i < 4; i++) expect(map).toContain(`small/src/mod${i}.ts`)
  })

  test('it stays inside its budget, notes about omitted files included', async () => {
    const mounts: Mount[] = [
      { name: 'a', root: project('a', 200), access: 'write', primary: true },
      { name: 'b', root: project('b', 200), access: 'write', primary: false },
      { name: 'c', root: project('c', 200), access: 'read', primary: false },
    ]
    const map = await buildRepoMap(mounts)
    expect(map.length).toBeLessThanOrEqual(DEFAULT_MAP_BUDGET)
    expect(map).toContain('not listed here')
  })

  test('a folder with no source at all is left out rather than shown empty', async () => {
    mkdirSync(join(base, 'assets'), { recursive: true })
    writeFileSync(join(base, 'assets', 'logo.png'), 'not source', 'utf8')
    const mounts: Mount[] = [
      { name: 'app', root: project('app', 2), access: 'write', primary: true },
      { name: 'assets', root: join(base, 'assets'), access: 'read', primary: false },
    ]
    const map = await buildRepoMap(mounts)
    expect(map).toContain('## app/')
    expect(map).not.toContain('## assets/')
  })

  test('one folder produces the single-project map, unchanged', async () => {
    const root = project('solo', 3)
    const viaMounts = await buildRepoMap([{ name: 'solo', root, access: 'write', primary: true }])
    const viaRoot = await buildRepoMap(root)
    expect(viaMounts).toBe(viaRoot)
    expect(viaRoot).toContain('src/mod0.ts')
    expect(viaRoot).not.toContain('solo/src/mod0.ts')
  })
})
