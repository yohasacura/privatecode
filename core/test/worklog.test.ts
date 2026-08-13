import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { WorkLog, commandsFrom, summarizeDiff } from '../src/session/worklog.js'

/**
 * What a person reads in the morning.
 *
 * The property under test everywhere here is TRUSTWORTHINESS: every line has to come from
 * something that happened, not from the model's account of what happened, because a summary
 * written by the same model that did the work agrees with itself by construction.
 */

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pc-worklog-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const body = (): string => readFileSync(join(root, '.privatecode', 'state', 'worklog.md'), 'utf8')
const at = new Date('2026-08-04T14:22:00')

describe('an entry', () => {
  test('reads as one scannable block', () => {
    const log = new WorkLog(root)
    log.append({
      at, turn: 17, ask: 'make the settings modal remember the last workspace',
      checkpoint: 'a1b2c3d',
      diffStat: ' app/src/panels/status.tsx | 15 ++++++---\n 1 file changed, 12 insertions(+), 3 deletions(-)',
      commands: [{ command: 'npm test', exit: 0, ok: true, ran: true }],
      ended: 'done', steps: 6,
    })
    const text = body()
    expect(text).toContain('## 14:22 · turn 17 · checkpoint a1b2c3d')
    expect(text).toContain('**Asked:** make the settings modal remember the last workspace')
    expect(text).toContain('app/src/panels/status.tsx')
    expect(text).toContain('`npm test` → exit 0')
    expect(text).toContain('**Ended:** done, 6 steps')
  })

  test('a turn that changed nothing has no Changed line at all', () => {
    // The absence is the signal, and reads faster than "Changed: nothing" when scanning a
    // night's worth of entries for the ones that did something.
    const log = new WorkLog(root)
    log.append({ at, turn: 2, ask: 'what does this file do?', commands: [], ended: 'done', steps: 1 })
    expect(body()).not.toContain('**Changed:**')
    expect(body()).toContain('**Ended:** done, 1 step')
  })

  test('a failing command keeps its real exit code', () => {
    // The whole reason the log exists: "Ran npm test" without the code is what the model
    // would have told you anyway.
    const log = new WorkLog(root)
    log.append({
      at, turn: 3, ask: 'fix the build',
      commands: [{ command: 'npm run build', exit: 1, ok: false, ran: true }],
      ended: 'done', steps: 4,
    })
    expect(body()).toContain('→ exit 1')
  })

  test('a command the agent was NOT allowed to run is never reported as having run', () => {
    // The rehearsal's real find: a DEFERRED `npx tsc` was written under "Ran: … → failed",
    // so the morning reader would have concluded the typecheck ran and was broken. A
    // blocked call is worth reporting — often it is the most interesting thing that
    // happened — but never under the same heading as one that executed.
    const log = new WorkLog(root)
    log.append({
      at, turn: 4, ask: 'check the types',
      commands: [
        { command: 'npm test', exit: 0, ok: true, ran: true },
        { command: 'npx tsc --noEmit', ok: false, ran: false, blockedBy: 'queued for the user' },
      ],
      ended: 'done', steps: 3,
    })
    const text = body()
    expect(text).toContain('**Ran:** `npm test` → exit 0')
    expect(text.split('\n').find((l) => l.startsWith('**Ran:**'))).not.toContain('tsc')
    expect(text).toContain('**Blocked:** `npx tsc --noEmit` → queued for the user')
  })

  test('appends, never rewrites', () => {
    const log = new WorkLog(root)
    log.append({ at, turn: 1, ask: 'one', commands: [], ended: 'done', steps: 1 })
    log.append({ at, turn: 2, ask: 'two', commands: [], ended: 'done', steps: 1 })
    const text = body()
    expect(text).toContain('turn 1')
    expect(text).toContain('turn 2')
    expect(text.indexOf('turn 1')).toBeLessThan(text.indexOf('turn 2'))
  })

  test('a long ask is clipped rather than wrapped across the entry', () => {
    const log = new WorkLog(root)
    log.append({ at, turn: 1, ask: 'x'.repeat(400), commands: [], ended: 'done', steps: 1 })
    const line = body().split('\n').find((l) => l.startsWith('**Asked:**'))!
    expect(line.length).toBeLessThan(200)
    expect(line).toContain('…')
  })

  test('an unwritable workspace records one problem and does not throw', () => {
    // A path whose parent is a FILE, so the directory genuinely cannot be created. A
    // merely non-existent path is not a failure at all — `mkdir -p` makes it — which is
    // what the first version of this test got wrong.
    writeFileSync(join(root, 'not-a-dir'), 'x', 'utf8')
    const log = new WorkLog(join(root, 'not-a-dir', 'workspace'))
    expect(() => log.append({ at, turn: 1, ask: 'x', commands: [], ended: 'done', steps: 1 })).not.toThrow()
    expect(log.problems.length).toBe(1)
  })

  test('a workspace that keeps failing reports once, not once per turn', () => {
    // Eight hours of turns must not produce eight hours of the same problem string.
    writeFileSync(join(root, 'not-a-dir2'), 'x', 'utf8')
    const log = new WorkLog(join(root, 'not-a-dir2', 'workspace'))
    for (let i = 0; i < 5; i++) {
      log.append({ at, turn: i, ask: 'x', commands: [], ended: 'done', steps: 1 })
    }
    expect(log.problems.length).toBe(1)
  })

  test('the run\'s own ending is its own heading, not a turn with empty fields', () => {
    // The first rehearsal wrote it as a turn entry, which produced a second "turn 1"
    // heading and an "Ended: run ended, 0 steps" line that said nothing — noise at exactly
    // the place a person looks first.
    const log = new WorkLog(root)
    log.appendRunEnd(at, 12, 'two turns in a row changed nothing')
    const text = body()
    expect(text).toContain('## 14:22 · run ended after 12 turns')
    expect(text).toContain('two turns in a row changed nothing')
    expect(text).not.toContain('**Ended:**')
  })
})

