import { cloneElement, type VNode } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { cn } from './cn'
import { LAYER, Portal, useEscape, useFloating, useId } from './overlay'
import type { Side } from './position'

/**
 * One sentence beside a control, on hover or keyboard focus. The child is cloned with the
 * handlers and an `aria-describedby`, so the sentence is read out as well as shown. Opens
 * after a short delay (a pointer crossing the bar must not light every button), closes at
 * once; Escape closes; never shown for a disabled child's title (the browser does that).
 */
export function Tooltip({ text, side = 'top', delay = 400, children }: {
  text: string
  side?: Side
  delay?: number
  children: VNode
}): VNode {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useId('tip')
  const pos = useFloating(anchor, tip, open, { side, align: 'center', gap: 6 })

  const show = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), delay)
  }, [delay])
  const hide = useCallback(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
    setOpen(false)
  }, [])
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  useEscape(open, hide)

  const child = cloneElement(children, {
    ref: anchor,
    'aria-describedby': open ? id : undefined,
    onPointerEnter: show,
    onPointerLeave: hide,
    onFocus: show,
    onBlur: hide,
  } as Record<string, unknown>)

  return (
    <>
      {child}
      {open && (
        <Portal>
          <div
            ref={tip}
            id={id}
            role="tooltip"
            class={cn(
              'fixed pointer-events-none max-w-[280px] px-2 py-1 rounded-sm border border-border bg-raised text-fg',
              'text-[12px] leading-[1.4] shadow-(--shadow-sm) font-ui',
              'motion-safe:animate-[tip-in_var(--duration-fast)_var(--ease-enter)]',
              LAYER.tooltip,
              pos === null && 'invisible',
            )}
            style={pos === null ? undefined : { left: `${pos.x}px`, top: `${pos.y}px` }}
          >
            {text}
          </div>
        </Portal>
      )}
    </>
  )
}
