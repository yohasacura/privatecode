import type { ComponentChildren, VNode } from 'preact'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-preact'
import { Button, IconButton } from '../ui/button'
import { cn } from '../ui/cn'

/**
 * The vocabulary of the right column (docs/UI-REDESIGN-2026-09.md §7).
 *
 * The transcript has a design: one gutter, one text edge, cards that all sit the same way.
 * The panels beside it had none — five tabs written at five different times, each inventing
 * its own row, its own empty state and its own idea of how much air a list needs. Read one
 * after another they look like five applications, and that is the difference the eye picks
 * up as "unfinished" long before it can name a single wrong pixel.
 *
 * So there is exactly one row here, one empty state, one error, one loading line and one
 * note, and every list in the column is built from them. The point is not reuse for its own
 * sake — it is that a change to how a row reads is one edit, and that a new tab cannot drift.
 */

/**
 * What a list says when it has nothing to say.
 *
 * Centred in the space it is given, because these panels are 700px tall and a sentence
 * pinned to the top-left corner of that much emptiness is the single strongest "unfinished"
 * signal in the app. `hint` is for the thing the user cannot guess: what would have to
 * happen for this list to have entries. `action` is for the one thing they can do about it.
 */
export function PanelEmpty({
  icon, title, hint, action,
}: {
  icon: VNode
  title: string
  hint?: string
  action?: VNode
}): VNode {
  return (
    <div
      data-panel="empty"
      class="flex min-h-[150px] flex-1 flex-col items-center justify-center gap-2 px-6 py-6 text-center font-ui text-faint"
    >
      <div class="flex text-border-strong [&>svg]:size-[22px] [&>.icon]:size-[22px]" aria-hidden="true">{icon}</div>
      <div class="text-[12.5px] text-dim">{title}</div>
      {hint !== undefined && <div class="max-w-[32ch] text-[11.5px] leading-[1.5]">{hint}</div>}
      {action !== undefined && <div class="mt-1">{action}</div>}
    </div>
  )
}

/** A failure said in place, with the one thing to do about it when there is one. */
export function PanelError({ message, onRetry }: { message: string; onRetry?: () => void }): VNode {
  return (
    <div
      role="alert"
      data-panel="error"
      class="mx-2.5 my-2 flex flex-col gap-1.5 rounded-md border border-red-line bg-red-soft px-3 py-2 font-ui text-[12px] text-red"
    >
      <span class="break-words">{message}</span>
      {onRetry !== undefined && (
        <Button size="sm" class="self-start" icon={<RefreshCw />} onClick={onRetry}>Retry</Button>
      )}
    </div>
  )
}

/** One quiet line while a list is on its way. */
export function PanelLoading({ what = 'loading…' }: { what?: string }): VNode {
  return (
    <div data-panel="loading" class="px-3.5 py-4 font-ui text-[12.5px] text-faint motion-safe:animate-pulse">
      {what}
    </div>
  )
}

const NOTE_TONE = {
  neutral: 'border-border-soft bg-raised text-fg',
  good: 'border-green-line bg-green-soft text-green',
  bad: 'border-red-line bg-red-soft text-red',
  warn: 'border-yellow-line bg-yellow-soft text-fg',
} as const

/** A sentence the panel wants to say between its lists: an outcome, a hint, a caveat. */
export function PanelNote({
  tone = 'neutral', inset = false, title, class: klass, children,
}: {
  tone?: keyof typeof NOTE_TONE
  /** Inside a box that already has its own margins: no outer air. */
  inset?: boolean
  title?: string
  class?: string
  children: ComponentChildren
}): VNode {
  return (
    <div
      data-panel="note"
      data-tone={tone}
      title={title}
      class={cn('rounded-md border px-2.5 py-2 font-ui text-[12.5px] leading-[1.5]', !inset && 'mx-2 my-2', NOTE_TONE[tone], klass)}
    >
      {children}
    </div>
  )
}

const LABEL = 'min-w-0 flex-1 truncate text-left font-ui text-[12.5px]'
const MONO = 'font-mono text-[11.5px]'

