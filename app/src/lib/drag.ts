/**
 * Dragging a workspace path from the file tree onto the composer.
 *
 * Pointer events, not HTML5 drag-and-drop, and that is forced rather than chosen. The
 * window is created with Tauri's `dragDropEnabled` at its default of ON, which is what
 * makes a file dropped from Explorer arrive as an absolute PATH (the composer's other drop
 * route, and the only route that can produce a path at all — a WebView2 renderer is handed
 * `File` objects with no filesystem path, and `attach` is a list of paths). The cost is
 * stated in Tauri's own API docs: "Disabling it is required to use HTML5 drag and drop on
 * the frontend on Windows." So `draggable` + `onDrop` cannot work here while the Explorer
 * drop does, and the two features would be trading places rather than coexisting.
 *
 * Pointer events sidestep the conflict entirely: they never involve the OS drop target, so
 * both routes work at once — Tauri's event owns drags arriving from outside the app, this
 * module owns drags that start and end inside it.
 *
 * A module-level store rather than lifted state because the two ends are five layers apart
 * (App -> aside -> ContextPanel -> WorkspaceTab -> TreePanel, against App -> Composer), and
 * threading a drag through every one of them would put a prop nobody else reads on four
 * components that do not care.
 */

export interface PathDrag {
  paths: string[]
  /** Viewport coordinates, so a drop target can hit-test its own bounding rect. */
  x: number
  y: number
}

let current: PathDrag | null = null
const listeners = new Set<(drag: PathDrag | null) => void>()

function publish(): void {
  for (const fn of [...listeners]) fn(current)
}

/** Subscribes to the in-flight drag; returns an unsubscribe. Fires immediately with the
 * current state so a component mounting mid-drag is not left blind. */
export function subscribePathDrag(fn: (drag: PathDrag | null) => void): () => void {
  listeners.add(fn)
  fn(current)
  return () => { listeners.delete(fn) }
}

export function pathDrag(): PathDrag | null {
  return current
}

export function beginPathDrag(paths: readonly string[], x: number, y: number): void {
  if (paths.length === 0) return
  current = { paths: [...paths], x, y }
  publish()
}

export function movePathDrag(x: number, y: number): void {
  if (current === null) return
  current = { ...current, x, y }
  publish()
}

/** Ends the drag and returns what was being carried, or null if nothing was. */
export function endPathDrag(): string[] | null {
  const carried = current?.paths ?? null
  current = null
  publish()
  return carried
}

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * Every tree row is also a button that opens a file, and a click is never perfectly still.
 * Without a threshold, opening a file by clicking it would sometimes start a drag instead,
 * which is the more annoying of the two failure directions by a wide margin.
 */
export const DRAG_THRESHOLD_PX = 5

/** Whether a point is inside an element's box — the hit test a pointer drop needs, since
 * there is no `drop` event to tell a target it was the one. */
export function within(el: Element | null, x: number, y: number): boolean {
  if (el === null) return false
  const r = el.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}
