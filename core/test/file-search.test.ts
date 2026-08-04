import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { rankFiles, scorePath, walkFiles } from '../src/host/file-search.js'

/**
 * The ranking IS the feature. A picker that puts the file you meant third is a picker you
 * stop using and go back to typing the path by hand.
 */

describe('ranking what someone half-remembers', () => {
  const paths = [
    'src/stats.ts',
    'src/session/store.ts',
    'src/host/replay.ts',
    'app/src/panels/sessions-rail.tsx',
    'app/src/panels/changes-tab.tsx',
    'test/stats.test.ts',
    'node_modules/left-pad/stats.js',
  ]

  test('the filename beats the directory, because that is what people type', () => {
    // "session" appears in a DIRECTORY of store.ts and in the NAME of sessions-rail.tsx.
    expect(rankFiles(paths, 'session')[0]?.path).toBe('app/src/panels/sessions-rail.tsx')
  })

  test('contiguous beats scattered', () => {
    const ranked = rankFiles(paths, 'stats').map((m) => m.path)
    expect(ranked[0]).toBe('src/stats.ts')
    expect(ranked).toContain('test/stats.test.ts')
  })

  test('an abbreviation still finds it', () => {
    expect(rankFiles(paths, 'stt').map((m) => m.path)).toContain('src/stats.ts')
  })

  test('a directory fragment finds what is under it', () => {
    expect(rankFiles(paths, 'panels/ch')[0]?.path).toBe('app/src/panels/changes-tab.tsx')
  })

  test('a shorter path wins a tie', () => {
    // Both contain "stats.ts" contiguously in the name; the shallower one is the one meant.
    const ranked = rankFiles(['a/b/c/d/stats.ts', 'stats.ts'], 'stats.ts')
    expect(ranked[0]?.path).toBe('stats.ts')
  })

  test('no match is null, not a low score', () => {
    expect(scorePath('src/stats.ts', 'zzz')).toBeNull()
    expect(rankFiles(paths, 'zzz')).toEqual([])
  })

  test('an empty query keeps the list in its given order', () => {
    // The picker opens on a bare `@`, and "everything, unranked" is the honest answer.
    expect(rankFiles(paths, '', 3).map((m) => m.path)).toEqual(paths.slice(0, 3))
  })

  test('the limit is respected', () => {
    expect(rankFiles(paths, 's', 2)).toHaveLength(2)
  })
})

describe('walking a workspace', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pc-find-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'x')
    writeFileSync(join(root, 'readme.md'), 'x')
    writeFileSync(join(root, '.env'), 'SECRET=1')
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'x')
    writeFileSync(join(root, '.git', 'HEAD'), 'ref')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  test('finds real files and skips the noise nobody searches by name', async () => {
    const files = await walkFiles(root)
    expect(files.sort()).toEqual(['readme.md', 'src/a.ts'])
  })

  test('paths are relative and slash-separated on every platform', async () => {
    // The composer inserts these verbatim and the host resolves them; a backslash here
    // would be a path the model is then asked to read.
    const files = await walkFiles(root)
    expect(files.every((f) => !f.includes('\\'))).toBe(true)
  })

  test('the walk is bounded, so a huge repository cannot hang a keystroke', async () => {
    for (let i = 0; i < 40; i++) writeFileSync(join(root, `f${i}.txt`), 'x')
    expect((await walkFiles(root, 10)).length).toBeLessThanOrEqual(10)
  })
})
