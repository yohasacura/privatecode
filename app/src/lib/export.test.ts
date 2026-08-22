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

  it('keeps a question with its answer, and does not call a running call finished', () => {
    // Two audit findings with one shape: the export said things that were not true. An
    // answer without its question read as 'answered: Yes' with no referent; a call still
    // running at copy time was labelled 'never finished' — a verdict on something that had
    // not ended.
    const md = conversationAsMarkdown([
      { kind: 'question-record', id: 1, question: 'Deploy to staging first?', answer: 'Yes' },
      { kind: 'tool', id: 2, name: 'run_command', args: '{"command":"npm test"}', startedAtMs: 0 },
    ], 't')
    expect(md).toContain('asked: "Deploy to staging first?" — answered: "Yes"')
    expect(md).toContain('still running when this was copied')
    expect(md).not.toContain('never finished')
  })

  it('an untitled session still opens with a heading', () => {
    expect(conversationAsMarkdown([], '')).toContain('# PrivateCode session')
  })
})

/**
 * The harness talks in the `user` role too, and the export used to give every one of its
 * messages a `## You` heading.
 *
 * `replay.ts` marks them for exactly this — its own comment names this export as what the
 * flag exists to stop — and `transcript.tsx` branches on it, while this file never read it.
 * One message the person sent came out as three headings saying they had asked for things
 * they never asked for.
 */
describe('messages the harness wrote', () => {
  const mixed: ChatItem[] = [
    { kind: 'user', id: 1, text: 'make invoice numbers gap-free' },
    { kind: 'user', id: 2, text: '[Plan focus — step 2 of 5: rename the column]', harness: true },
    { kind: 'user', id: 3, text: 'Automatic verification failed.\nnpm test exited 1', harness: true },
    { kind: 'assistant', id: 4, text: 'done', interrupted: false },
  ]

  it('are not exported as things the person said', () => {
    const md = conversationAsMarkdown(mixed, 'T')
    expect(md.match(/## You/g)).toHaveLength(1)
    expect(md).toContain('make invoice numbers gap-free')
  })

  it('are still exported, because they drove what happened next', () => {
    const md = conversationAsMarkdown(mixed, 'T')
    expect(md).toContain('rename the column')
    expect(md).toContain('npm test exited 1')
  })
})

/**
 * Which folder's check ran. `session.ts` emits it at all four `onVerify` sites and the
 * protocol calls it "the answer to a question a person actually has"; it was dropped at the
 * app boundary, so a multi-folder workspace exported two indistinguishable lines.
 */
describe('the verify record', () => {
  it('names the folder when there is one', () => {
    const md = conversationAsMarkdown([
      { kind: 'verify-record', id: 1, command: 'npm test', ok: true, detail: 'passed', folder: 'api' },
      { kind: 'verify-record', id: 2, command: 'npm test', ok: false, detail: 'exited 1', folder: 'web' },
    ], 'T')
    expect(md).toContain('in api')
    expect(md).toContain('in web')
  })

  it('says nothing extra in a single-folder workspace', () => {
    const md = conversationAsMarkdown([
      { kind: 'verify-record', id: 1, command: 'npm test', ok: true, detail: 'passed' },
    ], 'T')
    expect(md).toContain('- verify `npm test` — passed')
  })
})
