import type { TodoItem } from '../interaction.js'
import type { Session } from '../session/session.js'
import type { TurnResult } from '../agent/loop.js'
import { saysFinished } from '../session/contract.js'

/**
 * Turn after turn, until the work is done or something says stop.
 *
 * The loop itself is the small part. What makes it safe to leave running is the other four
 * pieces of this plan — a checkpoint per turn so the morning has an undo, the loop detector
 * so one stuck call does not eat the budget, the work log so there is something to read, and
 * the decision queue so a question at minute six does not end the night. This file is only
 * the thing that keeps taking turns, and — more importantly — the thing that knows when to
 * stop.
 *
 * **Every stop condition is explicit and named.** A run that ends is going to be read about
 * hours later by someone who was not watching, and "it stopped" is not an answer. The reason
 * goes in the returned summary and in the work log.
 */

export type StopReason =
  | 'done'
  | 'max-turns'
  | 'max-hours'
  | 'idle'
  | 'blocked'
  | 'server-unreachable'
  | 'aborted'
  | 'error'

export interface UnattendedOptions {
  session: Session
  /** What to work on. Sent as the first turn; later turns are nudged from the todo list. */
  task: string
  maxTurns?: number
  maxHours?: number
  signal?: AbortSignal
  /** Called before each turn, for a host to render progress. */
  onTurn?(info: { turn: number; text: string }): void
  /** Called once, when the run ends. */
  onEnd?(info: RunSummary): void
  /** Injected for tests; defaults to real time. */
  now?(): number
  /**
   * Compact between turns once the conversation is heavy (`REFRESH_CONTEXT_AT`), so each
   * turn of a long run starts from the distilled briefing + plan + contract instead of
   * dragging one ever-heavier context across the whole night. On by default — the drift,
   * re-reads and spirals all live in the dragged context; `false` restores the old
   * behaviour.
   */
  refreshContext?: boolean
}

export interface RunSummary {
  turns: number
  stoppedBecause: StopReason
  /** One sentence a person can read without context. */
  detail: string
}

export const DEFAULT_MAX_TURNS = 50
export const DEFAULT_MAX_HOURS = 8

/** Below this many transcript tokens, a between-turn refresh would summarise a
 * conversation that still fits comfortably in the model's attention, let alone its
 * window — the cost (a summary generation per turn) would exceed the drift it prevents.
 * 60k, because the incompressible floor (system prompt + briefing + the 24k kept-tail
 * cap) can reach ~37k: a threshold at 40k re-compacted every single turn forever. */
export const REFRESH_CONTEXT_AT = 60_000

/** Two turns in a row that changed nothing and ran nothing. */
const IDLE_LIMIT = 2

/** Consecutive transport failures before the run gives up on the server. */
const SERVER_FAILURE_LIMIT = 3

/**
 * The nudge for a turn after the first.
 *
 * Built from the todo list the agent already maintains rather than from a second plan
 * format invented for this: `todo_write` exists, the model uses it, and naming its own
 * pending items back to it is both the strongest available continuation signal and the one
 * the user can read in the app while it runs.
 */
export function nudgeFor(todos: readonly TodoItem[]): string {
  const pending = todos.filter((t) => t.status !== 'completed')
  if (pending.length === 0) {
    return 'Continue with the task. If everything you were asked to do is finished, say so ' +
      'plainly and stop.'
  }
  const list = pending.map((t) => `- ${t.text}${t.status === 'in_progress' ? ' (in progress)' : ''}`)
  return 'Continue. These are still open:\n' + list.join('\n') +
    '\n\nWork on the next one. If they are all actually finished, say so plainly and stop.'
}

// Moved to `session/contract.ts`: the acceptance gate shares it now, and the session
// layer must not import from the CLI layer. Re-exported so every import keeps working.
export { saysFinished }

