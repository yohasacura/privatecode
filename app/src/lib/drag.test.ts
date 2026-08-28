import { afterEach, expect, test, vi } from 'vitest'
import {
  DRAG_THRESHOLD_PX, beginPathDrag, endPathDrag, movePathDrag, pathDrag, subscribePathDrag, within,
} from './drag'

/**
 * The store behind dragging a file row onto the composer.
 *
 * Worth testing on its own because the two ends never meet: the tree writes, the composer
 * reads, and the only thing joining them is this module. A silent failure here is a drag
 * that visibly picks a file up and then does nothing when it lands.
 */

afterEach(() => { endPathDrag() })

test('nothing is in flight to begin with', () => {
  expect(pathDrag()).toBeNull()
})

test('a drag carries its paths and its position', () => {
  beginPathDrag(['src/a.ts'], 10, 20)
  expect(pathDrag()).toEqual({ paths: ['src/a.ts'], x: 10, y: 20 })
})

test('moving updates the position and keeps the paths', () => {
  beginPathDrag(['src/a.ts'], 10, 20)
  movePathDrag(50, 60)
  expect(pathDrag()).toEqual({ paths: ['src/a.ts'], x: 50, y: 60 })
})

test('moving with nothing in flight is a no-op, not a resurrection', () => {
  // The tree's pointerup ends the drag AFTER the composer's capture-phase listener has
  // read it. If a late move could recreate one, a completed drop would leave a chip stuck
  // under the cursor with no way to release it.
  movePathDrag(5, 5)
  expect(pathDrag()).toBeNull()
})

test('ending returns what was carried, once', () => {
  beginPathDrag(['a', 'b'], 0, 0)
  expect(endPathDrag()).toEqual(['a', 'b'])
  expect(endPathDrag()).toBeNull()
})

test('an empty path list does not start a drag', () => {
  beginPathDrag([], 1, 1)
  expect(pathDrag()).toBeNull()
})

test('the paths are copied, so the caller cannot mutate a drag in flight', () => {
  const paths = ['src/a.ts']
  beginPathDrag(paths, 0, 0)
  paths.push('src/secret.ts')
  expect(pathDrag()?.paths).toEqual(['src/a.ts'])
})

test('a subscriber hears the current state immediately', () => {
  beginPathDrag(['src/a.ts'], 1, 2)
  const seen: unknown[] = []
  const off = subscribePathDrag((d) => seen.push(d))
  // A component that mounts mid-drag must not be blind until the next pointermove.
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ paths: ['src/a.ts'] })
  off()
})

test('a subscriber hears every move and the end', () => {
  const seen: (string | null)[] = []
  const off = subscribePathDrag((d) => seen.push(d === null ? null : `${d.x},${d.y}`))
  beginPathDrag(['a'], 1, 1)
  movePathDrag(2, 2)
  endPathDrag()
  off()
  expect(seen).toEqual([null, '1,1', '2,2', null])
})

test('unsubscribing stops the notifications', () => {
  const fn = vi.fn()
  subscribePathDrag(fn)()
  fn.mockClear()
  beginPathDrag(['a'], 0, 0)
  expect(fn).not.toHaveBeenCalled()
})

test('a subscriber that unsubscribes during a notification does not break the others', () => {
  // The store iterates a copy for exactly this: the composer unmounting on a session
  // switch, mid-drag, used to be able to shorten the set being walked.
  const later = vi.fn()
  // Declared before subscribing: `subscribePathDrag` calls back SYNCHRONOUSLY with the
  // current state, so `const off = subscribePathDrag(() => off())` reads `off` inside its
  // own initialiser.
  let off = (): void => {}
  off = subscribePathDrag(() => off())
  subscribePathDrag(later)
  later.mockClear()
  beginPathDrag(['a'], 0, 0)
  expect(later).toHaveBeenCalled()
})

test('within hit-tests a rectangle inclusively, and says no to nothing', () => {
  const el = { getBoundingClientRect: () => ({ left: 10, right: 20, top: 30, bottom: 40 }) }
  expect(within(el as Element, 15, 35)).toBe(true)
  expect(within(el as Element, 10, 30)).toBe(true)
  expect(within(el as Element, 9, 35)).toBe(false)
  expect(within(el as Element, 15, 41)).toBe(false)
  // A ref whose component has not mounted yet. Reading `.current` off it is normal, so
  // this must be an answer rather than a crash.
  expect(within(null, 15, 35)).toBe(false)
})

test('the threshold is big enough to survive a shaky click', () => {
  // A tree row is a button first. If this drops to 0 or 1, opening a file by clicking it
  // starts a drag instead, which is the more annoying failure by a wide margin.
  expect(DRAG_THRESHOLD_PX).toBeGreaterThanOrEqual(3)
})
