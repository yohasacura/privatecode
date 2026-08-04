import { describe, expect, test } from 'vitest'
import { nudgeFor, runUnattended, saysFinished, type RunSummary } from '../src/cli/unattended.js'
import type { Session } from '../src/session/session.js'
import type { TodoItem } from '../src/interaction.js'
import type { TurnResult } from '../src/agent/loop.js'

/**
 * The loop that keeps taking turns, and — the part that matters — the one that knows when
 * to stop.
 *
 * Every test here is about a STOP CONDITION, because a run that ends is going to be read
 * about hours later by someone who was not watching, and "it stopped" is not an answer.
 */

interface FakeTurn {
  finalText?: string
  stoppedBecause?: TurnResult['stoppedBecause']
  /** Did this turn write a file or run a command? */
  worked?: boolean
  throws?: string
}

function fakeSession(script: FakeTurn[], opts: {
  todos?: TodoItem[]
  pending?: unknown[]
} = {}) {
  let writes = 0
  const sent: string[] = []
  const runEnds: string[] = []
  let i = 0
  const session = {
    send: async (text: string): Promise<TurnResult> => {
      sent.push(text)
      const turn = script[Math.min(i, script.length - 1)] ?? {}
      i += 1
      if (turn.throws) throw new Error(turn.throws)
      if (turn.worked) writes += 1
      return {
        steps: 1,
        finalText: turn.finalText ?? 'working on it',
        stoppedBecause: turn.stoppedBecause ?? 'done',
      }
    },
    turnFootprint: () => ({ writes, commands: 0 }),
    todos: () => opts.todos ?? [],
    pendingDecisions: () => opts.pending ?? [],
    noteRunEnded: (detail: string) => { runEnds.push(detail) },
  } as unknown as Session
  return { session, sent, runEnds }
}

const run = (session: Session, extra: Partial<Parameters<typeof runUnattended>[0]> = {}) =>
  runUnattended({ session, task: 'do the thing', maxTurns: 10, ...extra })

describe('stopping', () => {
  test('on the agent saying it is finished, with nothing left open', async () => {
    const { session, runEnds } = fakeSession([{ worked: true, finalText: 'All done.' }])
    const summary = await run(session)
    expect(summary).toMatchObject({ stoppedBecause: 'done', turns: 1 })
    // The reason reaches the work log, which is where the morning review looks.
    expect(runEnds).toEqual(['the agent reported the work finished'])
  })

  test('not on a passing mention of "done" mid-sentence', async () => {
    // A loose match ends the night at 22:05 because the model said "done with the first
    // file", which is a worse failure than taking one more turn to notice.
    const { session } = fakeSession([
      { worked: true, finalText: 'I am done with the first file, moving on.' },
      { worked: true, finalText: 'Everything is now finished.' },
    ])
    expect((await run(session)).turns).toBe(2)
  })

  test('not while todos are still open, whatever the model says', async () => {
    const { session } = fakeSession(
      [{ worked: true, finalText: 'All done.' }],
      { todos: [{ text: 'write the tests', status: 'pending' }] },
    )
    expect((await run(session, { maxTurns: 3 })).stoppedBecause).toBe('max-turns')
  })

  test('on the turn budget', async () => {
    const { session } = fakeSession([{ worked: true }])
    const summary = await run(session, { maxTurns: 4 })
    expect(summary).toMatchObject({ stoppedBecause: 'max-turns', turns: 4 })
    expect(summary.detail).toContain('4-turn budget')
  })

  test('on the clock, checked before a turn rather than after', async () => {
    // Otherwise an eight-hour budget can end nine hours in, having started one more turn.
    let clock = 0
    const { session } = fakeSession([{ worked: true }])
    const summary = await run(session, {
      maxHours: 1,
      maxTurns: 100,
      now: () => { clock += 20 * 60_000; return clock },
    })
    expect(summary.stoppedBecause).toBe('max-hours')
    expect(summary.turns).toBeLessThan(5)
  })

  test('on two turns in a row that changed nothing and ran nothing', async () => {
    // The failure mode that looks most like progress from the outside: a model narrating.
    const { session } = fakeSession([
      { worked: true }, { worked: false }, { worked: false }, { worked: true },
    ])
    const summary = await run(session)
    expect(summary).toMatchObject({ stoppedBecause: 'idle', turns: 3 })
    expect(summary.detail).toContain('changed no files and ran no commands')
  })

  test('one idle turn is not enough, because thinking is allowed', async () => {
    const { session } = fakeSession([
      { worked: true }, { worked: false }, { worked: true }, { worked: true },
    ])
    expect((await run(session, { maxTurns: 4 })).stoppedBecause).toBe('max-turns')
  })

  test('when every remaining path is waiting on the user', async () => {
    const { session } = fakeSession([{ worked: true }], { pending: [{ id: 'd1' }] })
    const summary = await run(session)
    expect(summary.stoppedBecause).toBe('blocked')
    expect(summary.detail).toContain('1 decision is waiting')
  })

  test('but NOT while there is still other work to do', async () => {
    // A parked question is supposed to move the agent sideways, not end the night.
    const { session } = fakeSession([{ worked: true }], {
      pending: [{ id: 'd1' }],
      todos: [{ text: 'something else', status: 'pending' }],
    })
    expect((await run(session, { maxTurns: 3 })).stoppedBecause).toBe('max-turns')
  })

  test('on three transport failures in a row, but not on one', async () => {
    const { session } = fakeSession([
      { throws: 'socket hang up' }, { worked: true }, { throws: 'socket hang up' },
      { throws: 'socket hang up' }, { throws: 'socket hang up' },
    ])
    const summary = await run(session)
    expect(summary.stoppedBecause).toBe('server-unreachable')
    expect(summary.detail).toContain('socket hang up')
    // Turn 1 failed, turn 2 succeeded and reset the count, then three failures ended it.
    expect(summary.turns).toBe(5)
  })

  test('on the user stopping it', async () => {
    const controller = new AbortController()
    const { session } = fakeSession([{ worked: true, stoppedBecause: 'aborted' }])
    const summary = await run(session, { signal: controller.signal })
    expect(summary.stoppedBecause).toBe('aborted')
  })
})

