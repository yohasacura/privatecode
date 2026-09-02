import type { ComponentChildren, RefObject, VNode } from 'preact'
import { createPortal } from 'preact/compat'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { place, type Align, type Side } from './position'

/**
 * The floor every floating thing stands on: a portal into `document.body`, a position
 * computed from the anchor, and the layering order written in one place.
 *
 *   tooltip < popover and menu < dialog < toast
 *
 * so a tooltip never covers a menu, a menu never covers a dialog, and a toast is visible
 * over everything, which is the point of a toast.
 */
export const LAYER = {
  tooltip: 'z-40',
  popover: 'z-50',
  dialog: 'z-[60]',
  toast: 'z-[70]',
} as const

export function Portal({ children }: { children: ComponentChildren }): VNode | null {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}

/**
 * Where to put a floating element beside `anchor`, recomputed when it opens and on every
 * resize or scroll while it is open. Returns `null` until the floating element has been
 * measured, so the first paint is at the right place rather than a jump.
 */
export function useFloating(
  anchor: RefObject<HTMLElement>,
  floating: RefObject<HTMLElement>,
  open: boolean,
  opts: { side?: Side; align?: Align; gap?: number } = {},
): { x: number; y: number; side: Side } | null {
  const [pos, setPos] = useState<{ x: number; y: number; side: Side } | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const update = (): void => {
      const a = anchor.current
      const f = floating.current
      if (a === null || f === null) return
      const r = a.getBoundingClientRect()
      const fr = f.getBoundingClientRect()
      setPos(place(
        { x: r.left, y: r.top, width: r.width, height: r.height },
        { width: fr.width, height: fr.height },
        { width: window.innerWidth, height: window.innerHeight },
        optsRef.current,
      ))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchor, floating])

  return pos
}

/**
 * Calls `onOutside` for a pointer-down outside every element in `insides`, while `active`.
 * A pointer-down, not a click: a click that started inside and ended outside (a drag out
 * of a menu) must not close it.
 */
export function useOutsidePointerDown(
  insides: RefObject<HTMLElement>[],
  active: boolean,
  onOutside: () => void,
): void {
  useEffect(() => {
    if (!active) return
    const handler = (e: PointerEvent): void => {
      const target = e.target as Node | null
      if (target === null) return
      if (insides.some((r) => r.current?.contains(target))) return
      onOutside()
    }
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [active, insides, onOutside])
}

/** Escape closes, while `active`; the handler is on the document so focus need not be inside. */
export function useEscape(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); onEscape() }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [active, onEscape])
}

let idCounter = 0
/** A stable id for aria wiring, once per mounted component. */
export function useId(prefix: string): string {
  const ref = useRef<string | null>(null)
  if (ref.current === null) ref.current = `${prefix}-${++idCounter}`
  return ref.current
}
