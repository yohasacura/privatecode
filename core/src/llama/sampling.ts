import type { Sampling } from './types.js'

/**
 * The sampling profile, and it survived a change of model.
 *
 * Originally Qwen3.6's documented profile, measured on that model and server
 * (docs/SPIKE-TEMPERATURE.md): holding task, prompt, tool_choice and max_tokens fixed and
 * varying only temperature,
 *
 *   temp 0.1 -> 3 of 6 runs usable, thinking 1149..3382 tokens, worst step 73 s
 *   temp 0.6 -> 6 of 6 runs usable, thinking 1192..1991 tokens, worst step 47 s
 *
 * At low temperature the thinking length was bimodal: either it committed in ~1.3k tokens
 * or it spiralled past 3.2k and emitted nothing. Lowering temperature to make structured
 * output "more reliable" is a habit from cloud APIs where it is harmless; there it was the
 * direct cause of the dominant failure mode.
 *
 * RE-MEASURED 2026-08-22 against KAT-Coder-V2.5-Dev, which the server now serves and whose
 * own GGUF metadata asks for temperature 1.0 (its top_k 20 and top_p 0.95 agree with what is
 * sent). Same method, n=6 per arm (`spike/temperature-kat-probe.mts`,
 * `docs/SPIKE-KAT-CODER.md`):
 *
 *   temp 0.6 -> 6 of 6 usable, wall median 5.6 s, thinking median 58 tokens, 0 truncated
 *   temp 1.0 -> 6 of 6 usable, wall median 5.9 s, thinking median 56 tokens, 0 truncated
 *
 * No difference, so the value STAYS — a number that is measured to be equivalent is not
 * worth changing. What did change is why it matters: this model thinks ~58 tokens where
 * Qwen3.6 thought 1192-1991, and the runaway this pin defends against did not appear in
 * either arm. The pin is no longer load-bearing; it is simply doing no harm.
 */
export const QWEN_SAMPLING: Sampling = Object.freeze({
  temperature: 0.6,
  top_p: 0.95,
  top_k: 20,
  min_p: 0,
  /**
   * DRY is OFF, and stays off. It was switched on here for one day and measured out again.
   *
   * The reasoning for adding it was sound and the measurement refuted it. A user hit a
   * thinking spiral — the same few sentences for the whole 8000-token step budget — and this
   * client was sending no repetition control at all, which the server confirmed
   * (`repeat_penalty: 1.0`, `dry_multiplier: 0`). DRY looked right precisely because it
   * penalises a repeated SEQUENCE rather than a repeated token, which is what a code-writing
   * tool needs.
   *
   * What it actually did, measured against this model on the machine it runs on:
   *
   *   settings                          five file paths, listed three times
   *   dry off                           15 of 15 names verbatim
   *   0.8 / allowed 4 / whole context    0 of 15   — `.cs` became `.css`, `ProcessCleaner`
   *                                                 became `ProcessCleanser`, `FileLogger`
   *                                                 became `FilerLogger`, `Services` became
   *                                                 `Servic`
   *   0.8 / allowed 8 / last 256        15 of 15
   *   0.4 / allowed 12 / last 256       15 of 15
   *
   * And against an actual loop — "write this sentence forty times" — every one of those
   * settings produced the sentence 37 times verbatim, byte-identical output, including the
   * aggressive one and including multiplier 1.5.
   *
   * So the penalty bites where the model HAS a plausible alternative — an identifier it can
   * spell slightly differently — and loses to the instruction where it does not. That is the
   * exact inverse of what a coding agent needs: it corrupts the names that must be exact and
   * does nothing about the degenerate repetition it was added for.
   *
   * The spiral is addressed where it was actually caused instead: `appendTruncated` in
   * `agent/loop.ts` no longer carries a looping ramble back into the transcript, which is
   * what made the fault survive compaction and stopping, and left starting a new session as
   * the only cure.
   */
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
