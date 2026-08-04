import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  buildRepoMap, indexWorkspace, rankByReferences, renderFile, renderRepoMap, type FileOutline,
} from '../src/outline/repo-map.js'

/**
 * The map the model reads before it asks anything.
 *
 * Two things are worth testing here and they pull in opposite directions: that the ranking
 * puts the load-bearing files first (a map is only worth its tokens if the right things fit
 * in the budget), and that the rendering never overstates what it knows.
 */

let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pc-map-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function write(rel: string, body: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), body, 'utf8')
}

/** A hand-built outline, for the pure functions -- no tree-sitter, no filesystem. */
function outline(path: string, entries: [string, string, number][], ids: string[] = []): FileOutline {
  return {
    path,
    entries: entries.map(([kind, name, depth]) => ({ kind, name, depth, line: 1 })),
    identifiers: new Set(ids),
  }
}

describe('indexing a workspace', () => {
  test('parses supported sources and finds their definitions', async () => {
    write('src/store.ts', 'export class Store {\n  save() {}\n  load() {}\n}\n')
    write('src/util.ts', 'export function slug(s: string) { return s }\n')

    const files = await indexWorkspace(root)
    const paths = files.map((f) => f.path).sort()
    expect(paths).toEqual(['src/store.ts', 'src/util.ts'])

    const store = files.find((f) => f.path === 'src/store.ts')!
    expect(store.entries.map((e) => e.name)).toContain('Store')
    expect(store.entries.map((e) => e.name)).toContain('save')
  })

  test('a file with no definitions is not a line in the map', async () => {
    write('src/constants.ts', 'export const A = 1\n')
    write('src/real.ts', 'export function go() {}\n')
    const files = await indexWorkspace(root)
    expect(files.map((f) => f.path)).toEqual(['src/real.ts'])
  })

  test('an unparseable or unreadable file is skipped, not fatal', async () => {
    write('src/broken.ts', 'class {{{{ not typescript at all ((((')
    write('src/fine.ts', 'export function ok() {}\n')
    const files = await indexWorkspace(root)
    expect(files.map((f) => f.path)).toContain('src/fine.ts')
  })

  test('node_modules is not the project', async () => {
    write('node_modules/dep/index.js', 'function helper() {}\n')
    write('src/mine.ts', 'export function mine() {}\n')
    const files = await indexWorkspace(root)
    expect(files.map((f) => f.path)).toEqual(['src/mine.ts'])
  })
})

