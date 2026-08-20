import { expect, test } from 'vitest'
import { splitUserMessage } from '../src/host/replay.js'

/**
 * Telling the person's messages apart from the harness's, when both wear the same role.
 *
 * They share `role: 'user'` because the chat template has nowhere else to put a plan-focus
 * note, a mid-turn verify result or a contract preamble — the model has to read those as
 * instructions. On screen they are not the same thing, and a resumed session was showing
 * four "your messages" where two had been sent, which is the exact opposite of what the
 * owner asked for when they said their own messages get lost.
 */

test('a plain message is the person\'s, untouched', () => {
  const r = splitUserMessage('make invoice numbers gap-free')
  expect(r).toEqual({ kind: 'user', text: 'make invoice numbers gap-free' })
})

test('a message that is nothing but a bracketed note belongs to the harness', () => {
  for (const note of [
    '[Plan focus — item 1 of 5: Read the invoice service]',
    '[Checked while you work — npm test: ok, 3.1s]',
    '[The check "dotnet build" took 41s, so it will no longer run after every edit.]',
  ]) {
    const r = splitUserMessage(note)
    expect(r.harness).toBe(true)
    // The text is kept whole: the transcript should still show what the model was shown.
    expect(r.text).toBe(note)
  }
})

test('a note PREFIXED to a real message gives the row back the person\'s own words', () => {
  // How a contract preamble travels: session.ts folds it into one message because two
  // adjacent user messages deviate from the chat template. Left alone, the row rendered as
  // "[TASK CONTRACT — the current task...]" with what the person actually wrote buried
  // under a wall of criteria.
  const r = splitUserMessage('[TASK CONTRACT — Goal: gap-free numbers\n  1. one\n  2. two]\n\nmake invoice numbers gap-free')
  expect(r.harness).toBeUndefined()
  expect(r.text).toBe('make invoice numbers gap-free')
})

test('nested brackets are counted, not matched at the first close', () => {
  // Contract notes contain brackets of their own — file lists like [a.ts, b.ts]. Stopping
  // at the first `]` would cut the note in half and show its tail as the person's message.
  const r = splitUserMessage('[Plan focus — item 2 [src/a.ts, src/b.ts] of 5]\n\nnow do the second one')
  expect(r.text).toBe('now do the second one')
  expect(r.harness).toBeUndefined()
})

test('a message that merely CONTAINS brackets stays the person\'s, whole', () => {
  const text = 'the log line is [ERROR] and it should not be'
  expect(splitUserMessage(text)).toEqual({ kind: 'user', text })
})

test('an unclosed bracket stays the person\'s, whole', () => {
  // Being wrong this way shows a note as a message, which is where we started. Being wrong
  // the other way would hide something a person wrote, and no amount of scrolling gets
  // that back — so the doubt goes to them.
  const text = '[this is how I would start a sentence and never finish the bracket'
  expect(splitUserMessage(text)).toEqual({ kind: 'user', text })
})

test('a bracket that does not open at the very first character is not a note', () => {
  const text = 'quick one [see below]'
  expect(splitUserMessage(text)).toEqual({ kind: 'user', text })
})
