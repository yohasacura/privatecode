import { describe, expect, test } from 'vitest'
import { buildCompactionRequest, fitForSummary, selectCompactionTail } from '../src/session/compaction.js'
import type { ChatMessage } from '../src/llama/types.js'
import { LlamaRequestError } from '../src/llama/client.js'
import { contextOverflowTokens } from '../src/session/session.js'

/**
 * The dead end this closes, reported from the running app:
 *
 *   request (133029 tokens) exceeds the available context size (131072 tokens)
 *
 * Every send failed, and the one remedy on offer — compaction — sent the WHOLE transcript to
 * be summarised, so it hit the same wall. The advice was unfollowable and the session was
 * unusable for good. A summary request has to FIT.
 */

/** ~250 tokens each, by the same chars/4 estimate the transcript uses. */
function msg(role: ChatMessage['role'], tag: string): ChatMessage {
  return { role, content: `${tag} ${'x'.repeat(1000)}` } as ChatMessage
}

function tokensOf(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil((m.content?.length ?? 0) / 4), 0)
}

describe('fitting a summary request into the window', () => {
  const transcript: ChatMessage[] = [
    msg('system', 'SYSTEM'),
    msg('user', 'ORIGINAL-ASK'),
    msg('assistant', 'FIRST-ANSWER'),
    msg('user', 'SECOND'),
    ...Array.from({ length: 40 }, (_, i) => msg('assistant', `MIDDLE-${i}`)),
    msg('user', 'LATEST-ASK'),
    msg('assistant', 'WHERE-THINGS-STAND'),
  ]

  test('a transcript that already fits is passed through untouched', () => {
    expect(fitForSummary(transcript, 1_000_000)).toEqual(transcript)
  })

  test('no budget means send everything — the behaviour every caller had before', () => {
    expect(fitForSummary(transcript)).toEqual(transcript)
    expect(fitForSummary(transcript, 0)).toEqual(transcript)
  })

  test('an over-long transcript is cut to the budget', () => {
    const fitted = fitForSummary(transcript, 2_000)
    expect(tokensOf(fitted)).toBeLessThanOrEqual(2_000 + 200) // + the marker's own line
    expect(fitted.length).toBeLessThan(transcript.length)
  })

  test('it keeps the project rules, what was asked, and where things stand', () => {
    const fitted = fitForSummary(transcript, 2_000)
    const text = fitted.map((m) => m.content).join('\n')
    expect(text).toContain('SYSTEM')
    expect(text).toContain('ORIGINAL-ASK')
    // The end matters most: a continuation needs to know where the work actually is.
    expect(text).toContain('WHERE-THINGS-STAND')
    expect(text).toContain('LATEST-ASK')
  })

  test('the middle is dropped, and the summary is TOLD it was dropped', () => {
    // A summary that quietly skipped half a conversation while claiming to cover it would
    // be worse than no summary: every later turn is built on top of it.
    const fitted = fitForSummary(transcript, 2_000)
    const text = fitted.map((m) => m.content).join('\n')
    expect(text).not.toContain('MIDDLE-20')
    expect(text).toMatch(/\d+ messages from the middle of this conversation are not included/)
    expect(text).toContain('say')
  })

  test('the request built from it carries the trimmed messages plus the instruction', () => {
    const request = buildCompactionRequest({
      messages: transcript, workspaceRoot: 'D:/x', budgetTokens: 2_000,
    })
    expect(request.messages.length).toBeLessThan(transcript.length + 1)
    expect(request.messages.at(-1)?.role).toBe('user')
    expect(request.messages.at(-1)?.content).toContain('The conversation above is about to be')
  })

  test('a transcript that is nothing but head and tail still comes back whole', () => {
    const tiny: ChatMessage[] = [msg('system', 'S'), msg('user', 'A'), msg('assistant', 'B')]
    expect(fitForSummary(tiny, 1)).toEqual(tiny)
  })
})

/**
 * What a compaction LEAVES behind.
 *
 * Measured in the app: keeping six messages by count alone left 111.7k of a 131.1k window,
 * because those six carried whole files. A compaction that frees 14% has bought one turn.
 */
