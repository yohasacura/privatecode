import { expect, test } from 'vitest'
import { QWEN_SAMPLING, MIN_SAFE_TEMPERATURE, assertSafeSampling } from '../src/llama/sampling.js'

test('the default profile is exactly what Qwen recommends', () => {
  expect(QWEN_SAMPLING).toEqual({ temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 })
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
