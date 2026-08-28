import { expect, test } from 'vitest'
import {
  CONTINUE_NUDGE, MAX_STEPS_PREFIX, STEP_TIMEOUT_PREFIX, TALKED_INSTEAD_OF_ACTING,
  TRUNCATED_TWICE,
} from '../src/agent/loop.js'
import { splitUserMessage } from '../src/host/replay.js'
import { REVERT_FILE_PREFIX, ROLLBACK_PREFIX } from '../src/session/checkpoint-notices.js'

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

/**
 * The shapes a person actually types that OPEN with a bracket.
 *
 * The test was "starts with `[`, find the matching `]`, keep the rest" — with no positive
 * test for a harness note, no length bound and no separator requirement. So the first
 * bracketed token of a log line, an attribute or a header was deleted from the row, from
 * its title and from the markdown export, on every resume. Live rendering was fine, which
 * is why it stayed hidden: it only appeared in a session you came back to.
 */
test('a log line keeps its timestamp', () => {
  const line = '[2026-08-21 10:33:02] ERROR NullReferenceException in InvoiceService.allocate'
  expect(splitUserMessage(line)).toEqual({ kind: 'user', text: line })
})

test('an attribute keeps its brackets', () => {
  const msg = '[HttpGet] is missing on the controller, that is why the route 404s'
  expect(splitUserMessage(msg)).toEqual({ kind: 'user', text: msg })
})

test('a lone bracketed token is the person, not the harness', () => {
  // Every note the harness writes is a sentence; a bare token is what a person types.
  expect(splitUserMessage('[Fact]')).toEqual({ kind: 'user', text: '[Fact]' })
  expect(splitUserMessage('[TODO]')).toEqual({ kind: 'user', text: '[TODO]' })
})

test('and the contract preamble is still split off, because it brings a blank line', () => {
  const msg = '[Task contract\nGoal: make writes atomic\nDone when: 1. the suite passes]\n\nplease do this'
  expect(splitUserMessage(msg)).toEqual({ kind: 'user', text: 'please do this' })
})

test('a whole-message harness note is still marked as one', () => {
  const note = '[Context is about 80% full. When it fills, the earlier part will be summarised.]'
  // And it is a NOTE, which the diagnosis counts apart from a hand-back: a note is a line,
  // an unmet contract is a turn of work, and one number for both said the checking was
  // expensive in sessions where it was not.
  expect(splitUserMessage(note))
    .toEqual({ kind: 'user', text: note, harness: true, harnessKind: 'note' })
})

/**
 * The harness messages that do NOT open with a bracket.
 *
 * The bracket convention covers the notes and never covered the FIXER messages, which are
 * the harness talking just as much. On resume all five rendered in the caret row as things
 * the PERSON said, `conversationAsMarkdown` exported them under "## You", and session search
 * returned them as what a person had asked for.
 */
test('the fixer messages are the harness, not the person', async () => {
  const { acceptanceFailureMessage, reviewFailureMessage } =
    await import('../src/session/contract.js')
  const { premiseFailureMessage } = await import('../src/session/premises.js')
  const { verifyFailureMessage } = await import('../src/verify/runner.js')
  const { OVERFLOW_RETRY_NOTE } = await import('../src/session/compaction.js')

  const messages = [
    acceptanceFailureMessage({ met: 1, unmet: [{ criterion: 'the suite passes', why: 'not run' }] }),
    reviewFailureMessage([{ where: 'src/a.ts f()', what: 'the lock is not held' }]),
    premiseFailureMessage({
      verified: [],
      unverified: [{
        premise: { file: 'src/a.ts', quote: 'x', why: 'y' },
        problem: 'those lines are not in that file',
      }],
    }),
    verifyFailureMessage({ command: 'npm test' } as never,
      { exitCode: 1, output: 'FAIL', problem: undefined } as never),
    verifyFailureMessage({ command: 'npm test' } as never,
      { exitCode: null, output: '', problem: 'command not found' } as never),
    OVERFLOW_RETRY_NOTE,
  ]

  // Each is named, not merely flagged. `harness: true` says a turn was not the person's,
  // which is enough to dim a row and nowhere near enough to tune anything — the diagnosis
  // has to tell a red build from an unmet contract from a context overflow, and this is
  // where that name is decided.
  const kinds = ['acceptance', 'review', 'premises', 'verify', 'verify-broken',
    'overflow-retry']
  messages.forEach((m, i) => {
    expect(splitUserMessage(m), m.slice(0, 48))
      .toEqual({ kind: 'user', text: m, harness: true, harnessKind: kinds[i] })
  })
})

