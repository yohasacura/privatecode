import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ChatMessage } from '../src/llama/types.js'
import { recordToolOutcome, replayEntries, toolOutcomes } from '../src/host/replay.js'
import { COMPACTION_ACK_TEXT, COMPACTION_BRIEFING_PREFIX } from '../src/session/compaction.js'

/**
 * Showing a session you resumed.
 *
 * Before this existed, clicking yesterday's work in the rail produced an empty chat with the
 * right title on it: the transcript was on disk the whole time — it is what the model is
 * sent — and there was simply no way to ask for it.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-replay-'))
  mkdirSync(join(root, '.privatecode', 'sessions'), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const user = (text: string): ChatMessage => ({ role: 'user', content: text })
const call = (id: string, name: string, args: string): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
})
const toolResult = (id: string, name: string, content: string): ChatMessage => ({
  role: 'tool', tool_call_id: id, name, content,
})

describe('rebuilding a conversation', () => {
  test('a whole turn comes back in the order it happened', () => {
    const entries = replayEntries([
      { role: 'system', content: 'you are an agent' },
      user('add a docstring'),
      { role: 'assistant', content: null, reasoning_content: 'I should read it first.\n', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      toolResult('c1', 'read_file', 'a.ts (2 lines)'),
      { role: 'assistant', content: 'Done.' },
    ])

    expect(entries).toEqual([
      { kind: 'user', text: 'add a docstring' },
      { kind: 'reasoning', step: 1, text: 'I should read it first.\n' },
      { kind: 'tool-call', name: 'read_file', args: '{"path":"a.ts"}' },
      { kind: 'tool-result', name: 'read_file', ok: true, content: 'a.ts (2 lines)' },
      { kind: 'assistant', text: 'Done.' },
    ])
  })

  test('the system prompt is not part of the conversation', () => {
    // It is the instrument the conversation is played on. Showing it would push every real
    // message a screenful down, on every session you open.
    const entries = replayEntries([{ role: 'system', content: 'a very long prompt' }])
    expect(entries).toEqual([])
  })

  test('a nudge the unattended runner sent is shown, because it was really sent', () => {
    // Hiding it would make a morning review lie about what drove the run.
    const entries = replayEntries([user('keep going: two todos are still open')])
    expect(entries).toEqual([{ kind: 'user', text: 'keep going: two todos are still open' }])
  })

  test('steps are numbered so consecutive reasoning blocks stay separate', () => {
    const entries = replayEntries([
      { role: 'assistant', content: null, reasoning_content: 'first' },
      { role: 'assistant', content: null, reasoning_content: 'second' },
    ])
    expect(entries).toEqual([
      { kind: 'reasoning', step: 1, text: 'first' },
      { kind: 'reasoning', step: 2, text: 'second' },
    ])
  })

  test('an empty reasoning block is not a block', () => {
    // The server sends `reasoning_content: ''` for a step that did not think. An empty
    // "Thought" card would be a row that says nothing.
    const entries = replayEntries([{ role: 'assistant', content: 'hi', reasoning_content: '  ' }])
    expect(entries).toEqual([{ kind: 'assistant', text: 'hi' }])
  })

  test('a tool result with no name of its own is identified by its call', () => {
    const entries = replayEntries([
      call('c9', 'run_command', '{"command":"ls"}'),
      { role: 'tool', tool_call_id: 'c9', content: 'a.ts' },
    ])
    expect(entries[1]).toEqual({ kind: 'tool-result', name: 'run_command', ok: true, content: 'a.ts' })
  })
})

describe('whether each call worked', () => {
  test('is read back from the file the host writes as it happens', () => {
    recordToolOutcome(root, 's1', 'c1', true)
    recordToolOutcome(root, 's1', 'c2', false)

    const entries = replayEntries(
      [
        call('c1', 'read_file', '{}'), toolResult('c1', 'read_file', 'ok'),
        call('c2', 'run_command', '{}'), toolResult('c2', 'run_command', 'exit 1'),
      ],
      toolOutcomes(root, 's1'),
    )

    expect(entries.filter((e) => e.kind === 'tool-result')).toEqual([
      { kind: 'tool-result', name: 'read_file', ok: true, content: 'ok' },
      { kind: 'tool-result', name: 'run_command', ok: false, content: 'exit 1' },
    ])
  })

  test('is unknown for a session recorded before the file existed, and reads as success', () => {
    // The honest default of the two available. A run this predates has calls that mostly
    // succeeded; painting them all red would invent failures, which is worse than failing
    // to mark the real ones.
    const entries = replayEntries([toolResult('c1', 'run_command', 'exit 1')])
    expect(entries[0]).toMatchObject({ ok: true })
  })

  test('a blocked call is known to have failed even with nothing recorded', () => {
    // Not a guess: the loop writes exactly this prefix for every call the permission gate
    // refused, deferred or cancelled, always with ok:false, and the work log already relies
    // on the same contract. It is also the most common failure in an overnight run.
    const entries = replayEntries([
      toolResult('c1', 'run_command', 'Not run: nobody is available to approve this…'),
      toolResult('c2', 'edit_file', 'Not run: one tool call per step'),
    ])
    expect(entries).toMatchObject([{ ok: false }, { ok: false }])
  })

  test('a recorded outcome beats the guess', () => {
    // A tool that legitimately produced text starting with those words must not be
    // second-guessed once the truth is on disk.
    recordToolOutcome(root, 's4', 'c1', true)
    const entries = replayEntries(
      [toolResult('c1', 'read_file', 'Not run: is what the file says on line 1')],
      toolOutcomes(root, 's4'),
    )
    expect(entries[0]).toMatchObject({ ok: true })
  })

  test('a corrupt line loses one tick mark, not the file', () => {
    const path = join(root, '.privatecode', 'sessions', 's2.ui.jsonl')
    writeFileSync(path, `{"id":"c1","ok":false}\n{not json\n{"id":"c2","ok":false}\n`, 'utf8')
    const outcomes = toolOutcomes(root, 's2')
    expect(outcomes.get('c1')).toBe(false)
    expect(outcomes.get('c2')).toBe(false)
  })

  test('an unwritable workspace is a cosmetic loss, never a thrown turn', () => {
    // Recording runs inside the agent loop. A session whose ok-flags cannot be written is a
    // session whose restored tool cards look neutral; refusing to run the turn over that
    // would not be a trade worth making.
    const file = join(root, 'not-a-dir')
    writeFileSync(file, 'x', 'utf8')
    expect(() => recordToolOutcome(file, 's3', 'c1', true)).not.toThrow()
    expect(toolOutcomes(file, 's3').size).toBe(0)
  })
})

/**
 * A compaction is the most consequential thing that happens to a session, and it used to
 * come back from disk as a forgery: the briefing is carried in a `user` message so the model
 * reads it as instruction, so a literal replay attributed five thousand characters of
 * "Session briefing from the earlier part of this conversation" to the person, who had
 * written none of it — and said nothing anywhere about a compaction having happened.
 */
