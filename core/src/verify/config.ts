import { readFileSync } from 'node:fs'
import { localSettingsPath, projectSettingsPath, userSettingsPath, settingsText } from '../permissions/settings.js'

/**
 * The command that says whether the workspace still works, read from the same three settings
 * files everything else configurable comes from.
 *
 * ```json
 * { "verify": "npm test" }
 * { "verify": { "command": "npx tsc --noEmit", "timeoutMs": 120000 } }
 * ```
 *
 * Like the formatter, the command comes from a file the MODEL cannot write —
 * `.privatecode/` is denied to every write tool as a built-in — which is what makes running
 * it without a per-run approval acceptable. If that deny ever goes away, this becomes a way
 * for the model to run an arbitrary command with no gate, so the two are load-bearing
 * together.
 *
 * Absent by default, and that is the right default: a verify command is a promise about how
 * long every writing turn takes, and only the person who owns the project can make it.
 */

export interface VerifySpec {
  command: string
  timeoutMs: number
  /** Which settings file it came from, for the problem messages. */
  source: string
}

export interface LoadedVerify {
  verify: VerifySpec | null
  problems: string[]
}

/** Long enough for a real test suite, short enough that a hung one does not eat the turn
 * silently. A project whose suite needs more says so in its own config. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000
export const MAX_VERIFY_TIMEOUT_MS = 600_000

function readOne(path: string, problems: string[]): VerifySpec | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(`Could not read ${path}: ${(e as Error).message}`)
    }
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(settingsText(raw))
  } catch {
    // The permission loader already reports an unparseable settings file; saying it twice
    // in two different voices is noise.
    return null
  }

  const value = (parsed as { verify?: unknown } | null)?.verify
  if (value === undefined || value === null) return null

  if (typeof value === 'string') {
    if (value.trim() === '') {
      problems.push(`${path}: "verify" is empty; remove it or give it a command`)
      return null
    }
    return { command: value.trim(), timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS, source: path }
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${path}: "verify" must be a command string or an object with a "command"`)
    return null
  }

  const obj = value as { command?: unknown; timeoutMs?: unknown }
  if (typeof obj.command !== 'string' || obj.command.trim() === '') {
    problems.push(`${path}: "verify.command" must be a non-empty string`)
    return null
  }

  let timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS
  if (obj.timeoutMs !== undefined) {
    if (typeof obj.timeoutMs !== 'number' || !Number.isFinite(obj.timeoutMs) || obj.timeoutMs <= 0) {
      problems.push(`${path}: "verify.timeoutMs" must be a positive number of milliseconds`)
    } else {
      timeoutMs = Math.min(obj.timeoutMs, MAX_VERIFY_TIMEOUT_MS)
    }
  }
  return { command: obj.command.trim(), timeoutMs, source: path }
}

/**
 * The most specific `verify` wins outright — local, then project, then user.
 *
 * Not merged, unlike the permission layers: two verify commands is not a stricter policy,
 * it is two answers to one question, and running both would double every writing turn for
 * a user who thought they had overridden a default.
 */
export function loadVerify(workspaceRoot: string): LoadedVerify {
  const problems: string[] = []
  for (const path of [
    localSettingsPath(workspaceRoot), projectSettingsPath(workspaceRoot), userSettingsPath(),
  ]) {
    const found = readOne(path, problems)
    if (found) return { verify: found, problems }
  }
  // Said out loud, because silence here is indistinguishable from the feature working.
  //
  // Mid-turn verification and the end-of-turn fix rounds both hang off this one value, and
  // across fifteen recorded sessions neither has EVER run — no settings file names a check,
  // and nothing anywhere said so. What the model did instead is visible in the same corpus:
  // 47 of its 116 shell commands were `dotnet build` and 41 were `dotnet test`, run by hand,
  // eleven days of a feature being paid for in tokens because nobody knew it was switched
  // off. One turn in that corpus made 38 edits across 11 files with no build between them,
  // and the build afterwards failed and took three rounds to settle.
  //
  // A notice rather than an error: a workspace with no build step is perfectly ordinary. It
  // appears once per session build on the channel the window already renders.
  problems.push(
    'No check is configured, so nothing is run after the model edits files. Add one to ' +
    '.privatecode/settings.json — for example { "verify": { "command": "dotnet build" } } — ' +
    'and a broken edit is caught in the turn that made it rather than ten edits later.',
  )
  return { verify: null, problems }
}
