import type { Sampling } from './types.js'

/**
 * Qwen3.6's documented sampling profile. Do not deviate.
 *
 * Measured on this exact model and server (docs/SPIKE-TEMPERATURE.md): holding task,
 * prompt, tool_choice and max_tokens fixed and varying only temperature,
 *
 *   temp 0.1 -> 3 of 6 runs usable, thinking 1149..3382 tokens, worst step 73 s
 *   temp 0.6 -> 6 of 6 runs usable, thinking 1192..1991 tokens, worst step 47 s
 *
 * At low temperature the thinking length is bimodal: either it commits in ~1.3k tokens
 * or it spirals past 3.2k and emits nothing. Lowering temperature to make structured
 * output "more reliable" is a habit from cloud APIs where it is harmless; here it is
 * the direct cause of the dominant failure mode.
 */
export const QWEN_SAMPLING: Sampling = Object.freeze({
  temperature: 0.6,
  top_p: 0.95,
  top_k: 20,
  min_p: 0,
})

/** Below this, the repetition trap has been observed. */
export const MIN_SAFE_TEMPERATURE = 0.4

export function assertSafeSampling(s: Sampling): void {
  if (s.temperature < MIN_SAFE_TEMPERATURE) {
    throw new Error(
      `temperature ${s.temperature} is below ${MIN_SAFE_TEMPERATURE} and risks a thinking ` +
      `runaway on Qwen3.6-35B-A3B (measured: half of hard steps never emit a tool call). ` +
      `Use QWEN_SAMPLING; enforce discipline with the system prompt and tool_choice instead.`,
    )
  }
}
