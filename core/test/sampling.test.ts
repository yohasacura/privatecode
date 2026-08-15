import { expect, test } from 'vitest'
import { QWEN_SAMPLING, MIN_SAFE_TEMPERATURE, assertSafeSampling } from '../src/llama/sampling.js'

test('the four values Qwen documents are exactly what Qwen documents', () => {
  const { temperature, top_p, top_k, min_p } = QWEN_SAMPLING
  expect({ temperature, top_p, top_k, min_p })
    .toEqual({ temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 })
})

test('DRY stays off — it was tried for a day and measured out again', () => {
  // The reasoning for adding it was sound and the measurement refuted it. Against this model:
  // five file paths listed three times survived 15 of 15 with DRY off, and 0 of 15 at
  // multiplier 0.8 with the whole-context window — `.cs` became `.css`, `ProcessCleaner`
  // became `ProcessCleanser`, `Services` became `Servic`. And against a real loop ("write
  // this sentence forty times") every setting tried, up to multiplier 1.5, produced the
  // sentence 37 times verbatim with byte-identical output.
  //
  // So it bites where the model has a plausible alternative — an identifier it can spell
  // slightly differently — and loses to the instruction where it does not. The exact inverse
  // of what a coding agent needs. The spiral is handled in `appendTruncated` instead.
  expect(Object.keys(QWEN_SAMPLING).sort()).toEqual(['min_p', 'temperature', 'top_k', 'top_p'])
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