export async function runUnattended(opts: UnattendedOptions): Promise<RunSummary> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
  const maxHours = opts.maxHours ?? DEFAULT_MAX_HOURS
  const now = opts.now ?? (() => Date.now())
  const deadline = now() + maxHours * 3_600_000

  let turns = 0
  let idle = 0
  let serverFailures = 0
  let next = opts.task

  const finish = (stoppedBecause: StopReason, detail: string): RunSummary => {
    const summary = { turns, stoppedBecause, detail }
    opts.session.noteRunEnded(detail)
    opts.onEnd?.(summary)
    return summary
  }

  for (;;) {
    if (opts.signal?.aborted) return finish('aborted', 'the run was stopped by the user')
    if (turns >= maxTurns) {
      return finish('max-turns', `the ${maxTurns}-turn budget was reached`)
    }
    if (now() >= deadline) {
      return finish('max-hours', `the ${maxHours}-hour budget was reached`)
    }

    turns += 1
    opts.onTurn?.({ turn: turns, text: next })

    // The hour budget has to be able to cut a turn OFF, not merely decline to start another.
    //
    // Both budgets used to be checked only here, between turns, which was sound while a turn
    // was capped at forty steps: the longest a run could overshoot was one turn. With the
    // step ceiling gone a turn can run indefinitely, and a single turn that never ends means
    // `now() >= deadline` is a line the loop cannot reach. Someone sets an eight-hour budget,
    // goes to bed, and at hour twenty it has still never been evaluated — which is the
    // opposite of what a budget is for.
    const budget = AbortSignal.timeout(Math.max(1, deadline - now()))
    const turnSignal = opts.signal ? AbortSignal.any([opts.signal, budget]) : budget

    let result: TurnResult
    const before = opts.session.turnFootprint()
    try {
      // Only the FIRST turn carries the user's task; every later `next` is this loop's own
      // nudge, and a nudge distilled into a contract replaced the real one all night.
      result = await opts.session.send(next, turnSignal, { distill: turns === 1 })
      serverFailures = 0
    } catch (e) {
      // A transport failure is not a turn outcome — `Session.send` folds abort and timeout
      // into `stoppedBecause` and only lets a genuinely broken connection escape. One is a
      // hiccup worth retrying; three in a row means the server is gone and every further
      // turn would be a minute of waiting followed by the same error.
      serverFailures += 1
      if (serverFailures >= SERVER_FAILURE_LIMIT) {
        return finish('server-unreachable',
          `the model server stopped answering (${(e as Error).message})`)
      }
      next = 'The previous turn failed to reach the model server. Try the same step again.'
      continue
    }

    if (result.stoppedBecause === 'aborted') {
      // Which abort it was matters: a turn cut off by its own budget reported as "the run
      // was stopped by the user" would be a run reporting something that did not happen, to
      // someone who was asleep for it.
      if (budget.aborted && opts.signal?.aborted !== true) {
        return finish('max-hours',
          `the ${maxHours}-hour budget was reached, and the turn that was still running was ` +
          'stopped at it')
      }
      return finish('aborted', 'the run was stopped by the user')
    }

    // Nothing changed and nothing ran. Once is a turn spent thinking; twice in a row is a
    // model politely narrating instead of working, which is the failure mode that looks
    // most like progress from the outside.
    const after = opts.session.turnFootprint()
    if (after.writes === before.writes && after.commands === before.commands) {
      idle += 1
      if (idle >= IDLE_LIMIT) {
        return finish('idle', `${IDLE_LIMIT} turns in a row changed no files and ran no commands`)
      }
    } else {
      idle = 0
    }

    const pending = opts.session.pendingDecisions()
    const todos = opts.session.todos()
    const stillOpen = todos.filter((t) => t.status !== 'completed')

    // A queue that has grown while nothing is left to work on means every remaining path is
    // waiting on the user. Continuing would spend the budget re-discovering that.
    if (pending.length > 0 && stillOpen.length === 0) {
      return finish('blocked',
        `${pending.length} decision${pending.length === 1 ? ' is' : 's are'} waiting for you, ` +
        'and nothing else is left to work on')
    }

    if (saysFinished(result.finalText) && stillOpen.length === 0) {
      // The gate's verdict outranks the prose: "done" from a turn the acceptance check
      // left criteria standing on is exactly the confident-but-unmet ending this whole
      // mechanism exists to stop.
      const unmet = opts.session.lastAcceptanceUnmet?.() ?? 0
      // `null` is the audit having been attempted and failed — a transport error, a
      // truncated generation, an answer that did not parse. That is not permission to
      // finish: it is the one case where nothing checked the work at all, and it used to be
      // indistinguishable from a clean audit because both arrived as the number 0.
      if (unmet === null) {
        return finish('blocked',
          'the agent reported the work finished, but the contract audit could not be run, ' +
          'so nothing has checked it')
      }
      if (unmet === 0) return finish('done', 'the agent reported the work finished')
      return finish('blocked',
        `the agent reported the work finished, but ${unmet} contract ` +
        `criteri${unmet === 1 ? 'on' : 'a'} remained unmet after the fix rounds`)
    }

    // A fresh frame for the next turn once the conversation has grown heavy: the summary
    // briefing plus the plan plus the contract IS the distilled state, and it is measured
    // to carry constraints faithfully — while a single context dragged across many turns
    // is where the drift, the re-reads and the spirals live. Between turns is the one
    // moment this costs nothing extra: the slot is idle and the next turn re-prefills
    // anyway. `forceCompact` keeps its own nothing-to-gain gate, so small conversations
    // pass through untouched.
    if (opts.refreshContext !== false && opts.session.contextUsage().approxTokens >= REFRESH_CONTEXT_AT) {
      try {
        await opts.session.forceCompact(opts.signal)
      } catch { /* an uncompacted next turn is the status quo, not a failure */ }
    }

    next = nudgeFor(todos)
  }
}
