import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../lib/state'
import { collectChanges } from './changes-tab'

function tool(id: number, name: string, args: string, content = 'diff body', ok = true): ChatItem {
  return { kind: 'tool', id, name, args, startedAtMs: id, result: { ok, preview: 'p', content, display: content } }
}

describe('collectChanges', () => {
  it('keeps only completed write-family calls', () => {
    const items: ChatItem[] = [
      tool(1, 'read_file', '{"path":"a.ts"}'),
      { kind: 'tool', id: 2, name: 'edit_file', args: '{"path":"b.ts"}', startedAtMs: 2 }, // still running
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

describe('the cost of collecting them', () => {
  it('parses each write once, however many times the list is rebuilt', () => {
    // `collectChanges` runs on every appended item and every tool resolution — roughly three
    // times per write step — and re-parsed every earlier write on each. A write's arguments
    // carry the entire new file, so that is O(N²) parses of file-sized documents on the UI
    // thread, whichever tab happens to be open.
    // File-sized arguments, because that is what a write call actually carries and the whole
    // cost being removed is parsing them. At 2 KB the difference was 1.2x — real, and far too
    // thin to assert without flaking on a busy machine.
    const items: ChatItem[] = []
    for (let i = 1; i <= 60; i++) {
      items.push({
        kind: 'tool', id: i, name: 'write_file',
        args: JSON.stringify({ path: `f${i}.ts`, content: 'x'.repeat(120_000) }),
        startedAtMs: i,
        result: { ok: true, preview: 'p', content: 'wrote', display: 'wrote' },
      })
    }

    // Rebuilding the list many times must not cost more parsing than building it once: the
    // second pass and every one after it are served from the cache. Measured by time because
    // the parse is the only thing in this loop that costs anything.
    const first = performance.now()
    collectChanges(items)
    const firstMs = performance.now() - first

    const repeat = performance.now()
    for (let i = 0; i < 20; i++) collectChanges(items)
    const repeatMs = (performance.now() - repeat) / 20

    // A ratio, not a benchmark. Uncached, every repeat costs what the first did; cached, it
    // is the loop alone. A tenth is far inside the real gap and far outside the noise.
    expect(repeatMs).toBeLessThan(firstMs / 10)
  })

  it('never serves one item\'s parse for another', () => {
    // The cache is keyed on the item OBJECT, not its id: ids are unique across the live
    // transcript but a VIEWED session numbers its own from 1, and that overlap has already
    // caused one defect today. Two items sharing an id must still parse as themselves.
    const a: ChatItem = {
      kind: 'tool', id: 7, name: 'write_file', startedAtMs: 1,
      args: JSON.stringify({ path: 'first.ts', content: 'a' }),
      result: { ok: true, preview: 'p', content: 'wrote', display: 'wrote' },
    }
    const b: ChatItem = {
      kind: 'tool', id: 7, name: 'write_file', startedAtMs: 2,
      args: JSON.stringify({ path: 'second.ts', content: 'b' }),
      result: { ok: true, preview: 'p', content: 'wrote', display: 'wrote' },
    }
    expect(collectChanges([a]).map((c) => c.path)).toEqual(['first.ts'])
    expect(collectChanges([b]).map((c) => c.path)).toEqual(['second.ts'])
  })
})
