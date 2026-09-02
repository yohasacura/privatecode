import { useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Check, TriangleAlert, X } from 'lucide-preact'
import type { ProtocolClient } from '../lib/client'
import type { ChatAction, ChatState } from '../lib/state'
import { formatDuration } from '../lib/format'
import { Button, IconButton } from '../ui/button'
import { Chip } from '../ui/chip'
import { cn } from '../ui/cn'

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

const CARD = 'flex items-start gap-2.5 rounded-md border px-3 py-2.5 font-ui text-[12.5px] leading-[1.45]'

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
    if (run.maxHours !== undefined) budget.push(`· ${run.maxHours} h budget`)
    return (
      <div data-run="running" role="status" class={cn(CARD, 'border-accent-line bg-panel')}>
        <span class="pulse-dot mt-1.5" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-2.5">
            <span class="font-semibold text-fg tabular-nums">
              running unattended
              {run.turn > 0 && ` — turn ${run.turn}${budget.length > 0 ? ` ${budget.join(' ')}` : ''}`}
              {elapsed !== null && ` · ${elapsed}`}
            </span>
            {state.pendingDecisions > 0 && (
              <Chip tone="accent">
                {state.pendingDecisions} decision{state.pendingDecisions === 1 ? '' : 's'} parked
              </Chip>
            )}
          </div>
          {/* The task verbatim, clamped: it distinguishes "it is working" from "it is
              working on the wrong thing", and three lines is enough to tell. */}
          {run.task !== '' && <div class="mt-1 line-clamp-3 text-[12px] text-dim" title={run.task}>{run.task}</div>}
        </div>
        <Button
          size="sm"
          onClick={() => client.call('run.stop', {}).catch(() => { /* it ends on its own signal */ })}
          title="Finish the current turn, then stop"
          data-action="stop-run"
        >
          Stop
        </Button>
      </div>
    )
  }

  if (state.lastRun !== null) {
    const r = state.lastRun
    const clean = r.stoppedBecause === 'done'
    // Anything but a clean "done" keeps the accent frame: "stopped: error" must not present
    // itself with the same calm as a finished job.
    return (
      <div
        data-run={clean ? 'done' : 'attention'}
        role="status"
        class={cn(CARD, clean ? 'border-border bg-raised' : 'border-accent-line bg-accent-soft')}
      >
        <span class={cn('mt-px inline-flex shrink-0 [&>svg]:size-4', clean ? 'text-dim' : 'text-accent')} aria-hidden="true">
          {clean ? <Check /> : <TriangleAlert />}
        </span>
        <div class="min-w-0 flex-1">
          <div class="font-semibold text-fg tabular-nums">
            run ended: {r.stoppedBecause} after {r.turns} turn{r.turns === 1 ? '' : 's'}
          </div>
          {r.detail !== '' && <div class="mt-1 line-clamp-3 text-[12px] text-dim">{r.detail}</div>}
        </div>
        <IconButton size="sm" label="Dismiss" onClick={() => dispatch({ type: 'run-dismissed' })}><X /></IconButton>
      </div>
    )
  }

  return null
}
