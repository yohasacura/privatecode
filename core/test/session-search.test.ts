import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { searchSessions } from '../src/host/session-search.js'
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