/**
 * One row, for every list in the column.
 *
 * The anatomy is fixed and the alignment comes from it: a leading control column that is
 * always the same width whether or not the row expands, then the icon, then the label that
 * takes what is left, then facts, then controls. Rows in different tabs therefore line up
 * with each other, which is most of what makes a column read as one instrument.
 *
 * `onOpen` and `onToggle` are deliberately separate. A row that both expands in place and
 * navigates somewhere else must never make those the same click — the Changes tab learned
 * that when clicking a path to read its diff opened the file instead.
 */
export function PanelRow({
  open, onToggle, icon, label, mono, meta, actions, onOpen, title, tone, children,
}: {
  /** Present iff the row can expand; drives the chevron. */
  open?: boolean
  onToggle?: () => void
  icon?: VNode
  label: ComponentChildren
  /** Monospace label — paths, commands, ids. Prose stays in the UI face. */
  mono?: boolean
  /** Small facts, right-aligned before the controls: stats, counts, states. */
  meta?: ComponentChildren
  /** Buttons. The only other focusable things in the row. */
  actions?: ComponentChildren
  /** Makes the label itself activate something (open a file, select an entry). */
  onOpen?: () => void
  title?: string
  tone?: 'bad'
  /** The expanded body, rendered under the row and aligned to the label's left edge. */
  children?: ComponentChildren
}): VNode {
  const colour = tone === 'bad' ? 'text-red' : 'text-dim'
  return (
    <div data-panel-row="" data-open={open === true ? '' : undefined} class="border-b border-border-soft last:border-b-0">
      <div class="flex min-h-7 items-center gap-2 py-1 pl-1 pr-2.5 transition-colors duration-(--duration-fast) hover:bg-raised">
        <span class="flex w-[18px] shrink-0 justify-center">
          {onToggle !== undefined && (
            <IconButton
              size="sm"
              class="size-[18px] [&>svg]:size-3"
              label={open === true ? 'Collapse' : 'Expand'}
              aria-expanded={open === true}
              onClick={onToggle}
            >
              {open === true ? <ChevronDown /> : <ChevronRight />}
            </IconButton>
          )}
        </span>
        {icon !== undefined && (
          <span class="flex shrink-0 text-faint [&>svg]:size-[13px] [&>.icon]:size-[13px]">{icon}</span>
        )}
        {onOpen === undefined
          ? <span class={cn(LABEL, colour, mono === true && MONO)} title={title}>{label}</span>
          : (
            <button
              type="button"
              class={cn(LABEL, colour, mono === true && MONO, 'cursor-pointer border-0 bg-transparent p-0 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent')}
              onClick={onOpen}
              title={title}
            >
              {label}
            </button>
            )}
        {meta !== undefined && (
          <span class="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] text-faint tabular-nums">{meta}</span>
        )}
        {actions !== undefined && <span class="flex shrink-0 items-center gap-1">{actions}</span>}
      </div>
      {/* Aligned to the label's left edge, not the row's: an expanded diff that started under
          the chevron read as a separate block rather than as this row's detail. */}
      {open === true && children !== undefined && (
        <div class="pb-2.5 pl-[45px] pr-2.5 pt-0.5">{children}</div>
      )}
    </div>
  )
}

/**
 * A titled group inside a tab, for the case where one tab honestly holds two lists —
 * Terminal's running processes above its command history, History's checkpoints above the
 * work log. Without it those become two undifferentiated stacks and the reader has to infer
 * the boundary from the content.
 */
export function PanelSection({
  title, count, subtitle, actions, children,
}: {
  title: string
  /** Rendered beside the title when there is something to count. */
  count?: number
  /** The path every row below shares, said once instead of on every line. Monospace,
   * because it is a path and the rows under it are too. */
  subtitle?: string
  /** Controls for the whole list, at the right of its title. */
  actions?: ComponentChildren
  children: ComponentChildren
}): VNode {
  return (
    <section data-panel="section" class="flex flex-col">
      <div class="flex items-center gap-1.5 px-2.5 pb-1 pt-2.5">
        <span class="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">{title}</span>
        {count !== undefined && count > 0 && <span class="font-mono text-[10.5px] text-faint">{count}</span>}
        {subtitle !== undefined && subtitle !== '' && (
          <span class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint" dir="rtl" title={subtitle}>
            <span dir="ltr">{subtitle}/</span>
          </span>
        )}
        {actions !== undefined && <span class="ml-auto flex items-center gap-1">{actions}</span>}
      </div>
      {children}
    </section>
  )
}