describe('a compaction in a restored conversation', () => {
  const briefing = (body: string): ChatMessage =>
    ({ role: 'user', content: `${COMPACTION_BRIEFING_PREFIX}\n${body}` })
  const ack = (): ChatMessage => ({ role: 'assistant', content: COMPACTION_ACK_TEXT })

  test('the briefing is a compaction, not something the user said', () => {
    const entries = replayEntries([
      { role: 'system', content: 'you are an agent' },
      briefing('# Continuation Briefing\n1. Task state: half done.'),
      ack(),
      user('carry on'),
    ], new Map(), { droppedMessages: 214 })

    expect(entries).toEqual([
      {
        kind: 'compaction',
        summary: '# Continuation Briefing\n1. Task state: half done.',
        droppedMessages: 214,
      },
      { kind: 'user', text: 'carry on' },
    ])
  })

  test('the synthetic acknowledgement is not shown as something the model said', () => {
    // It is the other half of one synthetic round-trip; the model never generated a word of
    // it. Rendered, it reads as the assistant answering a message the user never sent.
    const entries = replayEntries([briefing('x'), ack()])
    expect(entries.filter((e) => e.kind === 'assistant')).toEqual([])
  })

  test('without the marker the briefing still shows, just without a count', () => {
    // The count lives only in the on-disk marker. The briefing IS the message, so a
    // transcript replayed with no marker (an older file, or `sessions.read` on one) loses
    // the number and nothing else.
    const entries = replayEntries([briefing('x')])
    expect(entries[0]).toEqual({ kind: 'compaction', summary: 'x' })
  })

  test('the count is claimed by one briefing only', () => {
    // The marker describes exactly ONE swap — the one the live messages open on. A
    // transcript carrying two briefings must not report the same count for both, which
    // would be inventing a number for the other.
    const entries = replayEntries(
      [briefing('first'), ack(), briefing('second'), ack()],
      new Map(),
      { droppedMessages: 9 },
    )
    expect(entries).toEqual([
      { kind: 'compaction', summary: 'first', droppedMessages: 9 },
      { kind: 'compaction', summary: 'second' },
    ])
  })

  test('a user message that merely mentions compaction is still the user talking', () => {
    const entries = replayEntries([user('why did the session briefing vanish?')])
    expect(entries[0]).toEqual({ kind: 'user', text: 'why did the session briefing vanish?' })
  })
})