describe('summarizeDiff', () => {
  test('names the files when there are few enough to be worth naming', () => {
    const stat = ' a.ts | 3 ++-\n b.ts | 1 +\n 2 files changed, 3 insertions(+), 1 deletion(-)'
    expect(summarizeDiff(stat)).toBe('a.ts (3 ++-), b.ts (1 +)')
  })

  test('collapses a wide change to a count, because thirty names are noise', () => {
    const files = Array.from({ length: 12 }, (_, i) => ` f${i}.ts | 1 +`).join('\n')
    const summary = summarizeDiff(`${files}\n 12 files changed, 12 insertions(+)`)
    expect(summary).toBe('12 files (12 files changed, 12 insertions(+))')
  })

  test('empty in, empty out', () => {
    expect(summarizeDiff('')).toBe('')
  })
})

describe('commandsFrom', () => {
  test('reads the exit code out of what run_command actually returned', () => {
    const records = commandsFrom([
      { name: 'run_command', args: '{"command":"npm test"}', content: 'exit 0 in 1.2 s\nok', ok: true },
      { name: 'read_file', args: '{"path":"a.ts"}', content: 'body', ok: true },
      { name: 'run_command', args: '{"command":"npm run build"}', content: 'exit 2 in 0.4 s\nboom', ok: false },
    ])
    expect(records).toEqual([
      { command: 'npm test', exit: 0, ok: true, ran: true },
      { command: 'npm run build', exit: 2, ok: false, ran: true },
    ])
  })

  test('a call the gate stopped is marked as never having run, with the reason', () => {
    // Every path that stops a call before it executes — a denial, a deferral into the
    // queue, a loop-detector refusal, plan mode — answers with `Not run:`. That prefix is
    // the one honest signal available here.
    const records = commandsFrom([
      {
        name: 'run_command', args: '{"command":"npx tsc --noEmit"}',
        content: 'Not run: nobody is available to approve this, so it has been queued for the user.',
        ok: false,
      },
    ])
    expect(records[0]).toMatchObject({ command: 'npx tsc --noEmit', ran: false })
    expect(records[0]?.blockedBy).toBe('queued for you')
    expect(records[0]).not.toHaveProperty('exit')
  })

  test('a call whose arguments never parsed is not reported as having run', () => {
    expect(commandsFrom([{ name: 'run_command', args: '{oops', content: 'x', ok: false }])).toEqual([])
  })

  test('a command with no exit line is reported by outcome instead of inventing one', () => {
    const records = commandsFrom([
      { name: 'run_command', args: '{"command":"sleep"}', content: 'Command cancelled by the user', ok: false },
    ])
    expect(records).toEqual([{ command: 'sleep', ok: false, ran: true }])
  })
})

describe('repetition in one turn', () => {
  test('the same command blocked twice is one line with a count', () => {
    // The third rehearsal logged `npx tsc --noEmit → queued for you` twice in a row. Saying
    // it twice conveys nothing the count does not, and pushes whatever WAS different off
    // the end of the line.
    const log = new WorkLog(root)
    log.append({
      at, turn: 1, ask: 'check types',
      commands: [
        { command: 'npx tsc --noEmit', ok: false, ran: false, blockedBy: 'queued for you' },
        { command: 'npx tsc --noEmit', ok: false, ran: false, blockedBy: 'queued for you' },
        { command: 'npm test', ok: false, ran: false, blockedBy: 'queued for you' },
      ],
      ended: 'done', steps: 4,
    })
    const line = body().split('\n').find((l) => l.startsWith('**Blocked:**'))!
    expect(line).toContain('`npx tsc --noEmit` → queued for you (×2)')
    expect(line).toContain('`npm test` → queued for you')
    expect(line).not.toContain('(×1)')
  })

  test('the same command that ran twice with different outcomes stays two lines', () => {
    // A retry that changed something is real information.
    const log = new WorkLog(root)
    log.append({
      at, turn: 1, ask: 'fix it',
      commands: [
        { command: 'npm test', exit: 1, ok: false, ran: true },
        { command: 'npm test', exit: 0, ok: true, ran: true },
      ],
      ended: 'done', steps: 4,
    })
    const line = body().split('\n').find((l) => l.startsWith('**Ran:**'))!
    expect(line).toContain('exit 1')
    expect(line).toContain('exit 0')
  })
})
