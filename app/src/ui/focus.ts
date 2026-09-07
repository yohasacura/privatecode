/**
 * Focus, handled the way the primitives need it: what can be tabbed to inside an element,
 * keeping the tab cycle inside a dialog, and putting focus back where it came from.
 *
 * Pure functions over a container so they are testable under happy-dom; the components
 * call them from effects.
 */

const TABBABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',')

/** Elements a Tab press can reach, in document order. */
export function tabbables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) =>
    !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true' && el.tabIndex >= 0)
}

/**
 * Keeps Tab and Shift+Tab inside `container`. Returns the key handler to attach to the
 * container's keydown. Wraps at both ends; with nothing tabbable inside, focus stays on
 * the container itself (which the caller makes focusable with tabindex="-1").
 */
export function trapTab(container: HTMLElement): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return
    const items = tabbables(container)
    if (items.length === 0) {
      e.preventDefault()
      container.focus()
      return
    }
    const first = items[0]!
    const last = items[items.length - 1]!
    const active = container.ownerDocument.activeElement
    if (e.shiftKey && (active === first || active === container)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }
}

/**
 * Focuses `el`, and again a moment later if the first call was dropped.
 *
 * Chromium refuses a `focus()` for the first few milliseconds after an element appears:
 * the call returns, nothing is focused, no error is raised. A menu or a popover focusing
 * its first control from the effect that follows its mount was, in the live window,
 * focusing nothing — the row that had been right-clicked kept focus and the arrow keys
 * went to it — while a DOM without layout (the tests) focused it every time. Measured on
 * the packaged app: refused up to ~6 ms after the element was inserted, accepted from
 * ~8 ms on; the effect ran at 2–5 ms. So: try now, and try again after a frame or two.
 * Returns a cancel for the retries, for the effect's cleanup.
 */
export function focusWhenReady(el: HTMLElement, delays: readonly number[] = [16, 48, 120]): () => void {
  el.focus()
  if (el.ownerDocument.activeElement === el) return () => {}
  const timers = delays.map((ms) => setTimeout(() => {
    if (el.isConnected && el.ownerDocument.activeElement !== el) el.focus()
  }, ms))
  return () => { for (const t of timers) clearTimeout(t) }
}

/**
 * Focus the first tabbable inside `container` (or the one marked `data-autofocus`), or the
 * container itself. Called when a dialog or menu opens. Returns a cancel for the retries
 * (see `focusWhenReady`); a caller with no cleanup to hang it on may ignore it.
 */
export function focusFirst(container: HTMLElement): () => void {
  const preferred = container.querySelector<HTMLElement>('[data-autofocus]')
  const target = preferred ?? tabbables(container)[0] ?? container
  return focusWhenReady(target)
}

/** The element to hand focus back to when an overlay closes: what had it before. */
export function rememberFocus(doc: Document = document): () => void {
  const previous = doc.activeElement as HTMLElement | null
  return () => {
    if (previous !== null && previous.isConnected && typeof previous.focus === 'function') previous.focus()
  }
}
