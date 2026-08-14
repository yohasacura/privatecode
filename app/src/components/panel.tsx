import type { ComponentChildren, VNode } from 'preact'
import { Icon } from './icons'

/**
 * The vocabulary of the right column.
 *
 * The transcript has a design: one gutter, one text edge, cards that all sit the same way.
 * The panels beside it had none — five tabs written at five different times, each inventing
 * its own row, its own empty state and its own idea of how much air a list needs. Read one
 * after another they look like five applications, and that is the difference the eye picks
 * up as "unfinished" long before it can name a single wrong pixel.
 *
 * So there is exactly one row here and exactly one empty state, and every list in the column
 * is built from them. The point is not reuse for its own sake — it is that a change to how a
 * row reads is one edit, and that a new tab cannot drift.
 */

/**
 * What a list says when it has nothing to say.
 *
 * Centred in the space it is given, because these panels are 700px tall and a sentence
 * pinned to the top-left corner of that much emptiness is the single strongest "unfinished"
 * signal in the app. `hint` is for the thing the user cannot guess: what would have to
 * happen for this list to have entries.
 */
export function PanelEmpty({
  icon, title, hint,
}: {
  icon: VNode
  title: string
  hint?: string
}): VNode {
  return (
    <div class="panel-empty">
      <div class="panel-empty-mark" aria-hidden="true">{icon}</div>
      <div class="panel-empty-title">{title}</div>
      {hint !== undefined && <div class="panel-empty-hint">{hint}</div>}
    </div>
  )
}

/** A failure that the user can do something about: click it and it tries again. */
export function PanelError({ message, onRetry }: { message: string; onRetry?: () => void }): VNode {
  if (onRetry === undefined) return <div class="panel-error">{message}</div>
  return (
    <button class="panel-error panel-error-retry" onClick={onRetry}>
      {message} <span class="dim">— click to retry</span>
    </button>
  )
}

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
  return (
    <div class={`prow ${tone === 'bad' ? 'prow-bad' : ''}`}>
      <div class="prow-head">
        <span class="prow-lead">
          {onToggle !== undefined && (
            <button
              class="prow-toggle"
              onClick={onToggle}
              title={open === true ? 'Collapse' : 'Expand'}
              aria-expanded={open === true}
            >
              {open === true ? Icon.chevronDown() : Icon.chevronRight()}
            </button>
          )}
        </span>
        {icon !== undefined && <span class="prow-icon">{icon}</span>}
        {onOpen === undefined
          ? <span class={`prow-label ${mono === true ? 'prow-mono' : ''}`} title={title}>{label}</span>
          : (
            <button
              class={`prow-label prow-label-button ${mono === true ? 'prow-mono' : ''}`}
              onClick={onOpen}
              title={title}
            >
              {label}
            </button>
            )}
        {meta !== undefined && <span class="prow-meta">{meta}</span>}
        {actions !== undefined && <span class="prow-actions">{actions}</span>}
      </div>
      {open === true && children !== undefined && <div class="prow-body">{children}</div>}
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
  title, count, subtitle, children,
}: {
  title: string
  /** Rendered beside the title when there is something to count. */
  count?: number
  /** The path every row below shares, said once instead of on every line. Monospace,
   * because it is a path and the rows under it are too. */
  subtitle?: string
  children: ComponentChildren
}): VNode {
  return (
    <section class="psection">
      <div class="psection-head">
        <span class="psection-title">{title}</span>
        {count !== undefined && count > 0 && <span class="psection-count">{count}</span>}
        {subtitle !== undefined && subtitle !== '' && (
          <span class="psection-sub" title={subtitle}>{subtitle}/</span>
        )}
      </div>
      {children}
    </section>
  )
}

/**
 * The directory heading inside a grouped list.
 *
 * Not a `PanelRow`: a row is something you can open, revert or tick, and this is a label.
 * Making it a row would put a chevron column and an action column on a line that has
 * neither, which is the kind of borrowed structure that makes a column look busy without
 * carrying anything.
 */
export function PanelGroupHead({
  dir, fullDir, meta,
}: {
  dir: string
  fullDir: string
  meta?: ComponentChildren
}): VNode | null {
  // Everything shares one directory, so it is already in the section subtitle; a heading
  // here would repeat it and separate nothing from nothing.
  if (dir === '') return null
  return (
    <div class="pgroup" title={fullDir}>
      <span class="pgroup-dir">{dir}</span>
      {meta !== undefined && <span class="pgroup-meta">{meta}</span>}
    </div>
  )
}
