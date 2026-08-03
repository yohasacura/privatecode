import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../lib/state'
import { toDiffEntry } from './diffs'

function toolItem(overrides: Partial<Extract<ChatItem, { kind: 'tool' }>>): ChatItem {
  return { kind: 'tool', id: 1, name: 'edit_file', args: '{}', ...overrides }
}

describe('toDiffEntry (tool.result -> diff-entry mapper)', () => {
  it('maps a completed edit_file call to a diff entry with its full content', () => {
    const item = toolItem({
      name: 'edit_file',
      args: JSON.stringify({ path: 'a.ts', search_text: 'x', replace_text: 'y' }),
      result: { ok: true, preview: '--- a.ts', content: '--- a.ts\n+++ a.ts\n@@ line 1 @@\n-x\n+y' },
    })
    expect(toDiffEntry(item)).toEqual({
      id: 1, tool: 'edit_file', path: 'a.ts', ok: true, content: '--- a.ts\n+++ a.ts\n@@ line 1 @@\n-x\n+y',
    })
  })

  it('joins from -> to for a move_file call', () => {
    const item = toolItem({
      name: 'move_file',
      args: JSON.stringify({ from: 'a.ts', to: 'b.ts' }),
      result: { ok: true, preview: 'moved', content: 'moved a.ts to b.ts' },
    })
    expect(toDiffEntry(item)).toEqual({
      id: 1, tool: 'move_file', path: 'a.ts -> b.ts', ok: true, content: 'moved a.ts to b.ts',
    })
  })

  it('maps a FAILED write call too, with ok: false', () => {
    const item = toolItem({
      name: 'write_file',
      args: JSON.stringify({ path: 'a.ts', content: 'x' }),
      result: { ok: false, preview: 'denied', content: 'denied by the user' },
    })
    expect(toDiffEntry(item)).toEqual({
      id: 1, tool: 'write_file', path: 'a.ts', ok: false, content: 'denied by the user',
    })
  })

  it('returns null for a read-only tool (not a write-family name)', () => {
    const item = toolItem({
      name: 'read_file',
      args: JSON.stringify({ path: 'a.ts' }),
      result: { ok: true, preview: 'line one', content: 'line one\nline two' },
    })
    expect(toDiffEntry(item)).toBeNull()
  })

  it('returns null for a write-family call still awaiting its result', () => {
    const item = toolItem({ name: 'edit_file', args: '{}' }) // no `result` field at all
    expect(toDiffEntry(item)).toBeNull()
  })

  it('returns null for a non-tool chat item', () => {
    expect(toDiffEntry({ kind: 'user', id: 1, text: 'hi' })).toBeNull()
  })

  it('returns null when the args cannot name a path', () => {
    const item = toolItem({
      name: 'edit_file', args: 'not json',
      result: { ok: true, preview: 'x', content: 'x' },
    })
    expect(toDiffEntry(item)).toBeNull()
  })
})
