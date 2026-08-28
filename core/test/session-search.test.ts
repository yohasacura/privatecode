import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { searchSessions, searchSessionsDetailed } from '../src/host/session-search.js'
import type { SessionMeta } from '../src/session/store.js'

/**
 * "Where did I do this before."
 *
 * Sessions were found by eye down a list of titles taken from their FIRST message, which is
 * the worst available summary of what a long session turned into.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-search-'))
  mkdirSync(join(root, '.privatecode', 'state', 'sessions'), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function session(id: string, title: string, messages: { role: string; content: string }[], updatedAt = '2026-08-01T10:00:00.000Z'): SessionMeta {
  writeFileSync(
    join(root, '.privatecode', 'state', 'sessions', `${id}.jsonl`),
    messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    'utf8',
  )
  return { id, title, createdAt: updatedAt, updatedAt, workspaceRoot: root, mode: 'normal' }
}

describe('searching conversations', () => {
  test('finds a session by something said inside it, not by its title', () => {
    const metas = [
      session('s1', 'Fix the build', [
        { role: 'user', content: 'why is the build red' },
        { role: 'assistant', content: 'because tsconfig has exactOptionalPropertyTypes on' },
      ]),
      session('s2', 'Something else', [{ role: 'user', content: 'unrelated' }]),
    ]
    const hits = searchSessions(root, metas, 'exactOptional')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.sessionId).toBe('s1')
    expect(hits[0]?.snippet).toContain('exactOptionalPropertyTypes')
  })

  test('is case-insensitive, because nobody remembers the casing', () => {
    const metas = [session('s1', 't', [{ role: 'user', content: 'the Widget factory' }])]
    expect(searchSessions(root, metas, 'widget')).toHaveLength(1)
  })

  test('a session that discussed it at length outranks one that mentioned it once', () => {
    const metas = [
      session('once', 'a', [{ role: 'user', content: 'checkpoints, briefly' }]),
      session('lots', 'b', [
        { role: 'user', content: 'how do checkpoints work' },
        { role: 'assistant', content: 'checkpoints are a shadow git repository' },
        { role: 'user', content: 'and checkpoints on rewind?' },
      ]),
    ]
    expect(searchSessions(root, metas, 'checkpoints')[0]?.sessionId).toBe('lots')
    expect(searchSessions(root, metas, 'checkpoints')[0]?.count).toBe(3)
  })

  test('tool results are not searched, or every session would match every path', () => {
    // Tool output is the bulk of a transcript by an order of magnitude. A search for
    // `stats.ts` matching every directory listing that happened to contain it would return
    // every session ever, ranked by nothing.
    const metas = [session('s1', 't', [
      { role: 'user', content: 'unrelated question' },
      { role: 'tool', content: 'src/stats.ts\nsrc/other.ts' },
    ])]
    expect(searchSessions(root, metas, 'stats.ts')).toEqual([])
  })

  test('a session with no transcript on disk is skipped, not an error', () => {
    const metas: SessionMeta[] = [
      { id: 'ghost', title: 'never saved', createdAt: 'x', updatedAt: 'x', workspaceRoot: root, mode: 'normal' },
    ]
    expect(searchSessions(root, metas, 'anything')).toEqual([])
  })

  test('an empty query matches nothing rather than everything', () => {
    const metas = [session('s1', 't', [{ role: 'user', content: 'hello' }])]
    expect(searchSessions(root, metas, '   ')).toEqual([])
  })

  test('the snippet is one collapsed line, whatever the message looked like', () => {
    const metas = [session('s1', 't', [
      { role: 'assistant', content: `line one\n\n   line two with TARGET in it\n\nline three` },
    ])]
    expect(searchSessions(root, metas, 'TARGET')[0]?.snippet).not.toContain('\n')
  })
})

/**
 * The several ways the same scan gets asked.
 *
 * `search_history` is one tool with one engine underneath and a handful of orthogonal
 * parameters, so what earns a test is that each one narrows the answer in a way the others
 * cannot — and that the palette's own defaults are untouched by any of them.
 */
describe('asking the scan different questions', () => {
  const corpus = (): SessionMeta[] => [
    session('s1', 'Verify timeouts', [
      { role: 'user', content: 'the verify step keeps hitting a timeout on the build' },
      { role: 'assistant', content: 'raised the verify timeout to 240 seconds' },
      { role: 'tool', content: 'exit 1: build timed out after 60s' },
    ], '2026-08-01T10:00:00.000Z'),
    session('s2', 'Later work', [
      { role: 'assistant', content: 'the timeout is configured per workspace' },
    ], '2026-08-20T10:00:00.000Z'),
  ]

  test('speaker separates asking for a thing from explaining it', () => {
    const asked = searchSessions(root, corpus(), 'timeout', 20, { speaker: 'user' })
    expect(asked.map((h) => h.sessionId)).toEqual(['s1'])

    const explained = searchSessions(root, corpus(), 'timeout', 20, { speaker: 'assistant' })
    // Both sessions have an assistant answer mentioning it; s1 mentions it once here too,
    // so what matters is that the USER-only search could not have returned s2 at all.
    expect(explained.map((h) => h.sessionId).sort()).toEqual(['s1', 's2'])
  })

  test('regex reaches a shape a literal cannot', () => {
    const literal = searchSessions(root, corpus(), 'verify.*timeout')
    expect(literal).toEqual([])

    const pattern = searchSessions(root, corpus(), 'verify.*timeout', 20, { regex: true })
    expect(pattern.map((h) => h.sessionId)).toEqual(['s1'])
  })

  test('an unparseable pattern is reported, not silently empty', () => {
    const r = searchSessionsDetailed(root, corpus(), '(unclosed', 20, { regex: true })
    expect(r.hits).toEqual([])
    // Empty results and a broken pattern look identical to the caller otherwise, and the
    // model's next move would be to conclude the thing was never discussed.
    expect(r.problem).toContain('not a valid regular expression')
  })

  test('dates cut the search to when you remember it happening', () => {
    const recent = searchSessions(root, corpus(), 'timeout', 20, { since: '2026-08-10' })
    expect(recent.map((h) => h.sessionId)).toEqual(['s2'])

    const old = searchSessions(root, corpus(), 'timeout', 20, { until: '2026-08-10' })
    expect(old.map((h) => h.sessionId)).toEqual(['s1'])
  })

  test('tool output is excluded by default and reachable on request', () => {
    // "build timed out after 60s" lives only in a tool result.
    expect(searchSessions(root, corpus(), 'timed out')).toEqual([])

    const withOutput = searchSessions(root, corpus(), 'timed out', 20, { includeToolResults: true })
    expect(withOutput.map((h) => h.sessionId)).toEqual(['s1'])
  })

  test('a caller can ask for several passages and a wider window', () => {
    const one = searchSessions(root, corpus(), 'timeout')
    // The palette's default, unchanged: one short snippet per session.
    expect(one[0]?.snippets).toHaveLength(1)

    const many = searchSessions(root, corpus(), 'timeout', 20, { snippets: 3, context: 200 })
    expect((many[0]?.snippets.length ?? 0)).toBeGreaterThan(1)
    // And `snippet` still means what it always meant, so no existing reader changes.
    expect(many[0]?.snippet).toBe(many[0]?.snippets[0])
  })
})
