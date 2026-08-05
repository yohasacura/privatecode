import { useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import type { ChatAction, ChatState } from '../lib/state'
import { formatDuration } from '../lib/format'
import { Icon } from '../components/icons'

/**
 * The unattended run, as a thing you can see.
 *
 * A run used to exist in the interface as a relabelled button ("Stop · turn 3") and one
 * line of status text after it ended. For the feature the whole step-ceiling removal was
 * done for — days-long work with nobody watching — that is a strange amount of invisibility:
 * the task it is pursuing, how long it has been at it, what budget it is running against and
 * what it is waiting on were all unknowable without reading the work log afterwards.
 *
 * Two cards, never both:
 * - While a run is active: the task verbatim, the turn count against its budget when one was
 *   set, the elapsed time, how many decisions are parked, and Stop.
 * - After it ends: why, in the host's own words, until dismissed. `stoppedBecause` is the
 *   first thing wanted after coming back to the machine, and it must not vanish the moment
 *   the run does — nor sit there forever once read.
 */

/** The run banner's clock ticks at 1s: an elapsed readout for something measured in hours
 * does not need the composer's 250ms cadence, and this card is mounted for whole nights. */
const TICK_MS = 1_000

export function RunBanner({
  client, state, dispatch,
}: {
  client: ProtocolClient
  state: ChatState
  dispatch: (action: ChatAction) => void
}): VNode | null {
  const run = state.run
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (run === null) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [run !== null])

  if (run !== null) {
    // A run this window did not start (startedAtMs 0) has no clock to show; claiming
    // "0:00" for a run hours old would be worse than saying nothing.
    // Clamped: `now` is mount-time state and `run-started` stamps a LATER wall clock,
    // so the first second of a new run over a visible ended card read as negative.
    const elapsed = run.startedAtMs > 0 ? formatDuration(Math.max(0, now - run.startedAtMs)) : null
    const budget: string[] = []
    if (run.maxTurns !== undefined) budget.push(`of ${run.maxTurns}`)
    if (run.maxHours !== undefined) {
      budget.push(`· ${run.maxHours} h budget`)
    }
    return (
      <div class="run-banner" role="status">
        <span class="run-banner-pulse" aria-hidden="true" />
        <div class="run-banner-body">
          <div class="run-banner-head">
            <span class="run-banner-state">
              running unattended
              {run.turn > 0 && ` — turn ${run.turn}${budget.length > 0 ? ` ${budget.join(' ')}` : ''}`}
              {elapsed !== null && ` · ${elapsed}`}
            </span>
            {state.pendingDecisions > 0 && (
              <span class="run-banner-parked">
                {state.pendingDecisions} decision{state.pendingDecisions === 1 ? '' : 's'} parked
              </span>
            )}
          </div>
          {run.task !== '' && <div class="run-banner-task" title={run.task}>{run.task}</div>}
        </div>
        <button
          class="btn btn-small"
          onClick={() => client.call('run.stop', {}).catch(() => { /* it ends on its own signal */ })}
          title="Finish the current turn, then stop"
        >
          Stop
        </button>
      </div>
    )
  }

  if (state.lastRun !== null) {
    const r = state.lastRun
    const clean = r.stoppedBecause === 'done'
    return (
      <div class={`run-banner run-banner-ended ${clean ? '' : 'run-banner-attention'}`} role="status">
        <span class="run-banner-endmark" aria-hidden="true">
          {clean ? Icon.check() : Icon.alert()}
        </span>
        <div class="run-banner-body">
          <div class="run-banner-head">
            <span class="run-banner-state">
              run ended: {r.stoppedBecause} after {r.turns} turn{r.turns === 1 ? '' : 's'}
            </span>
          </div>
          {r.detail !== '' && <div class="run-banner-task">{r.detail}</div>}
        </div>
        <button
          class="icon-button"
          onClick={() => dispatch({ type: 'run-dismissed' })}
          title="Dismiss"
        >
          {Icon.x()}
        </button>
      </div>
    )
  }

  return null
}
