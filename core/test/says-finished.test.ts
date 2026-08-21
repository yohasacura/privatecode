import { expect, test } from 'vitest'
import { saysFinished } from '../src/session/contract.js'

/**
 * The one boolean that decides whether a finished task gets checked at all.
 *
 * Both end-of-turn gates hang off it: the acceptance audit runs when the model claims to be
 * done, and the fresh-context diff review runs inside that. So a phrasing this misses is not
 * a cosmetic miss — it is a turn that finished, well or badly, with nothing looking at it.
 *
 * Caught live: a run ended "All 7 steps complete. Here's the summary:" and neither gate
 * fired. The plan-shaped endings below are the common ones now that the model actually keeps
 * a plan and works through it.
 */

test('the phrasings a real run produced', () => {
  expect(saysFinished("All 7 steps complete. Here's the summary:")).toBe(true)
  expect(saysFinished('All steps are done.')).toBe(true)
  expect(saysFinished('All 3 steps completed — the suite is green.')).toBe(true)
})

test('the noun-phrase endings of the same habit', () => {
  expect(saysFinished('The fix is complete.')).toBe(true)
  expect(saysFinished('Implementation is now finished.')).toBe(true)
  expect(saysFinished('The changes are complete and the tests pass.')).toBe(true)
})

test('the phrasings that already worked, unchanged', () => {
  expect(saysFinished('All done.')).toBe(true)
  expect(saysFinished('Everything is now complete.')).toBe(true)
  expect(saysFinished('Nothing more to do.')).toBe(true)
  expect(saysFinished('Всё готово.')).toBe(true)
})

test('a hedge in the same sentence is still not a finish', () => {
  // The veto is what keeps this from ending a run mid-work, and it is sentence-local so an
  // honest caveat elsewhere in a long report does not silence a real claim.
  expect(saysFinished('All 7 steps complete, but the suite is still failing.')).toBe(false)
  expect(saysFinished('The fix is not complete yet.')).toBe(false)
  expect(saysFinished('Almost all steps are done.')).toBe(false)
})

test('a question is not a claim', () => {
  expect(saysFinished('All steps complete?')).toBe(false)
})

test('ordinary progress reporting is not a finish claim', () => {
  expect(saysFinished('I have finished reading src/invoice.ts and will now write the fix.')).toBe(false)
  expect(saysFinished('Step 2 of 7 is done; moving on to the transaction.')).toBe(false)
})

test('the phrasings that still slip past, which is why the plan is the other signal', () => {
  // Both from real runs that finished the work properly. Neither is a claim of completion —
  // they are summary preambles — and no regex over free prose is going to reliably tell the
  // difference. `acceptanceGate` therefore also opens on a plan whose every step is done,
  // which is the same statement made mechanically.
  expect(saysFinished("Here's a summary of everything that was done:")).toBe(false)
  expect(saysFinished('## Root Cause\n\nThe original allocate() had a race.')).toBe(false)
})
