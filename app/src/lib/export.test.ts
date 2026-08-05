import { describe, expect, it } from 'vitest'
import type { ChatItem } from './state'
import { conversationAsMarkdown } from './export'

/**
 * What leaves this app when someone copies the conversation.
 *
 * The rule under test: what a reader ELSEWHERE could use. Not the reasoning (the model
 * talking to itself), not full tool output (sixty thousand characters of file content that
 * means nothing outside this workspace), and nothing invented.
 */

const items: ChatItem[] = [
  { kind: 'user', id: 1, text: 'add a retry to the fetcher' },
  {
    kind: 'thinking', id: 2, step: 1, text: 'I should look at fetcher.ts first',
    done: true, startedAtMs: 0, endedAtMs: null,
  },
  {
    kind: 'tool', id: 3, name: 'read_file', args: '{"path":"src/fetcher.ts"}', startedAtMs: 0,
    result: { ok: true, preview: 'src/fetcher.ts (80 lines)', content: 'x'.repeat(60_000), display: 'big' },
  },
  {
    kind: 'tool', id: 4, name: 'edit_file', args: '{"path":"src/fetcher.ts"}', startedAtMs: 0,
    result: { ok: false, preview: 'no match for the search text', content: 'no match', display: 'no match' },
  },
  { kind: 'assistant', id: 5, text: 'Added a retry with backoff.', interrupted: false },
  { kind: 'verify-record', id: 6, command: 'npm test', ok: true, detail: 'passed' },
]

describe('conversationAsMarkdown', () => {
  it('carries the exchange and what each call did, not what it printed', () => {
    const md = conversationAsMarkdown(items, 'Retry work')
    expect(md).toContain('# Retry work')
    expect(md).toContain('## You\n\nadd a retry to the fetcher')
    expect(md).toContain('## PrivateCode\n\nAdded a retry with backoff.')
    expect(md).toContain('- `read_file` — src/fetcher.ts (80 lines)')
    expect(md).toContain('- `edit_file` — failed: no match for the search text')
    expect(md).toContain('- verify `npm test` — passed')
    // The two exclusions that make the export usable: no sixty-thousand-character tool
    // dump, and no inner monologue.
    expect(md.length).toBeLessThan(2_000)
    expect(md).not.toContain('I should look at fetcher.ts')
  })

  it('an untitled session still opens with a heading', () => {
    expect(conversationAsMarkdown([], '')).toContain('# PrivateCode session')
  })
})
