import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('what earlier compactions folded away', () => {
  test('paths carried from before these messages are listed too', () => {
    // The second swap of a session sees a transcript holding the previous BRIEFING — which
    // carries no tool calls — plus a short tail. Simulated against the four real swaps in
    // the recorded corpus, the inventory named 2 paths where the session had touched 38,
    // then 10 against 43, then 22 against 51. The briefing's whole job is to carry "what
    // have I opened" across the gap as data rather than as something the model remembered,
    // and it was losing most of it at the moment it mattered most.
    const out = continuationInventory(
      [call('read_file', { path: 'src/now.ts' })],
      [],
      { seen: ['src/earlier.ts'], changed: ['src/edited-long-ago.ts'] },
    )
    expect(out).toContain('src/now.ts')
    expect(out).toContain('src/earlier.ts')
    expect(out).toContain('src/edited-long-ago.ts')
  })

  test('a path in both halves is listed once', () => {
    const out = continuationInventory(
      [call('read_file', { path: 'src/a.ts' })],
      [],
      { seen: ['src/a.ts'], changed: [] },
    )
    expect(out.match(/src\/a\.ts/g)).toHaveLength(1)
  })

  test('carrying nothing behaves exactly as before', () => {
    // The parameter defaults, so every existing caller and every assertion about the old
    // shape stays meaningful.
    const messages = [call('read_file', { path: 'src/a.ts' }), call('edit_file', { path: 'src/b.ts' })]
    expect(continuationInventory(messages, [], { seen: [], changed: [] }))
      .toBe(continuationInventory(messages))
  })
})

describe('carrying the contents of what was changed', () => {
  test('a changed file arrives with its current text, not just its name', () => {
    // Naming a file the model itself edited and then withholding what it now contains is the
    // one case where the inventory creates the re-read it exists to prevent. Measured on the
    // longest recorded session: 9 of the 10 reads within eight steps of a swap were re-reads
    // of paths already named right there.
    const root = mkdtempSync(join(tmpdir(), 'pc-inv-'))
    try {
      writeFileSync(join(root, 'a.ts'), 'export const answer = 42\n', 'utf8')
      const out = continuationInventory(
        [call('edit_file', { path: 'a.ts' })], [], { seen: [], changed: [] }, root)
      expect(out).toContain('a.ts')
      expect(out).toContain('export const answer = 42')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a file merely READ is named and not carried', () => {
    // It was looked at once and may never be needed again. The budget belongs to the files
    // the model is in the middle of working on.
    const root = mkdtempSync(join(tmpdir(), 'pc-inv-'))
    try {
      writeFileSync(join(root, 'big.ts'), 'export const untouched = 1\n', 'utf8')
      const out = continuationInventory(
        [call('read_file', { path: 'big.ts' })], [], { seen: [], changed: [] }, root)
      expect(out).toContain('big.ts')
      expect(out).not.toContain('export const untouched')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the budget holds, and the newest change wins the space', () => {
    // This is the one part of a briefing that grows with the work done. A swap that carried
    // thirty files would be a swap that freed nothing.
    const root = mkdtempSync(join(tmpdir(), 'pc-inv-'))
    try {
      for (let i = 0; i < 12; i++) {
        writeFileSync(join(root, `f${i}.ts`), `// file ${i}\n${'x'.repeat(3_000)}\n`, 'utf8')
      }
      const messages = Array.from({ length: 12 }, (_, i) => call('edit_file', { path: `f${i}.ts` }))
      const out = continuationInventory(messages, [], { seen: [], changed: [] }, root, 8_000)
      expect(out.length).toBeLessThan(20_000)
      // The last file edited is the one being worked on.
      expect(out).toContain('// file 11')
      expect(out).not.toContain('// file 0\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('no root means names only, and a deleted file is skipped in silence', () => {
    // Every caller without a filesystem — the tests, and anything reasoning about a
    // transcript alone — keeps exactly the old behaviour. And a briefing must never fail
    // because a file was removed since it was edited.
    const namesOnly = continuationInventory([call('edit_file', { path: 'gone.ts' })])
    expect(namesOnly).toContain('gone.ts')
    const root = mkdtempSync(join(tmpdir(), 'pc-inv-'))
    try {
      const out = continuationInventory(
        [call('edit_file', { path: 'gone.ts' })], [], { seen: [], changed: [] }, root)
      expect(out).toContain('gone.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
