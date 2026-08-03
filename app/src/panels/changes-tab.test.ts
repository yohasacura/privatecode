import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../lib/state'
import { collectChanges } from './changes-tab'

function tool(id: number, name: string, args: string, content = 'diff body', ok = true): ChatItem {
  return { kind: 'tool', id, name, args, result: { ok, preview: 'p', content } }
}

describe('collectChanges', () => {
  it('keeps only completed write-family calls', () => {
    const items: ChatItem[] = [
      tool(1, 'read_file', '{"path":"a.ts"}'),
      { kind: 'tool', id: 2, name: 'edit_file', args: '{"path":"b.ts"}' }, // still running
      tool(3, 'edit_file', '{"path":"c.ts"}'),
      { kind: 'user', id: 4, text: 'hi' },
    ]
    expect(collectChanges(items).map((c) => c.path)).toEqual(['c.ts'])
  })

  it('collapses repeated writes to one entry, counting the revisions', () => {
    const items: ChatItem[] = [
      tool(1, 'edit_file', '{"path":"a.ts"}', 'first'),
      tool(2, 'edit_file', '{"path":"a.ts"}', 'second'),
      tool(3, 'edit_file', '{"path":"a.ts"}', 'third'),
    ]
    const changes = collectChanges(items)
    expect(changes).toHaveLength(1)
    // The newest write is the one worth showing; the count says the rest happened.
    expect(changes[0]?.revisions).toBe(3)
    expect(changes[0]?.content).toBe('third')
  })

  it('orders newest first and keeps move_file\'s two-sided target', () => {
    const items: ChatItem[] = [
      tool(1, 'write_file', '{"path":"old.ts"}'),
      tool(2, 'move_file', '{"from":"old.ts","to":"new.ts"}'),
    ]
    const changes = collectChanges(items)
    expect(changes.map((c) => c.path)).toEqual(['old.ts → new.ts', 'old.ts'])
  })

  it('keeps a failed write, flagged, rather than hiding it', () => {
    const changes = collectChanges([tool(1, 'edit_file', '{"path":"a.ts"}', 'no match', false)])
    expect(changes).toHaveLength(1)
    expect(changes[0]?.ok).toBe(false)
  })
})
