import { describe, expect, test } from 'vitest'
import { buildCompactionRequest, fitForSummary } from '../src/session/compaction.js'
import type { ChatMessage } from '../src/llama/types.js'

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