describe('the tail a compaction keeps', () => {
  /** Six small messages, then one enormous one — a whole-file tool result. */
  const heavy: ChatMessage[] = [
    msg('system', 'SYS'),
    ...Array.from({ length: 20 }, (_, i) => msg('user', `OLD-${i}`)),
    { role: 'assistant', content: `HUGE ${'y'.repeat(400_000)}` } as ChatMessage,
    msg('user', 'LATEST'),
  ]

  test('by count alone, one giant message drags the whole thing along', () => {
    const { tail } = selectCompactionTail(heavy, 6)
    const kept = tail.reduce((sum, m) => sum + Math.ceil((m.content?.length ?? 0) / 4), 0)
    expect(kept).toBeGreaterThan(90_000)
  })

  test('with a size cap it does not, and the most recent message still survives', () => {
    const { tail } = selectCompactionTail(heavy, 6, 26_000)
    const kept = tail.reduce((sum, m) => sum + Math.ceil((m.content?.length ?? 0) / 4), 0)
    expect(kept).toBeLessThan(26_000)
    // What was last asked is the one thing a continuation cannot do without.
    expect(tail.at(-1)?.content).toContain('LATEST')
  })

  test('no cap is the old behaviour exactly', () => {
    expect(selectCompactionTail(heavy, 6)).toEqual(selectCompactionTail(heavy, 6, 0))
  })

  test('one message bigger than the whole budget is clipped, not carried', () => {
    // Dropping cannot help when a single message IS the problem, and the last one can never
    // be dropped — it carries what was asked. In a coding session that message is routinely
    // a whole file.
    const single: ChatMessage[] = [
      msg('system', 'SYS'),
      { role: 'user', content: `ASK ${'z'.repeat(400_000)}` } as ChatMessage,
    ]
    const { tail } = selectCompactionTail(single, 6, 5_000)
    const kept = tail.reduce((sum, m) => sum + Math.ceil((m.content?.length ?? 0) / 4), 0)
    expect(kept).toBeLessThan(6_000)
    expect(tail.at(-1)?.content).toContain('ASK')
    expect(tail.at(-1)?.content).toContain('was clipped here')
  })
})

/**
 * Reacting to the server instead of predicting it.
 *
 * Every estimate this process can make is a guess: `chars/4` sees neither the ~2,538 tokens
 * of tool schemas nor the chat template, and code tokenizes denser than prose. The pre-turn
 * check passed and llama.cpp still refused. Its refusal carries the real number, and that is
 * the one worth acting on.
 */
describe('recognising the server\'s own overflow refusal', () => {
  /** The exact body llama.cpp returned in the app. */
  const REAL_BODY = JSON.stringify({
    error: {
      code: 400,
      message: 'request (133029 tokens) exceeds the available context size (131072 tokens), try increasing it',
      type: 'exceed_context_size_error',
      n_prompt_tokens: 133029,
      n_ctx: 131072,
    },
  })

  test('reads the prompt size out of it', () => {
    const err = new LlamaRequestError('llama.cpp request failed: HTTP 400', {
      status: 400, body: REAL_BODY, answered: true,
    })
    expect(contextOverflowTokens(err)).toBe(133029)
  })

  test('a different 400 is not treated as an overflow', () => {
    // Compacting someone's conversation because of an unrelated bad request would be a
    // destructive answer to the wrong question.
    const err = new LlamaRequestError('llama.cpp request failed: HTTP 400', {
      status: 400,
      body: JSON.stringify({ error: { code: 400, type: 'invalid_request_error', message: 'bad grammar' } }),
      answered: true,
    })
    expect(contextOverflowTokens(err)).toBeNull()
  })

  test('a transport failure, an unparseable body and a plain Error are all not overflows', () => {
    expect(contextOverflowTokens(new Error('socket hang up'))).toBeNull()
    expect(contextOverflowTokens(new LlamaRequestError('x', { answered: false }))).toBeNull()
    expect(contextOverflowTokens(new LlamaRequestError('x', {
      status: 400, body: '<html>proxy error</html>', answered: true,
    }))).toBeNull()
  })
})
