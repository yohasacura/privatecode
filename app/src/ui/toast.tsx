import type { VNode } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { AlertTriangle, Check, Info, X } from 'lucide-preact'
import { IconButton } from './button'
import { cn } from './cn'
import { LAYER, Portal } from './overlay'

export type ToastTone = 'neutral' | 'success' | 'error'

export interface ToastInput {
  title: string
  description?: string
  tone?: ToastTone
  /** One action, as a link-styled button: "Undo", "Open". */
  action?: { label: string; onClick: () => void }
  /** Milliseconds before it goes by itself; 0 keeps it until dismissed. */
  duration?: number
}

interface ToastRecord extends ToastInput { id: number }

const MAX_VISIBLE = 3
const DEFAULT_MS = 4000

let records: ToastRecord[] = []
let nextId = 1
const listeners = new Set<(list: readonly ToastRecord[]) => void>()
const notify = (): void => { for (const l of listeners) l(records) }

/** The clock of each toast lives in the store, not in the card: a toast queued behind the
 * three on screen still expires on time instead of appearing, stale, when they leave. */
const clocks = new Map<number, { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number }>()

function start(id: number, ms: number): void {
  const handle = setTimeout(() => toast.dismiss(id), ms)
  clocks.set(id, { handle, remaining: ms, startedAt: Date.now() })
}

/**
 * Outcomes with nowhere else to go: copied, exported, restored, saved, an error from a
 * background job. Never for anything the transcript already says. Pushed from anywhere;
 * shown by the one `<Toaster />` in the shell.
 */
export const toast = {
  push(input: ToastInput): number {
    const id = nextId++
    records = [...records, { ...input, id }]
    const duration = input.duration ?? DEFAULT_MS
    if (duration > 0) start(id, duration)
    notify()
    return id
  },
  dismiss(id: number): void {
    const clock = clocks.get(id)
    if (clock?.handle !== null && clock?.handle !== undefined) clearTimeout(clock.handle)
    clocks.delete(id)
    if (!records.some((r) => r.id === id)) return
    records = records.filter((r) => r.id !== id)
    notify()
  },
  /** The pointer is over the card: the clock stops until it leaves. */
  hold(id: number): void {
    const clock = clocks.get(id)
    if (clock === undefined || clock.handle === null) return
    clearTimeout(clock.handle)
    clock.remaining = Math.max(500, clock.remaining - (Date.now() - clock.startedAt))
    clock.handle = null
  },
  release(id: number): void {
    const clock = clocks.get(id)
    if (clock === undefined || clock.handle !== null) return
    clock.startedAt = Date.now()
    clock.handle = setTimeout(() => toast.dismiss(id), clock.remaining)
  },
  clear(): void {
    for (const c of clocks.values()) if (c.handle !== null) clearTimeout(c.handle)
    clocks.clear()
    records = []
    notify()
  },
  subscribe(fn: (list: readonly ToastRecord[]) => void): () => void {
    listeners.add(fn)
    fn(records)
    return () => { listeners.delete(fn) }
  },
}

const ICON: Record<ToastTone, VNode> = {
  neutral: <Info />,
  success: <Check />,
  error: <AlertTriangle />,
}
const TONE: Record<ToastTone, string> = {
  neutral: 'text-dim',
  success: 'text-green',
  error: 'text-red',
}

export function Toaster(): VNode | null {
  const [list, setList] = useState<readonly ToastRecord[]>([])
  useEffect(() => toast.subscribe(setList), [])
  const visible = list.slice(-MAX_VISIBLE)
  if (typeof document === 'undefined' || visible.length === 0) return null
  return (
    <Portal>
      <div
        class={cn('fixed bottom-4 right-4 flex flex-col gap-2 w-[340px] max-w-[calc(100vw-32px)] pointer-events-none', LAYER.toast)}
        aria-live="polite"
        aria-relevant="additions"
      >
        {visible.map((t) => <ToastCard key={t.id} record={t} />)}
      </div>
    </Portal>
  )
}

function ToastCard({ record }: { record: ToastRecord }): VNode {
  const tone = record.tone ?? 'neutral'
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => toast.hold(record.id)}
      onPointerLeave={() => toast.release(record.id)}
      class={cn(
        'pointer-events-auto flex items-start gap-2.5 rounded-md border border-border bg-panel px-3 py-2.5 text-fg shadow-(--shadow-pop)',
        'motion-safe:animate-[toast-in_var(--duration-normal)_var(--ease-enter)]',
      )}
    >
      <span class={cn('mt-0.5 inline-flex shrink-0 [&>svg]:size-4', TONE[tone])}>{ICON[tone]}</span>
      <div class="min-w-0 flex-1">
        <div class="text-[13px] font-medium leading-[1.4]">{record.title}</div>
        {record.description !== undefined && <div class="mt-0.5 text-[12px] text-dim leading-[1.4]">{record.description}</div>}
        {record.action !== undefined && (
          <button
            type="button"
            class="mt-1.5 border-0 bg-transparent p-0 text-[12px] font-medium text-accent cursor-pointer hover:underline"
            onClick={() => { record.action?.onClick(); toast.dismiss(record.id) }}
          >
            {record.action.label}
          </button>
        )}
      </div>
      <IconButton label="Dismiss" size="sm" onClick={() => toast.dismiss(record.id)}><X /></IconButton>
    </div>
  )
}
