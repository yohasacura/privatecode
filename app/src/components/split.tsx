import { useEffect, useRef } from 'preact/hooks'
import type { VNode } from 'preact'

/**
 * A draggable column divider.
 *
 * Pointer capture (not a document-level mousemove listener) is what makes the drag survive
 * the pointer leaving the 4px handle — which, at 4px, it does constantly. `min`/`max` clamp
 * the result so a column can never be dragged to a width it cannot render at; dragging it
 * to nothing is what the collapse buttons are for, and a column you cannot get back is a
 * bug, not a feature.
 */
export function Splitter({
  onResize, side, min, max, current,
}: {
  /** Called with the new width in px as the pointer moves. */
  onResize: (width: number) => void
  /** Which column this divider belongs to; decides the sign of the delta. */
  side: 'left' | 'right'
  min: number
  max: number
  current: number
}): VNode {
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null)
  // Read the live width during a drag without re-subscribing handlers to every pixel.
  const currentRef = useRef(current)
  currentRef.current = current

  useEffect(() => {
    // A drag that ends while the window is not focused (alt-tab mid-drag) would otherwise
    // leave the handle stuck to the pointer.
    function cancel(): void { dragging.current = null }
    window.addEventListener('blur', cancel)
    return () => window.removeEventListener('blur', cancel)
  }, [])

  function onPointerDown(e: PointerEvent): void {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragging.current = { startX: e.clientX, startWidth: currentRef.current }
  }

  function onPointerMove(e: PointerEvent): void {
    const drag = dragging.current
    if (!drag) return
    const delta = side === 'left' ? e.clientX - drag.startX : drag.startX - e.clientX
    onResize(Math.min(max, Math.max(min, drag.startWidth + delta)))
  }

  function onPointerUp(e: PointerEvent): void {
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    dragging.current = null
  }

  return (
    <div
      class="splitter"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  )
}
