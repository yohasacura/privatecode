import { describe, expect, it } from 'vitest'
import { VISIBLE_TAIL, visibleWindow } from './transcript'

/**
 * How much of a very long conversation is mounted.
 *
 * A turn used to stop at forty steps, so a session reached a few hundred rows and stopped.
 * With no step ceiling one turn can produce tens of thousands, and every row stayed in the
 * DOM forever — diffs and command output expanded by default, up to a hundred and sixty
 * lines each. Measured on this app's own preact: 9.4 ms of VNode diffing per frame at 25,000
 * items, and that is the cheaper half; the DOM and the layout forced on every frame by the
 * sticky-scroll hook are what actually stop the window responding.
 */
describe('visibleWindow', () => {
  const items = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

  it('mounts everything while a conversation is an ordinary size', () => {
    const { shown, hidden } = visibleWindow(items(50), false)
    expect(hidden).toBe(0)
    expect(shown).toHaveLength(50)
  })

  it('mounts everything at exactly the cap, so the bar never appears for nothing', () => {
    const { hidden } = visibleWindow(items(VISIBLE_TAIL), false)
    expect(hidden).toBe(0)
  })

  it('keeps the NEWEST rows, which are the ones being watched', () => {
    // The tail, not the head: a turn is read at the bottom, and the sticky-scroll hook holds
    // you there. Keeping the head would mount the part nobody is looking at.
    const { shown, hidden } = visibleWindow(items(VISIBLE_TAIL + 100), false)
    expect(hidden).toBe(100)
    expect(shown).toHaveLength(VISIBLE_TAIL)
    expect(shown[shown.length - 1]).toBe(VISIBLE_TAIL + 99)
    expect(shown[0]).toBe(100)
  })

  it('holds the cost flat however long the turn runs', () => {
    // The point of the cap. Ten thousand steps or ten, the window mounts the same number of
    // rows — the cost profile a few-hundred-row conversation always had.
    for (const n of [1_000, 10_000, 25_000]) {
      expect(visibleWindow(items(n), false).shown).toHaveLength(VISIBLE_TAIL)
    }
  })

  it('shows everything when asked, and admits nothing was hidden then', () => {
    const { shown, hidden } = visibleWindow(items(25_000), true)
    expect(hidden).toBe(0)
    expect(shown).toHaveLength(25_000)
  })

  it('reports the hidden count exactly, because the bar states it as a fact', () => {
    expect(visibleWindow(items(VISIBLE_TAIL + 1), false).hidden).toBe(1)
    expect(visibleWindow(items(VISIBLE_TAIL + 7_642), false).hidden).toBe(7_642)
  })

  it('is a no-op on an empty conversation', () => {
    expect(visibleWindow([], false)).toEqual({ shown: [], hidden: 0 })
  })
})
