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
  /**
   * The repetition trap this file already warned about, addressed with the sampler built for
   * it instead of with temperature alone.
   *
   * Reported from a real session: the thinking looped — the same few sentences in batches —
   * for six to eight thousand tokens, which is the whole per-step budget, so the step ended
   * having emitted no content and no tool call. Nothing here was sent against that. llama.cpp
   * defaults `repeat_penalty` to 1.0 and `dry_multiplier` to 0, so the request carried no
   * repetition control of any kind and the loop had nothing to stop it.
   *
   * DRY rather than `repeat_penalty`, because this tool writes code: a token penalty punishes
   * braces, keywords and an identifier used eight times in one function, which is the output
   * that matters most here. DRY penalises a repeated SEQUENCE, and a thinking spiral is
   * exactly a repeated sequence.
   *
   * 0.8 multiplier with an allowed length of 4 is llama.cpp's own suggested starting point,
   * deliberately gentle: the failure to avoid is a sampler that makes the model refuse to
   * repeat a variable name.
   */
  dry_multiplier: 0.8,
  dry_base: 1.75,
  dry_allowed_length: 4,
  dry_penalty_last_n: -1,
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
