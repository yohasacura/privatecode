import { describe, expect, test } from 'vitest'
import { continuationInventory } from '../src/session/compaction.js'
import type { ChatMessage } from '../src/llama/types.js'

/**
 * The half of a continuation briefing that is not written by the model.
 *
 * Everything in a generated summary is a fact the model RECALLED. That is the right way to
 * carry judgment ("we agreed not to touch the parser") and the wrong way to carry
 * bookkeeping: which files it opened, and what is still on the list. Both are exactly
 * knowable — one from the transcript, one from the todo store — so neither is left to
 * memory. Reported by the user as the model "getting lost after a compaction and re-reading
 * ten to twenty files".
 */

const call = (name: string, args: Record<string, unknown>): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: `c-${name}-${JSON.stringify(args)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})

describe('continuationInventory', () => {
  test('lists what was opened and what was changed, each once', () => {
    const out = continuationInventory([
      call('read_file', { path: 'src/a.ts' }),
      call('read_file', { path: 'src/a.ts' }),
      call('symbol_outline', { path: 'src/b.ts' }),
      call('edit_file', { path: 'src/c.ts' }),
    ])
    expect(out).toContain('src/a.ts')
    expect(out).toContain('src/b.ts')
    expect(out).toContain('src/c.ts')
    expect(out.match(/src\/a\.ts/g)).toHaveLength(1)
  })

  test('a changed file is not also listed as merely opened', () => {
    const out = continuationInventory([
      call('read_file', { path: 'src/c.ts' }),
      call('edit_file', { path: 'src/c.ts' }),
    ])
    expect(out).toContain('Files you changed')
    expect(out.match(/src\/c\.ts/g)).toHaveLength(1)
  })

  test('it does NOT tell the model to avoid re-reading, because the contents really are gone', () => {
    // The trap this test exists to hold shut. After a swap the file contents are no longer in
    // context, so "do not re-read" would have the model working from knowledge it does not
    // have. What it gets is the list plus a cheaper way to re-acquire.
    const out = continuationInventory([call('read_file', { path: 'src/a.ts' })])
    expect(out).not.toMatch(/do not re-?read/i)
    expect(out).toContain('NOT in context')
    expect(out).toContain('search_code')
  })

  test('open todos come from the store, and completed ones are left out', () => {
    const out = continuationInventory([], [
      { text: 'wire the parser', status: 'completed' },
      { text: 'add the migration', status: 'in_progress' },
      { text: 'write the docs', status: 'pending' },
    ])
    expect(out).not.toContain('wire the parser')
    expect(out).toContain('add the migration')
    expect(out).toContain('write the docs')
  })

  test('a session with nothing to report adds nothing to the briefing', () => {
    expect(continuationInventory([], [])).toBe('')
    expect(continuationInventory([call('run_command', { command: 'ls' })], [])).toBe('')
  })

  test('the list is bounded, and says how much it left out', () => {
    const many = Array.from({ length: 60 }, (_, i) => call('read_file', { path: `src/f${i}.ts` }))
    const out = continuationInventory(many)
    expect(out).toContain('and 20 more')
    expect(out).not.toContain('src/f59.ts')
  })

  test('a malformed tool argument is skipped rather than crashing a swap', () => {
    const broken: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_file', arguments: '{not json' } }],
    }
    expect(() => continuationInventory([broken])).not.toThrow()
    expect(continuationInventory([broken])).toBe('')
  })
})