describe('what drives the next turn', () => {
  test('the first turn is the task; later ones name the open todos', async () => {
    const { session, sent } = fakeSession([{ worked: true }], {
      todos: [
        { text: 'write the parser', status: 'in_progress' },
        { text: 'add tests', status: 'pending' },
        { text: 'read the spec', status: 'completed' },
      ],
    })
    await run(session, { maxTurns: 2 })
    expect(sent[0]).toBe('do the thing')
    expect(sent[1]).toContain('write the parser (in progress)')
    expect(sent[1]).toContain('add tests')
    // A finished item is not offered back as work.
    expect(sent[1]).not.toContain('read the spec')
  })

  test('with no todos at all it asks plainly rather than inventing a plan', () => {
    expect(nudgeFor([])).toMatch(/Continue with the task/)
    expect(nudgeFor([])).toMatch(/say so\s+plainly and stop/)
  })
})

describe('saysFinished', () => {
  test('accepts the ways a model actually signs off', () => {
    for (const text of [
      'All done.',
      'Everything is now complete.',
      'The task is complete — the tests pass.',
      'There is nothing more to do.',
      'No further changes are needed.',
    ]) {
      expect(saysFinished(text), text).toBe(true)
    }
  })

  test('refuses the ways it merely mentions finishing', () => {
    for (const text of [
      'I am done with the first file, moving on to the second.',
      'Once this is complete I will run the tests.',
      'That would complete the task.',
      'I have not finished yet.',
    ]) {
      expect(saysFinished(text), text).toBe(false)
    }
  })

  test('looks at the end of a long reply, not the middle', () => {
    const long = `${'analysis. '.repeat(200)}All done.`
    expect(saysFinished(long)).toBe(true)
    const buried = `All done. ${'more work. '.repeat(200)}`
    expect(saysFinished(buried)).toBe(false)
  })
})

describe('the summary', () => {
  test('always names a reason a person can read without context', async () => {
    const cases: RunSummary[] = []
    const { session } = fakeSession([{ worked: true, finalText: 'All done.' }])
    cases.push(await run(session))
    for (const summary of cases) {
      expect(summary.detail.length).toBeGreaterThan(10)
      expect(summary.detail).not.toContain('undefined')
    }
  })
})
