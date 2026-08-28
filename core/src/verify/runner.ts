import { runPowershell } from '../powershell.js'
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
    // `runPowershell`, not execa's own timeout/cancelSignal: those kill the DIRECT child,
    // which is always powershell.exe, while the build doing the work is its grandchild. A
    // verify command is the likeliest of all of them to be a long dotnet or npm build, so
    // an interrupted turn used to leave a compiler running — holding its lock and its
    // cores — with nothing on screen saying so.
    const { result, stopped } = await runPowershell(spec.command, {
      cwd, timeoutMs: spec.timeoutMs, signal,
    })

    const output = clipOutput((result.all ?? '').trim(), MAX_OUTPUT_CHARS)
    if (stopped === 'timeout') {
      return {
        ok: false,
        exitCode: null,
        output,
        problem: `it did not finish within ${Math.round(spec.timeoutMs / 1000)}s`,
      }
    }
    if (stopped === 'cancelled') {
      return { ok: false, exitCode: null, output, problem: 'it was stopped' }
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
/** The two openers a verify result can start with. `replay.ts` reads them so a build log the
 * harness injected is not replayed as something the person typed. */
export const VERIFY_FAILED_PREFIX = 'Automatic verification failed.'
export const VERIFY_PROBLEM_PREFIX = 'Automatic verification could not run:'

/**
 * The two MID-TURN verify messages, which arrive wrapped in brackets and are hand-backs all
 * the same.
 *
 * They live here rather than at the site in `session.ts` that composes them because
 * `replay.ts` has to recognise them and `session.ts` imports `replay.ts` — putting them at
 * the composing site would close the cycle. Naming them at all is what stopped the most
 * frequent check in the app being reported as a status line: everything in brackets was a
 * `note`, so a build that broke mid-turn nine times counted as nine log lines and the
 * diagnosis said the checking cost nothing.
 */
export const MIDTURN_VERIFY_PREFIX = 'Checked while you work — '
/** The suppressed repeat: the same failure, deliberately not re-quoted. A hand-back that is
 * cheap BY DESIGN, and worth telling apart from one that spends the whole log again. */
export const STILL_FAILING_SUFFIX = ': still failing, same errors as before.'

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
