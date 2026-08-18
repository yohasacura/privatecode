import { describe, expect, test } from 'vitest'
import { harvestReferenceEdges, type NavAsker } from '../src/csharp/reference-edges.js'
import type { FileOutline, RepoIndex } from '../src/outline/repo-map.js'

/**
 * The harvest that turns per-symbol Roslyn answers into the file->file edges the ranker
 * adds to its graph. Everything here runs against a fake helper: what is under test is the
 * aggregation — direction, attribution, ambiguity, failure — not Roslyn itself, which the
 * live probe covers on a real repository.
 */

const ROOT = 'D:/work/proj'

function cs(path: string, types: string[]): FileOutline {
  return {
    path,
    // C# shape: depth 0 is the namespace, the types sit at depth 1.
    entries: [
      { kind: 'namespace', name: 'Proj', depth: 0, line: 1 },
      ...types.map((name, i) => ({ kind: 'class', name, depth: 1, line: 2 + i })),
    ],
    identifiers: new Set(types),
  }
}

function indexOf(...files: FileOutline[]): RepoIndex {
  return { folders: [{ name: null, access: 'write', files }] }
}

/** A helper whose answers are a lookup table: symbol -> reference rows (absolute paths). */
function fakeNav(rows: Record<string, { file: string }[]>, opts: { failLoad?: boolean; throwOn?: string } = {}): NavAsker {
  return {
    ensureLoaded: () => Promise.resolve(opts.failLoad === true ? { ok: false } : { ok: true }),
    ask: (_op, params) => {
      const symbol = String(params['symbol'])
      if (symbol === opts.throwOn) return Promise.reject(new Error('helper died'))
      return Promise.resolve({ ok: true, results: rows[symbol] ?? [] })
    },
  }
}

describe('harvesting reference edges', () => {
  test('a reference row becomes an edge from the referencing file to the defining one', async () => {
    const index = indexOf(cs('src/Service.cs', ['Service']), cs('src/App.cs', ['App']))
    const nav = fakeNav({
      Service: [{ file: `${ROOT}/src/App.cs` }, { file: `${ROOT}/src/App.cs` }],
    })
    const edges = await harvestReferenceEdges(ROOT, index, nav)
    expect(edges?.get('src/App.cs')?.get('src/Service.cs')).toBe(2)
  })

  test('a file referencing its own type is not an edge', async () => {
    const index = indexOf(cs('src/Service.cs', ['Service']))
    const nav = fakeNav({ Service: [{ file: `${ROOT}/src/Service.cs` }] })
    expect(await harvestReferenceEdges(ROOT, index, nav)).toBeNull()
  })

  test('a name two files define is not asked about — a row could not be attributed', async () => {
    const index = indexOf(cs('src/One.cs', ['Twin']), cs('src/Two.cs', ['Twin']), cs('src/App.cs', ['App']))
    const asked: string[] = []
    const nav: NavAsker = {
      ensureLoaded: () => Promise.resolve({ ok: true }),
      ask: (_op, params) => {
        asked.push(String(params['symbol']))
        return Promise.resolve({ ok: true, results: [] })
      },
    }
    await harvestReferenceEdges(ROOT, index, nav)
    expect(asked).not.toContain('Twin')
    expect(asked).toContain('App')
  })

  test('ambiguity sees every declaration — past the asking cap, at any depth, of any kind', async () => {
    // The helper resolves by simple name over ALL source declarations, so anything less
    // than this scan misattributes rows: a 4th type shares `Fourth`, a nested type shares
    // `Nested`, a mere method shares `Method` — none of the three may be asked about.
    const crowded = cs('src/Crowded.cs', ['A1', 'A2', 'A3', 'Fourth'])
    const rival: typeof crowded = {
      path: 'src/Rival.cs',
      entries: [
        { kind: 'namespace', name: 'Proj', depth: 0, line: 1 },
        { kind: 'class', name: 'Fourth', depth: 1, line: 2 },
        { kind: 'class', name: 'Rival', depth: 1, line: 3 },
        { kind: 'class', name: 'Nested', depth: 2, line: 4 },
        { kind: 'method', name: 'Method', depth: 2, line: 5 },
      ],
      identifiers: new Set(['Fourth', 'Rival', 'Nested', 'Method']),
    }
    const others = indexOf(crowded, rival, cs('src/N.cs', ['Nested']), cs('src/M.cs', ['Method']))
    const asked: string[] = []
    const nav: NavAsker = {
      ensureLoaded: () => Promise.resolve({ ok: true }),
      ask: (_op, params) => {
        asked.push(String(params['symbol']))
        return Promise.resolve({ ok: true, results: [] })
      },
    }
    await harvestReferenceEdges(ROOT, others, nav)
    expect(asked).not.toContain('Fourth')
    expect(asked).not.toContain('Nested')
    expect(asked).not.toContain('Method')
    expect(asked).toContain('Rival')
  })

  test('one failing question loses one symbol, not the harvest', async () => {
    const index = indexOf(cs('src/A.cs', ['Alpha']), cs('src/B.cs', ['Beta']), cs('src/C.cs', ['Gamma']))
    const nav = fakeNav(
      { Beta: [{ file: `${ROOT}/src/C.cs` }] },
      { throwOn: 'Alpha' },
    )
    const edges = await harvestReferenceEdges(ROOT, index, nav)
    expect(edges?.get('src/C.cs')?.get('src/B.cs')).toBe(1)
  })

  test('no helper, a failed load, a multi-mount index and a C#-free index all yield null', async () => {
    const csIndex = indexOf(cs('src/Service.cs', ['Service']))
    expect(await harvestReferenceEdges(ROOT, csIndex, null)).toBeNull()
    expect(await harvestReferenceEdges(ROOT, csIndex, fakeNav({}, { failLoad: true }))).toBeNull()

    const multi: RepoIndex = {
      folders: [
        { name: 'a', access: 'write', files: [cs('a/src/S.cs', ['S'])] },
        { name: 'b', access: 'read', files: [] },
      ],
    }
    expect(await harvestReferenceEdges(ROOT, multi, fakeNav({}))).toBeNull()

    const ts = indexOf({
      path: 'src/app.ts',
      entries: [{ kind: 'class', name: 'App', depth: 0, line: 1 }],
      identifiers: new Set(['App']),
    })
    expect(await harvestReferenceEdges(ROOT, ts, fakeNav({}))).toBeNull()
  })

  test('an exhausted deadline keeps what was gathered instead of throwing it away', async () => {
    const index = indexOf(cs('src/A.cs', ['Alpha']), cs('src/B.cs', ['Beta']))
    let answered = 0
    const nav: NavAsker = {
      ensureLoaded: () => Promise.resolve({ ok: true }),
      ask: async () => {
        answered++
        await new Promise((r) => setTimeout(r, 30))
        return { ok: true, results: [{ file: `${ROOT}/src/B.cs` }] }
      },
    }
    const edges = await harvestReferenceEdges(ROOT, index, nav, 10)
    // The first question was in flight when the deadline passed; the second never started.
    expect(answered).toBe(1)
    expect(edges?.get('src/B.cs')?.get('src/A.cs')).toBe(1)
  })
})
