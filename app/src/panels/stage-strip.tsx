import type { VNode } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { Check, CircleDashed, Eye, FileCheck2, Hammer, ListChecks, ScanSearch, ShieldCheck, Undo2, X } from 'lucide-preact'
import type { StageName, StageRecord } from '../lib/state'
import { cn } from '../ui/cn'

/**
 * The checks of a turn, one chip each, left to right in the order they run
 * (docs/UI-REDESIGN-2026-09.md §5 "The check-stage strip"). A chip says where its stage
 * is: pending is dim, running pulses and counts seconds, passed is green, handed back is
 * yellow with the count, failed is red, skipped says why. Hover for the detail the stage
 * reported. When the checks are off the strip is one dim chip, so the absence is visible.
 */

const ORDER: readonly StageName[] = ['contract', 'premises', 'understanding', 'build', 'acceptance', 'review']

const LABEL: Record<StageName, string> = {
  contract: 'Contract',
  premises: 'Premises',
  understanding: 'Understanding',
  build: 'Build',
  acceptance: 'Acceptance',
  review: 'Review',
}

const ICON: Record<StageName, VNode> = {
  contract: <FileCheck2 />,
  premises: <ListChecks />,
  understanding: <ScanSearch />,
  build: <Hammer />,
  acceptance: <ShieldCheck />,
  review: <Eye />,
}

const TONE: Record<StageRecord['state'], string> = {
  running: 'border-accent-line bg-accent-soft text-fg',
  passed: 'border-green-line bg-green-soft text-green',
  failed: 'border-red-line bg-red-soft text-red',
  'handed-back': 'border-yellow-line bg-yellow-soft text-yellow',
  skipped: 'border-border bg-transparent text-faint',
}

function seconds(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`
}

/** The short reading after the name: elapsed while running, the time it took, or why not. */
export function chipText(r: StageRecord, now: number): string {
  switch (r.state) {
    case 'running': return seconds(Math.max(0, now - r.startedAtMs))
    case 'passed': return r.ms !== undefined ? seconds(r.ms) : ''
    case 'failed': return r.outcome ?? 'failed'
    case 'handed-back': return r.outcome ?? 'handed back'
    case 'skipped': return r.outcome ?? 'skipped'
  }
}

export function StageStrip({ stages, checksOff, now: nowProp }: {
  stages: readonly StageRecord[]
  /** The gates are off for this session (`gateMode === 'manual'`). */
  checksOff: boolean
  /** The clock, for tests; the strip keeps its own otherwise. */
  now?: number
}): VNode | null {
  const running = stages.some((s) => s.state === 'running')
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setClock(Date.now())
    const id = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])
  const now = nowProp ?? clock

  if (stages.length === 0) {
    if (!checksOff) return null
    return (
      <div data-strip="off" class="font-ui text-[12px]">
        <span class={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 leading-[1.4]', TONE.skipped)}>
          <span class="inline-flex [&>svg]:size-3"><CircleDashed /></span>
          checks off — /check, /review
        </span>
      </div>
    )
  }

  const ordered = [...stages].sort((a, b) => ORDER.indexOf(a.stage) - ORDER.indexOf(b.stage))
  return (
    <ol data-strip="stages" aria-label="Checks" class="m-0 flex list-none flex-wrap items-center gap-1.5 p-0 font-ui text-[12px]">
      {ordered.map((r) => {
        const text = chipText(r, now)
        const glyph = r.state === 'running' ? <span class="pulse-dot" />
          : r.state === 'passed' ? <Check />
            : r.state === 'failed' ? <X />
              : r.state === 'handed-back' ? <Undo2 />
                : ICON[r.stage]
        return (
          <li
            key={r.stage}
            data-stage={r.stage}
            data-state={r.state}
            title={r.detail ?? r.outcome ?? LABEL[r.stage]}
            class={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 leading-[1.4]',
              'motion-safe:animate-[pop-in_var(--duration-normal)_var(--ease-enter)]',
              TONE[r.state],
            )}
          >
            <span class="inline-flex items-center [&>svg]:size-3">{glyph}</span>
            <span class="whitespace-nowrap">{LABEL[r.stage]}{r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}</span>
            {text !== '' && <span class="max-w-[28ch] truncate text-[11px] opacity-80 tabular-nums">{text}</span>}
          </li>
        )
      })}
    </ol>
  )
}
