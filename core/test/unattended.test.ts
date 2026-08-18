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
  /** How big the fake conversation reads to the between-turn refresh. */
  approxTokens?: number
} = {}) {
  let writes = 0
  let compactions = 0
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
    // The between-turn refresh reads the size and may compact; a fake conversation is
    // always small, so the refresh correctly never fires unless a test raises the size.
    contextUsage: () => ({ promptTokens: null, approxTokens: opts.approxTokens ?? 0 }),
    forceCompact: async () => { compactions += 1 },
  } as unknown as Session
  return { session, sent, runEnds, compactions: () => compactions }
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

  test('a heavy conversation is refreshed between turns; a light one never is', async () => {
    // Each turn of a long run should start from the distilled briefing, not drag one
    // ever-heavier context across the night — but only once there is weight to shed.
    const heavy = fakeSession([{ worked: true }], { approxTokens: 60_000 })
    await run(heavy.session, { maxTurns: 3 })
    expect(heavy.compactions()).toBeGreaterThan(0)

    const light = fakeSession([{ worked: true }], { approxTokens: 5_000 })
    await run(light.session, { maxTurns: 3 })
    expect(light.compactions()).toBe(0)

    const off = fakeSession([{ worked: true }], { approxTokens: 60_000 })
    await run(off.session, { maxTurns: 3, refreshContext: false })
    expect(off.compactions()).toBe(0)
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
      // Negated finish phrases — the finish words are all present, the meaning is not.
      'Not all done yet.',
      'Not everything is done yet, one test is still red.',
      'All done? No — the build is broken.',
    ]) {
      expect(saysFinished(text), text).toBe(false)
    }
  })

  test('understands a Russian finish — the language the model actually answers in', () => {
    // Watched live: a finished Russian task burned two idle turns because only English
    // phrasings matched, and the run ended 'idle' instead of 'done'.
    for (const text of ['Всё готово.', 'Задача полностью выполнена, все тесты проходят.', 'Работа завершена.']) {
      expect(saysFinished(text), text).toBe(true)
    }
    // Bare «Готово.» — watched live too: `\b` is ASCII-only in JS, so the old \bготово
    // branch never matched ANY Cyrillic text and the acceptance gate silently skipped.
    expect(saysFinished('Готово.')).toBe(true)
    expect(saysFinished('Готово!')).toBe(true)
    // Hedged idiom forms — the veto must reach the «всё готово» idiom too, and stay
    // sentence-local so the hedge cannot be dodged by a following clean sentence.
    expect(saysFinished('Почти всё готово, остался деплой.')).toBe(false)
    expect(saysFinished('Ещё не всё готово. Продолжаю работу.')).toBe(false)
    // Declined attributes between «задача» and the verb — the exact live reply that
    // slipped a fixed-word-order pattern: finishes must survive real morphology.
    expect(
      saysFinished(
        'Задача починки отчёта полностью завершена: баг `Math.round` устранён, все 25 тестов проходят.',
      ),
    ).toBe(true)
    expect(saysFinished('Работа над отчётом закончена, всё сходится.')).toBe(true)
    // A hedged finish is not a finish: ending the run here would cut real work short,
    // which is strictly worse than the idle turns a missed finish costs.
    expect(saysFinished('Задача выполнена наполовину, продолжаю.')).toBe(false)
    expect(saysFinished('Задача выполнена, но остались тесты.')).toBe(false)
    expect(saysFinished('Почти готово.')).toBe(false)
    expect(saysFinished('Не готово.')).toBe(false)
    expect(saysFinished('Полуготово.')).toBe(false)
  })

  test('looks at the head and tail of a long reply, not the middle', () => {
    const long = `${'analysis. '.repeat(200)}All done.`
    expect(saysFinished(long)).toBe(true)
    // The model's live sign-off style is the verdict FIRST, then a long report — a
    // tail-only window missed exactly this and the gate never ran on a finished bugfix.
    const verdictFirst = `Готово.\n\n**Причина бага:** ${'подробности исправления. '.repeat(60)}`
    expect(saysFinished(verdictFirst)).toBe(true)
    // Mid-message mentions stay invisible: that is where quoted text and narration live.
    const buried = `${'analysis. '.repeat(60)}All done. ${'more work. '.repeat(60)}`
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

describe('a turn that does not end on its own', () => {
  /** A session whose turn runs until something aborts it — which is what a turn can now be,
   * since the step ceiling came off. */
  function hangingSession() {
    let aborted = false
    const session = {
      send: async (_text: string, signal?: AbortSignal): Promise<TurnResult> => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) { resolve(); return }
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        aborted = true
        return { steps: 400, finalText: '', stoppedBecause: 'aborted' }
      },
      turnFootprint: () => ({ writes: 0, commands: 0 }),
      todos: () => [],
      pendingDecisions: () => [],
      noteRunEnded: () => {},
    } as unknown as Session
    return { session, wasAborted: () => aborted }
  }

  test('the hour budget cuts the turn off instead of waiting for it', async () => {
    // Both budgets used to be checked only BETWEEN turns, which was sound while a turn was
    // capped at forty steps: the worst overshoot was one turn. With no ceiling, one turn
    // that never ends means the deadline is a line the loop cannot reach — someone sets
    // eight hours, goes to bed, and at hour twenty it has still never been evaluated.
    const { session, wasAborted } = hangingSession()
    const summary = await runUnattended({
      session,
      task: 'work forever',
      maxTurns: 10,
      // Real milliseconds: the cut-off is a real timer, because the turn it has to
      // interrupt is doing real work.
      maxHours: 30 / 3_600_000,
    })
    expect(wasAborted()).toBe(true)
    expect(summary.stoppedBecause).toBe('max-hours')
  })

  test('a budget cut-off is not reported as the user stopping the run', async () => {
    // The turn comes back `aborted` either way, and the two are not the same thing. Telling
    // someone who was asleep that they stopped their own run is a run reporting something
    // that did not happen.
    const { session } = hangingSession()
    const summary = await runUnattended({
      session, task: 'work forever', maxTurns: 10, maxHours: 30 / 3_600_000,
    })
    expect(summary.detail).toContain('budget')
    expect(summary.detail).not.toContain('stopped by the user')
  })

  test('the user stopping it still reads as the user stopping it', async () => {
    const { session } = hangingSession()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const summary = await runUnattended({
      session, task: 'work forever', maxTurns: 10, maxHours: 1, signal: controller.signal,
    })
    expect(summary.stoppedBecause).toBe('aborted')
    expect(summary.detail).toContain('stopped by the user')
  })
})