test('and something a person types that merely mentions one of them is still theirs', () => {
  const typed = 'Automatic verification failed on my machine too — any idea why?'
  // Starts with the opener's words but is not the message; the constant is matched whole.
  expect(splitUserMessage('why does it say Automatic verification failed?'))
    .toEqual({ kind: 'user', text: 'why does it say Automatic verification failed?' })
  void typed
})

/**
 * The agent loop's own messages, which wore the person's caret for as long as they existed.
 *
 * The bracket convention covers the notes and `HARNESS_OPENERS` covers the fixers; neither
 * covered these six, because they are plain prose written from inside `loop.ts` and
 * `session.ts` rather than from a gate. Driving four of them through the real replay produced
 * four `## You` headings for sentences nobody typed. They are imported as constants rather
 * than pasted, so a rewording cannot quietly drop one out of the list.
 */
test('every message the agent loop writes belongs to the harness', () => {
  const written: [string, string][] = [
    ['continue nudge', CONTINUE_NUDGE],
    ['truncated twice', TRUNCATED_TWICE],
    ['talked instead of acting', TALKED_INSTEAD_OF_ACTING],
    ['step timeout', `${STEP_TIMEOUT_PREFIX}240 s time limit before you replied, so it was abandoned.`],
    ['max steps', `${MAX_STEPS_PREFIX}40 steps without finishing. Say what you did.`],
    ['file reverted', `${REVERT_FILE_PREFIX}src/a.ts to how it was before this session started.`],
    ['workspace rolled back', `${ROLLBACK_PREFIX}cp-3 by the user. Re-read any file before editing.`],
  ]
  for (const [what, text] of written) {
    expect(splitUserMessage(text), what).toMatchObject({ harness: true })
  }
})

/**
 * The folder prefix a multi-folder workspace puts in front of a verify failure.
 *
 * `HARNESS_OPENERS` matches with `startsWith`, so `In the "api" folder: ` in front of the
 * build log defeated it and the whole log replayed as the person's message. Single-folder
 * workspaces were fine, which is why it survived: there the prefix is the empty string.
 */
test('a folder prefix does not turn a build log into something the person typed', () => {
  const single = splitUserMessage('Automatic verification failed. `npm test` exited 1.')
  const multi = splitUserMessage('In the "api" folder: Automatic verification failed. `npm test` exited 1.')
  expect(single).toMatchObject({ harness: true })
  expect(multi).toMatchObject({ harness: true })
})

/**
 * The verify ESCALATION, whose note is bracketed and whose body is a build log — both halves
 * the harness's. The note used to be followed by ONE newline where the bracket rule needs a
 * blank line, and even with the blank line the remainder had to be re-tested: it is not the
 * person's message, which is what that shape usually carries.
 */
test('the verify escalation is the harness on both sides of its bracket', () => {
  const escalation =
    'In the "api" folder: [2 repair attempts left the check failing. STOP repairing the ' +
    'previous attempt.]\n\nAutomatic verification failed. `npm test` exited 1.'
  const r = splitUserMessage(escalation)
  expect(r.harness).toBe(true)
  // The bracketed instruction is stripped for display; what is shown is the failure itself.
  expect(r.text).toBe('Automatic verification failed. `npm test` exited 1.')
})

/**
 * A contract preamble in front of a REAL message still yields the person's words, which is
 * what that shape exists for. Guards the test above from over-reaching.
 */
test('a note in front of the person\'s own message still leaves the message theirs', () => {
  const r = splitUserMessage('[Task: gap-free invoice numbers. Done when: 1) no gaps]\n\nplease also add a test')
  expect(r).toEqual({ kind: 'user', text: 'please also add a test' })
})

/**
 * An attachment blob is the person's message with file bodies wrapped around it, because the
 * model has to see them. The ROW is not: it showed the whole blob, and the session titled
 * itself "The user attached these files: --- a.ts --- 1 export functio".
 */
test('an attachment blob shows the person\'s words, not the files', () => {
  const blob =
    'The user attached these files:\n\n' +
    '--- src/a.ts ---\n1\texport function a() { return 1 }\n\n' +
    '--- src/b.ts ---\n1\texport const b = 2\n\n' +
    'fix the off-by-one in a()'
  const r = splitUserMessage(blob)
  expect(r).toEqual({ kind: 'user', text: 'fix the off-by-one in a()' })
})
