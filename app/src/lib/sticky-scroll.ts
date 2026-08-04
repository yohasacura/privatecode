import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { RefObject } from 'preact'

/**
 * Follow-the-stream scrolling.
 *
 * The rule every chat client converges on: stay pinned to the bottom while the reader is
 * already at the bottom, and the moment they scroll UP to read something, stop moving the
 * view out from under them and offer a way back.
 *
 * Two things make this version work where the first one did not.
 *
 * **Growth is OBSERVED, not predicted.** The original took a caller-computed "signal"
 * string — item count plus the length of the last item's text — and re-pinned when it
 * changed. That signal is blind to most of what actually changes the height: a tool
 * result arriving (the tallest content there is: a diff, or 160 lines of command output)
 * does not change the item count and is not text on the last item, so the view simply sat
 * still while a screenful appeared below it. So did expanding a card, "show N more lines",
 * the task list appearing, and a font finishing loading. A `MutationObserver` on the
 * scroll container catches all of them without anyone having to enumerate them.
 *
 * **Only a person can unpin.** Deciding "the user scrolled away" from scroll events alone
 * is unreliable: our own pinning fires scroll events too, and a mis-timed one latches the
 * view off permanently — which is the other half of "I keep having to scroll down myself".
 * Unpinning is therefore driven by input the user actually produces — a wheel turned up, a
 * scrollbar dragged, PageUp/Home — none of which a programmatic scroll can fake. Reaching
 * the bottom by any means re-pins.
 */

/** How close to the bottom still counts as "at the bottom". A streamed token can land
 * between a scroll event and its measurement, so an exact comparison would unpin at random. */
const THRESHOLD = 64

const NAV_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'])

export function useStickToBottom(ref: RefObject<HTMLElement>): {
  stuck: boolean
  scrollToBottom: () => void
} {
  const [stuck, setStuck] = useState(true)
  // Read inside listeners that must not be re-subscribed every time the flag flips.
  const stuckRef = useRef(true)
  stuckRef.current = stuck
  /** True while a pointer is held down inside the container -- i.e. a scrollbar drag or a
   * text selection that is dragging the view. */
  const dragging = useRef(false)

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    setStuck(true)
  }, [ref])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const atBottom = (): boolean =>
      el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD

    // Re-pins whenever the view reaches the bottom, whoever put it there. Never unpins:
    // that is what the intent handlers below are for.
    function onScroll(): void {
      if (atBottom()) setStuck(true)
      else if (dragging.current) setStuck(false)
    }

    function onWheel(e: WheelEvent): void {
      // Any upward wheel is an explicit "I want to look back", even mid-stream.
      if (e.deltaY < 0) setStuck(false)
    }

    function onKeyDown(e: KeyboardEvent): void {
      // Home/ArrowUp inside the approval card's comment field are TEXT navigation, not a
      // request to scroll the transcript -- and unpinning there is sticky: nothing re-pins
      // until a scroll event, which growing content alone does not produce.
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
                     target.tagName === 'SELECT' || target.isContentEditable)) {
        return
      }
      if (NAV_KEYS.has(e.key)) setStuck(false)
    }

    function onPointerDown(): void { dragging.current = true }
    function onPointerUp(): void { dragging.current = false }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointerup', onPointerUp, { passive: true })

    // One pin per frame however many mutations arrived: a streamed answer produces
    // hundreds of them per second and they all want the same single scrollTop write.
    let frame = 0
    const observer = new MutationObserver(() => {
      if (!stuckRef.current || frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const node = ref.current
        if (node && stuckRef.current) node.scrollTop = node.scrollHeight
      })
    })
    observer.observe(el, { childList: true, subtree: true, characterData: true })

    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      observer.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [ref])

  return { stuck, scrollToBottom }
}
