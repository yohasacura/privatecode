import type { ComponentChildren, RefObject, VNode } from 'preact'
import { useCallback, useEffect, useRef } from 'preact/hooks'
import { cn } from './cn'
import { focusFirst, rememberFocus, trapTab } from './focus'
import { LAYER, Portal, useEscape, useFloating, useOutsidePointerDown } from './overlay'
import type { Align, Side } from './position'

/**
 * A small panel anchored to a control: the workspace switcher, the "Always…" scope choice,
 * the run budget. Controlled (`open`/`onOpenChange`) so the trigger can be anything.
 * Focus moves inside when it opens and returns to the trigger when it closes; Tab stays
 * inside; a pointer-down outside or Escape closes it.
 */
export function Popover({ open, onOpenChange, anchor, side = 'bottom', align = 'start', label, class: klass, children }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor: RefObject<HTMLElement>
  side?: Side
  align?: Align
  /** The panel's accessible name. */
  label: string
  class?: string
  children: ComponentChildren
}): VNode | null {
  const panel = useRef<HTMLDivElement>(null)
  const pos = useFloating(anchor, panel, open, { side, align })
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  useOutsidePointerDown([panel, anchor], open, close)
  useEscape(open, close)

  useEffect(() => {
    if (!open || panel.current === null) return
    const restore = rememberFocus()
    focusFirst(panel.current)
    return restore
  }, [open])

  if (!open) return null
  return (
    <Portal>
      <div
        ref={panel}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(e) => { if (panel.current !== null) trapTab(panel.current)(e) }}
        class={cn(
          'fixed min-w-[200px] max-w-[360px] rounded-md border border-border bg-panel text-fg shadow-(--shadow-pop) outline-none',
          'motion-safe:animate-[pop-in_var(--duration-normal)_var(--ease-enter)]',
          LAYER.popover,
          pos === null && 'invisible',
          klass,
        )}
        style={pos === null ? undefined : { left: `${pos.x}px`, top: `${pos.y}px` }}
      >
        {children}
      </div>
    </Portal>
  )
}
