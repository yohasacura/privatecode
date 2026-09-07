import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { fileDigest, mapIndexFor, matchingLines, renderDigest, sha1 } from '../src/map/digest.js'
import type { FileNote, MapIndex } from '../src/map/notes.js'
import type { MapFileNode } from '../src/map/skeleton.js'
import { ReadMemory } from '../src/tools/read-memory.js'
import { readFileTool } from '../src/tools/read-file.js'
import { Workspace } from '../src/workspace.js'

/**
 * The map rides along with the file: a Read of a file that has a fresh note returns the
 * note's digest on top of the text, once per context, and never for a note about other
 * bytes. Delivered, not offered — offered, it was never taken (docs/MAP.md).
 */

const SOURCE = 'export function placeOrder(total: number): string { return String(total) }\n'

function note(path: string, hash: string): FileNote {
  return {
    kind: 'file', path, hash,
    what: 'Places an order.', why: 'Because orders.',
    contracts: [{ symbol: 'placeOrder', guarantees: 'returns the formatted total' }],
    invariants: ['totals are cents'],
    gotchas: ['doubles the total on retry'],
    builtAt: '2026-09-08T00:00:00.000Z', model: 'scripted',
  }
}

function node(path: string, hash: string): MapFileNode {
  return {
    path, hash, bytes: SOURCE.length, lines: 1, language: 'ts', symbols: [],
    uses: ['src/money.ts'], usedBy: ['src/cli.ts'], tests: ['test/orders.test.ts'], isTest: false,
    coChanges: [{ path: 'src/money.ts', count: 2 }], history: ['orders'],
  }
}

function indexWith(root: string, path: string, hash: string): MapIndex {
  return {
    version: 1, builtAt: '2026-09-08T00:00:00.000Z',
    skeleton: { builtAt: '2026-09-08T00:00:00.000Z', commits: 1, files: [node(path, hash)], modules: [{ path: '', files: [path], children: [] }], mounts: [{ name: '', root }] },
    notes: { files: { [path]: note(path, hash) }, modules: {} },
  }
}

describe('the digest of a note', () => {
  test('carries what, contracts, invariants, gotchas and the neighbours, and points at the full note', () => {
    const d = renderDigest(note('src/orders.ts', 'h'), node('src/orders.ts', 'h'))
    expect(d).toContain('[Project map — a note written from this exact version of src/orders.ts]')
    expect(d).toContain('What: Places an order.')
    expect(d).toContain('Contracts: placeOrder — returns the formatted total')
    expect(d).toContain('Invariants: totals are cents')
    expect(d).toContain('Gotchas: doubles the total on retry')
    expect(d).toContain('Related: uses money.ts; used by cli.ts; tests orders.test.ts; changes with money.ts')
    expect(d).toContain('ProjectMap path "src/orders.ts"')
  })

  test('is only given for the bytes the note was written from', () => {
    const index = indexWith('D:/x', 'src/orders.ts', sha1(SOURCE))
    expect(fileDigest(index, 'src/orders.ts', SOURCE)).not.toBeNull()
    expect(fileDigest(index, 'src/orders.ts', `${SOURCE}// changed\n`)).toBeNull()
    expect(fileDigest(index, 'src/other.ts', SOURCE)).toBeNull()
  })

  test('a search hit carries the lines that matched', () => {
    const n = note('src/orders.ts', 'h')
    expect(matchingLines(n, ['formatted'])).toEqual(['  · contract: placeOrder — returns the formatted total'])
    expect(matchingLines(n, ['retry', 'cents'])).toEqual(['  · invariant: totals are cents', '  · gotcha: doubles the total on retry'])
    expect(matchingLines(n, ['nothing'])).toEqual([])
  })
})

describe('reading a file that has a note', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pc-digest-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, '.privatecode', 'map'), { recursive: true })
    writeFileSync(join(root, 'src', 'orders.ts'), SOURCE, 'utf8')
    writeFileSync(join(root, '.privatecode', 'map', 'index.json'), JSON.stringify(indexWith(root, 'src/orders.ts', sha1(SOURCE))), 'utf8')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  test('the note comes on top of the text, once per context, and not once the file moved on', async () => {
    const reads = new ReadMemory()
    const ctx = { workspace: new Workspace(root), reads }
    const first = await readFileTool.execute({ path: 'src/orders.ts' }, ctx)
    expect(first.ok).toBe(true)
    expect(first.content).toContain('src/orders.ts (1 lines)\n\n[Project map — a note written from this exact version of src/orders.ts]')
    expect(first.content).toContain('Gotchas: doubles the total on retry')
    expect(first.content).toContain('1\texport function placeOrder')
    // What the window shows is the file alone.
    expect(first.display).toBe('src/orders.ts (1 lines)\n1\texport function placeOrder(total: number): string { return String(total) }')

    const again = await readFileTool.execute({ path: 'src/orders.ts', start_line: 1, end_line: 1 }, ctx)
    expect(again.content).not.toContain('[Project map')

    reads.clear()
    const afterSwap = await readFileTool.execute({ path: 'src/orders.ts', full: true }, ctx)
    expect(afterSwap.content).toContain('[Project map')

    writeFileSync(join(root, 'src', 'orders.ts'), `${SOURCE}// edited\n`, 'utf8')
    const moved = await readFileTool.execute({ path: 'src/orders.ts', full: true }, { workspace: new Workspace(root), reads: new ReadMemory() })
    expect(moved.content).not.toContain('[Project map')
  })

  test('the index is re-read when it changes on disk and dropped when it goes', () => {
    const dir = join(root, '.privatecode', 'map')
    const before = mapIndexFor(dir)!
    expect(Object.keys(before.notes.files)).toEqual(['src/orders.ts'])
    const changed = indexWith(root, 'src/money.ts', 'h2')
    writeFileSync(join(dir, 'index.json'), JSON.stringify(changed), 'utf8')
    const later = new Date(Date.now() + 5_000)
    utimesSync(join(dir, 'index.json'), later, later)
    expect(Object.keys(mapIndexFor(dir)!.notes.files)).toEqual(['src/money.ts'])
    rmSync(join(dir, 'index.json'))
    expect(mapIndexFor(dir)).toBeNull()
  })
})
