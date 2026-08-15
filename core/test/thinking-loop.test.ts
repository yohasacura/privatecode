import { describe, expect, test } from 'vitest'
import { looksRepetitive } from '../src/agent/loop.js'
import { QWEN_SAMPLING } from '../src/llama/sampling.js'

/**
 * The thinking spiral, and why the transcript was what carried it.
 *
 * Reported from a real session: the reasoning looped — the same few sentences in batches —
 * for six to eight thousand tokens, which is the whole per-step budget, so the step emitted
 * no content and no tool call. Compaction did not help and stopping did not help; only a new
 * session did. That last part is the clue: `appendTruncated` carried the abandoned thinking
 * back into the transcript so it would not have to be re-derived — correct when the thinking
 * got somewhere, and when it is a loop it writes eight thousand tokens of the model's own
 * repetition into the context, where every later step reads it.
 */

const looping = (times: number): string =>
  Array.from({ length: times }, () =>
    'I need to check whether the service is registered in the container before I change it. ' +
    'Let me look at how the registration happens first.').join(' ')

/**
 * Long thinking that genuinely goes somewhere. Built as distinct sentences rather than one
 * paragraph repeated, because the first draft of this fixture used `.repeat(4)` — which IS
 * repetition, and the detector was right to say so.
 */
const productive = Array.from({ length: 30 }, (_, i) =>
  `Step ${i}: the ${['registration', 'interface', 'fake', 'call site', 'constructor'][i % 5]} ` +
  `in file${i}.cs depends on what the ${['container', 'test', 'view model', 'planner'][i % 4]} ` +
  `expects, so changing it means checking ${i + 2} other places before the build will pass.`,
).join(' ')

describe('recognising a spiral', () => {
  test('the same sentences over and over is a loop', () => {
    expect(looksRepetitive(looping(40))).toBe(true)
  })

  test('long, varied reasoning is not', () => {
    // The false positive that would cost the model real context. This text is longer than
    // the threshold and repeats its overall SHAPE, which is what ordinary planning does.
    expect(looksRepetitive(productive)).toBe(false)
  })

  test('short thinking is never a runaway, whatever its shape', () => {
    expect(looksRepetitive(looping(3))).toBe(false)
  })

  test('empty and trivial input is not a loop', () => {
    expect(looksRepetitive('')).toBe(false)
    expect(looksRepetitive('Let me look at the file.')).toBe(false)
  })
})
