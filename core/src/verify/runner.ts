import { execa } from 'execa'
import { POWERSHELL_EXE, powershellArgs } from '../powershell.js'
import { clipOutput } from '../tools/run-command.js'
import type { VerifySpec } from './config.js'

/**
 * Running the project's own check after the agent has changed it.
 *
 * The failure this exists for: the agent finishes a turn, says "done", and hands back a
 * workspace that no longer compiles. Nobody finds out until a person runs the tests, by
 * which point the turn is over, the context has moved on, and fixing it costs a fresh
 * explanation of what was being attempted. Feeding the failure back into the SAME turn keeps
 * that whole chain inside the one place where the model already knows what it just did and
 * why.
 *
 * The verdict is the exit code, not the model's opinion of the output — the same rule the
 * work log follows, and for the same reason.
 */

/** Enough to see which tests failed and why; the model can re-run the command itself for
 * more. A full suite's output is tens of thousands of lines of passes. */
const MAX_OUTPUT_CHARS = 6_000

export interface VerifyOutcome {
  ok: boolean
  /** Exit code, or null when the command could not be run or was stopped. */
  exitCode: number | null
  /** Combined stdout+stderr, clipped. */
  output: string
  /** Set when the run itself failed rather than the project: a timeout, a missing shell. */
  problem?: string
}

export async function runVerify(
  spec: VerifySpec, cwd: string, signal?: AbortSignal,
): Promise<VerifyOutcome> {
  try {
    const result = await execa(
      POWERSHELL_EXE,
      powershellArgs(spec.command),
      {
        cwd,
        timeout: spec.timeoutMs,
        reject: false,
        windowsHide: true,
        all: true,
        ...(signal ? { cancelSignal: signal } : {}),
      },
    )
    const output = clipOutput((result.all ?? '').trim(), MAX_OUTPUT_CHARS)
    if (result.timedOut === true) {
      return {
        ok: false,
        exitCode: null,
        output,
        problem: `it did not finish within ${Math.round(spec.timeoutMs / 1000)}s`,
      }
    }
    return { ok: result.exitCode === 0, exitCode: result.exitCode ?? null, output }
  } catch (e) {
    // A verify command that cannot be STARTED is a configuration problem, not a broken
    // workspace, and must not be reported to the model as "your change broke the build".
    return {
      ok: false,
      exitCode: null,
      output: '',
      problem: `it could not be run (${e instanceof Error ? e.message : String(e)})`,
    }
  }
}

/**
 * What the model is told when the check fails.
 *
 * Written as a plain statement of fact with the command named, because the model is about to
 * act on it: a vague "something failed" produces a guess, and a guess after a write is how a
 * one-line fix becomes a rewrite. The instruction is deliberately narrow — fix what this
 * reports, do not start anything new — since the turn is already over in every sense except
 * that the workspace is broken.
 */
export function verifyFailureMessage(spec: VerifySpec, outcome: VerifyOutcome): string {
  if (outcome.problem !== undefined) {
    return `Automatic verification could not run: \`${spec.command}\` — ${outcome.problem}. ` +
      'This is a problem with the verify command itself, not necessarily with your change. ' +
      'Say so in your reply and do not try to fix the project because of it.'
  }
  return `Automatic verification failed. \`${spec.command}\` exited ${outcome.exitCode ?? '?'} ` +
    'after your changes:\n\n' +
    '```\n' + outcome.output + '\n```\n\n' +
    'Fix what this reports, then stop. Do not start anything the user did not ask for. ' +
    'If the failure is unrelated to your change, say that instead of changing more code.'
}
