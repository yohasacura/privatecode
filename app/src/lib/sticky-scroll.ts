import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { RefObject } from 'preact'

/**
 * Follow-the-stream scrolling, with an escape hatch.
 *
 * The old transcript had none of this: it simply grew, so watching a turn meant chasing it
 * with the scrollbar. The rule here is the one every chat client converges on — stay pinned
 * to the bottom while the user is already at the bottom, and the moment they scroll UP to
 * read something, stop moving the view out from under them and offer a way back.
 *
 * `atBottom` is deliberately fuzzy (`THRESHOLD` px): a streaming token can land between the
 * scroll event and the measurement, and an exact comparison would unpin the view at random.
 */

const THRESHOLD = 48

export function useStickToBottom(
  ref: RefObject<HTMLElement>,
  /** Anything that changes when new content arrives (item count, streamed length). */
  signal: unknown,
): { stuck: boolean; scrollToBottom: () => void } {
  const [stuck, setStuck] = useState(true)
  // Read inside the layout effect without making it a dependency: re-subscribing the
  // scroll listener on every state flip would drop events mid-stream.
  const stuckRef = useRef(true)
  stuckRef.current = stuck

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    setStuck(true)
  }, [ref])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    function onScroll(): void {
      const node = ref.current
      if (!node) return
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight
      setStuck(distance <= THRESHOLD)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref])

  useEffect(() => {
    const el = ref.current
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight
  }, [ref, signal])

  return { stuck, scrollToBottom }
}
