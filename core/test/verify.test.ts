import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DEFAULT_VERIFY_TIMEOUT_MS, loadVerify } from '../src/verify/config.js'
import { runVerify, verifyFailureMessage } from '../src/verify/runner.js'

/**
 * The project's own check, run after the agent has changed it.
 *
 * The failure this exists for: the agent finishes a turn, says "done", and hands back a
 * workspace that no longer compiles.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-verify-'))
  mkdirSync(join(root, '.privatecode'), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function settings(file: string, body: unknown): void {
  writeFileSync(join(root, '.privatecode', file), JSON.stringify(body), 'utf8')
}

describe('configuring it', () => {
  test('absent by default, and SAYS it is absent', () => {
    // Only the project owner can promise the time a check takes, so there is no default —
    // but silence was indistinguishable from the feature working, and across fifteen
    // recorded sessions neither the mid-turn verification nor the end-of-turn fix rounds
    // ever ran once. The model built by hand instead: 47 of its 116 shell commands were
    // `dotnet build`.
    const { verify, problems } = loadVerify(root)
    expect(verify).toBeNull()
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('No check is configured')
    // A notice, not a scolding: it names the file and shows the line to write.
    expect(problems[0]).toContain('settings.json')
    expect(problems[0]).toContain('dotnet build')
  })

  test('a bare string is the whole configuration', () => {
    settings('settings.json', { verify: 'npm test' })
    const { verify } = loadVerify(root)
    expect(verify?.command).toBe('npm test')
    expect(verify?.timeoutMs).toBe(DEFAULT_VERIFY_TIMEOUT_MS)
  })

  test('an object can set the timeout', () => {
    settings('settings.json', { verify: { command: 'npx tsc --noEmit', timeoutMs: 30_000 } })
    expect(loadVerify(root).verify).toMatchObject({ command: 'npx tsc --noEmit', timeoutMs: 30_000 })
  })

  test('the most specific file wins outright and is not merged', () => {
    // Two verify commands is not a stricter policy, it is two answers to one question --
    // and running both would double every writing turn for someone who believed they had
    // overridden a default.
    settings('settings.json', { verify: 'npm test' })
    settings('settings.local.json', { verify: 'npm run test:fast' })
    expect(loadVerify(root).verify?.command).toBe('npm run test:fast')
  })

  test('a malformed value is reported, not guessed at', () => {
    settings('settings.json', { verify: { timeoutMs: 5000 } })
    const { verify, problems } = loadVerify(root)
    expect(verify).toBeNull()
    expect(problems[0]).toMatch(/verify\.command/)
  })

  test('an unparseable settings file is left to the permission loader to complain about', () => {
    writeFileSync(join(root, '.privatecode', 'settings.json'), '{ not json', 'utf8')
    const { verify, problems } = loadVerify(root)
    expect(verify).toBeNull()
    // One notice — that nothing is configured — and NOT a second complaint about the JSON:
    // the permission loader reports that file, and two messages about one typo is noise.
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('No check is configured')
  })
})

describe('running it', () => {
  const spec = (command: string, timeoutMs = 20_000) => ({ command, timeoutMs, source: 'test' })

  test('exit 0 is a pass', async () => {
    const outcome = await runVerify(spec('exit 0'), root)
    expect(outcome.ok).toBe(true)
    expect(outcome.exitCode).toBe(0)
  })

  test('a non-zero exit is a failure, with the output kept', async () => {
    const outcome = await runVerify(spec('Write-Output "3 tests failed"; exit 1'), root)
    expect(outcome.ok).toBe(false)
    expect(outcome.exitCode).toBe(1)
    expect(outcome.output).toContain('3 tests failed')
  })

  test('the verdict is the exit code, not the look of the output', async () => {
    // The same rule the work log follows: a command that prints the word "error" and exits
    // 0 has not failed, and one that prints nothing and exits 1 has.
    const noisy = await runVerify(spec('Write-Output "error: nothing important"; exit 0'), root)
    expect(noisy.ok).toBe(true)
    const quiet = await runVerify(spec('exit 3'), root)
    expect(quiet.ok).toBe(false)
  })

  test('a command that hangs is stopped and named as a timeout', async () => {
    const outcome = await runVerify(spec('Start-Sleep -Seconds 30', 1_200), root)
    expect(outcome.ok).toBe(false)
    expect(outcome.problem).toMatch(/did not finish/)
  }, 20_000)
})

describe('what the model is told', () => {
  const spec = { command: 'npm test', timeoutMs: 1000, source: 'test' }

  test('a failure names the command, shows the output, and bounds the fix', async () => {
    const text = verifyFailureMessage(spec, { ok: false, exitCode: 1, output: 'FAIL src/a.test.ts' })
    expect(text).toContain('npm test')
    expect(text).toContain('FAIL src/a.test.ts')
    // Bounded on purpose: a vague failure after a write turns a one-line fix into a rewrite.
    expect(text).toMatch(/do not start anything/i)
  })

  test('a command that could not RUN is not reported as a broken project', async () => {
    // Otherwise the model rewrites working code to satisfy a command that was never going
    // to run in the first place.
    const text = verifyFailureMessage(spec, {
      ok: false, exitCode: null, output: '', problem: 'it could not be run (ENOENT)',
    })
    expect(text).toMatch(/problem with the verify command itself/i)
    expect(text).toMatch(/do not try to fix the project/i)
  })
})
