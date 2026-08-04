import type { TodoItem } from '../interaction.js'
import type { Session } from '../session/session.js'
import type { TurnResult } from '../agent/loop.js'

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
}

export interface RunSummary {
  turns: number
  stoppedBecause: StopReason
  /** One sentence a person can read without context. */
  detail: string
}

export const DEFAULT_MAX_TURNS = 50
export const DEFAULT_MAX_HOURS = 8

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

/**
 * True when the model's closing text reads as "I am finished".
 *
 * Deliberately narrow. A loose match ends the run on the first turn that happens to contain
 * the word "done", and an overnight run that stops at 22:05 because the model said "done
 * with the first file" is a worse failure than one that takes an extra turn to notice.
 */
export function saysFinished(text: string): boolean {
  const tail = text.trim().toLowerCase().slice(-400)
  return /\b(all done|everything (is )?(now )?(done|finished|complete)|task (is )?complete|nothing (else|more) (left )?to do|no (further|more) (work|changes) (is |are )?(needed|required))\b/
    .test(tail)
}

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

    let result: TurnResult
    const before = opts.session.turnFootprint()
    try {
      result = await opts.session.send(next, opts.signal)
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
        `${pending.length} decision${pending.length === 1 ? '' : 's'} are waiting for you, and ` +
        'nothing else is left to work on')
    }

    if (saysFinished(result.finalText) && stillOpen.length === 0) {
      return finish('done', 'the agent reported the work finished')
    }

    next = nudgeFor(todos)
  }
}
