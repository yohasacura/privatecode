import { describe, expect, test } from 'vitest'
import { place } from './position'

const viewport = { width: 1000, height: 600 }
const floating = { width: 200, height: 100 }

describe('placing a floating element', () => {
  test('goes below the anchor when there is room, aligned to its start', () => {
    const p = place({ x: 100, y: 100, width: 80, height: 20 }, floating, viewport)
    expect(p).toEqual({ x: 100, y: 126, side: 'bottom' })
  })

  test('flips above when there is no room below', () => {
    const p = place({ x: 100, y: 560, width: 80, height: 20 }, floating, viewport)
    expect(p.side).toBe('top')
    expect(p.y).toBe(560 - 6 - 100)
  })

  test('keeps the preferred side when neither fits, and clamps into view', () => {
    const p = place({ x: 100, y: 300, width: 80, height: 20 }, { width: 200, height: 590 }, viewport)
    expect(p.side).toBe('bottom')
    expect(p.y).toBe(8)
  })

  test('slides left rather than off the right edge', () => {
    const p = place({ x: 950, y: 100, width: 40, height: 20 }, floating, viewport, { align: 'start' })
    expect(p.x).toBe(1000 - 8 - 200)
  })

  test('aligns end and center', () => {
    const anchor = { x: 400, y: 100, width: 100, height: 20 }
    expect(place(anchor, floating, viewport, { align: 'end' }).x).toBe(300)
    expect(place(anchor, floating, viewport, { align: 'center' }).x).toBe(350)
  })

  test('places to the right and flips left at the edge', () => {
    expect(place({ x: 100, y: 100, width: 40, height: 20 }, floating, viewport, { side: 'right' }))
      .toEqual({ x: 146, y: 100, side: 'right' })
    expect(place({ x: 900, y: 100, width: 40, height: 20 }, floating, viewport, { side: 'right' }).side)
      .toBe('left')
  })
})