describe('ranking', () => {
  test('the file everything else mentions comes first', () => {
    const core = outline('src/core.ts', [['class', 'Engine', 0]], ['Engine'])
    const lonely = outline('src/lonely.ts', [['function', 'unused', 0]], ['unused'])
    const a = outline('src/a.ts', [['function', 'a', 0]], ['a', 'Engine'])
    const b = outline('src/b.ts', [['function', 'b', 0]], ['b', 'Engine'])

    expect(rankByReferences([lonely, a, b, core])[0]?.path).toBe('src/core.ts')
  })

  test('a file that merely exports a lot does not win by volume', () => {
    // The measure this deliberately avoids: barrels and generated type files export the
    // most names and tell you the least about a project.
    const barrel = outline(
      'src/index.ts',
      [['function', 'x1', 0], ['function', 'x2', 0], ['function', 'x3', 0], ['function', 'x4', 0]],
      ['x1', 'x2', 'x3', 'x4'],
    )
    const used = outline('src/engine.ts', [['class', 'Engine', 0]], ['Engine'])
    const consumer = outline('src/app.ts', [['function', 'main', 0]], ['main', 'Engine'])

    expect(rankByReferences([barrel, used, consumer])[0]?.path).toBe('src/engine.ts')
  })

  test('the order is stable when scores tie', () => {
    const a = outline('src/b.ts', [['function', 'f', 0]], ['f'])
    const b = outline('src/a.ts', [['function', 'g', 0]], ['g'])
    expect(rankByReferences([a, b]).map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('rendering', () => {
  test('a class carries its members on its own line', () => {
    const file = outline('src/store.ts', [
      ['class', 'Store', 0], ['method', 'save', 1], ['method', 'load', 1],
      ['function', 'helper', 0],
    ])
    expect(renderFile(file)).toBe('src/store.ts\n  class Store: save, load\n  function helper')
  })

  test('the header says the map is a snapshot and not the truth', () => {
    // A model that treats a stale map as ground truth is worse off than one with no map.
    const text = renderRepoMap([outline('a.ts', [['function', 'f', 0]])])
    expect(text).toMatch(/snapshot/i)
    expect(text).toMatch(/out of date/i)
    expect(text).toMatch(/read_file|symbol_outline/)
  })

  test('a budget that cuts the listing SAYS how much it cut', () => {
    // Told "here is the project", a model reads a truncated list as complete and concludes
    // a file it cannot see does not exist.
    const files = Array.from({ length: 40 }, (_, i) =>
      outline(`src/file${i}.ts`, [['function', `fn${i}`, 0]]))
    const text = renderRepoMap(files, 1_200)
    expect(text).toMatch(/more source files are not listed/)
    expect(text.length).toBeLessThanOrEqual(1_400) // + the footer that admits it
  })

  test('nothing to say is an empty string, not an empty heading', () => {
    expect(renderRepoMap([])).toBe('')
    // A budget too small for even one file would otherwise emit a header promising a map
    // and then no map.
    expect(renderRepoMap([outline('a.ts', [['function', 'f', 0]])], 10)).toBe('')
  })
})

describe('building it for real', () => {
  test('end to end, a small project maps to its own structure', async () => {
    write('src/engine.ts', 'export class Engine {\n  start() {}\n}\n')
    write('src/app.ts', 'import { Engine } from "./engine"\nexport function main() { new Engine() }\n')

    const map = await buildRepoMap(root)
    expect(map).toContain('src/engine.ts')
    expect(map).toContain('class Engine: start')
    // Engine is referenced by app.ts, so it leads.
    expect(map.indexOf('src/engine.ts')).toBeLessThan(map.indexOf('src/app.ts'))
  })

  test('a workspace that cannot be indexed yields no map, never a throw', async () => {
    await expect(buildRepoMap(join(root, 'does', 'not', 'exist'))).resolves.toBe('')
  })
})

describe('the vocabulary rule', () => {
  test('a name in most files of a LARGE project stops counting as a reference', () => {
    // `validate` and `execute` appear in every tool in this codebase, which made a test
    // file listing them six times the very first entry of the real map. Spread that wide is
    // vocabulary, not evidence about the file that defines it.
    const everywhere = Array.from({ length: 30 }, (_, i) =>
      outline(`src/tool${i}.ts`, [['method', 'validate', 0]], ['validate', 'unique' + i]))
    const genuine = outline('src/engine.ts', [['class', 'Engine', 0]], ['Engine'])
    const users = Array.from({ length: 3 }, (_, i) =>
      outline(`src/use${i}.ts`, [['function', `u${i}`, 0]], [`u${i}`, 'Engine']))

    const ranked = rankByReferences([...everywhere, genuine, ...users])
    expect(ranked[0]?.path).toBe('src/engine.ts')
  })

  test('but in a SMALL project nothing is vocabulary', () => {
    // A share is a statistic and a statistic needs a population. In a four-file project the
    // name three of them mention is the most central thing there. The first version of the
    // damping scored that file zero and ranked it last.
    const core = outline('src/core.ts', [['class', 'Engine', 0]], ['Engine'])
    const a = outline('src/a.ts', [['function', 'a', 0]], ['a', 'Engine'])
    const b = outline('src/b.ts', [['function', 'b', 0]], ['b', 'Engine'])
    expect(rankByReferences([a, b, core])[0]?.path).toBe('src/core.ts')
  })
})

describe('breadth', () => {
  test('one enormous file cannot eat the whole map', () => {
    // protocol.ts defines ninety types; uncapped it took most of a 6k budget by itself and
    // left a map of five files where twenty-five would have been more use.
    const huge = outline(
      'src/protocol.ts',
      Array.from({ length: 90 }, (_, i) => ['type', `T${i}`, 0] as [string, string, number]),
    )
    const others = Array.from({ length: 20 }, (_, i) =>
      outline(`src/file${i}.ts`, [['function', `fn${i}`, 0]]))

    const text = renderRepoMap([huge, ...others], 4_000)
    expect(text).toMatch(/…and 84 more/)
    // Everything else still got a line.
    expect(text).toContain('src/file19.ts')
  })

  test('a class with thirty methods lists some of them, not all', () => {
    const entries: [string, string, number][] = [['class', 'Big', 0]]
    for (let i = 0; i < 30; i++) entries.push(['method', `m${i}`, 1])
    const rendered = renderFile(outline('src/big.ts', entries))
    expect(rendered).toContain('m0, m1')
    expect(rendered).toMatch(/…\+22/)
    expect(rendered).not.toContain('m29')
  })
})
