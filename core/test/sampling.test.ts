import { expect, test } from 'vitest'
import { QWEN_SAMPLING, MIN_SAFE_TEMPERATURE, assertSafeSampling } from '../src/llama/sampling.js'

test('the four values Qwen documents are exactly what Qwen documents', () => {
  const { temperature, top_p, top_k, min_p } = QWEN_SAMPLING
  expect({ temperature, top_p, top_k, min_p })
    .toEqual({ temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 })
})

test('and DRY is on top of them, because the request carried nothing against repetition', () => {
  // Qwen's published profile says nothing about repetition control, and llama.cpp defaults
  // both `repeat_penalty` and `dry_multiplier` to off — so every request this client sent
  // had none. A user hit the consequence: thinking that repeated the same few sentences for
  // the whole 8000-token step budget, ending with no content and no tool call.
  //
  // Asserted separately from the block above so the documented four stay pinned to the
  // documentation, and this stays pinned to the reason it was added.
  expect(QWEN_SAMPLING.dry_multiplier).toBe(0.8)
  expect(QWEN_SAMPLING.dry_base).toBe(1.75)
  expect(QWEN_SAMPLING.dry_allowed_length).toBe(4)
  expect(QWEN_SAMPLING.dry_penalty_last_n).toBe(-1)
})

test('the default profile passes the guard', () => {
  expect(() => assertSafeSampling(QWEN_SAMPLING)).not.toThrow()
})

// Measured: at temperature 0.1 the thinking length becomes bimodal and half of hard
// steps spiral past 3200 tokens without ever emitting a tool call. See
// docs/SPIKE-TEMPERATURE.md. This test exists so nobody "optimises" it back.
test('rejects temperatures low enough to trigger the repetition trap', () => {
  expect(() => assertSafeSampling({ ...QWEN_SAMPLING, temperature: 0.1 }))
    .toThrow(/thinking runaway/i)
  expect(() => assertSafeSampling({ ...QWEN_SAMPLING, temperature: 0 }))
    .toThrow(/thinking runaway/i)
})

test('accepts the boundary value', () => {
  expect(() => assertSafeSampling({ ...QWEN_SAMPLING, temperature: MIN_SAFE_TEMPERATURE }))
    .not.toThrow()
})
