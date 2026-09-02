/**
 * Where a floating element goes, given its anchor and the room there is.
 *
 * A small, pure placement routine rather than a positioning library: the window has six
 * places that float (tooltip, popover, menu, palette, mention picker, command picker),
 * every one of them is anchored to a rectangle, and all of them want the same thing —
 * the preferred side if it fits, the opposite side if it does not, and never off-screen.
 */

export type Side = 'top' | 'bottom' | 'left' | 'right'
export type Align = 'start' | 'center' | 'end'

export interface Rect { x: number; y: number; width: number; height: number }

export interface Placement {
  x: number
  y: number
  /** The side actually used, after flipping. */
  side: Side
}

/**
 * Computes the top-left corner for `floating` beside `anchor`, inside `viewport`.
 * `gap` is the space between them; `padding` keeps the result away from the viewport edge.
 */
export function place(
  anchor: Rect,
  floating: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: { side?: Side; align?: Align; gap?: number; padding?: number } = {},
): Placement {
  const side = opts.side ?? 'bottom'
  const align = opts.align ?? 'start'
  const gap = opts.gap ?? 6
  const padding = opts.padding ?? 8

  const fits = (s: Side): boolean => {
    switch (s) {
      case 'bottom': return anchor.y + anchor.height + gap + floating.height <= viewport.height - padding
      case 'top': return anchor.y - gap - floating.height >= padding
      case 'right': return anchor.x + anchor.width + gap + floating.width <= viewport.width - padding
      case 'left': return anchor.x - gap - floating.width >= padding
    }
  }
  const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
  const used = fits(side) ? side : fits(opposite[side]) ? opposite[side] : side

  let x: number
  let y: number
  if (used === 'bottom' || used === 'top') {
    y = used === 'bottom' ? anchor.y + anchor.height + gap : anchor.y - gap - floating.height
    x = align === 'start' ? anchor.x
      : align === 'end' ? anchor.x + anchor.width - floating.width
      : anchor.x + (anchor.width - floating.width) / 2
  } else {
    x = used === 'right' ? anchor.x + anchor.width + gap : anchor.x - gap - floating.width
    y = align === 'start' ? anchor.y
      : align === 'end' ? anchor.y + anchor.height - floating.height
      : anchor.y + (anchor.height - floating.height) / 2
  }
  // Clamp inside the viewport, padding included; a menu near the right edge slides left
  // rather than being cut off.
  x = Math.min(Math.max(x, padding), Math.max(padding, viewport.width - padding - floating.width))
  y = Math.min(Math.max(y, padding), Math.max(padding, viewport.height - padding - floating.height))
  return { x: Math.round(x), y: Math.round(y), side: used }
}
