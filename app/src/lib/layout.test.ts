import { describe, expect, it } from 'vitest'
import { MIN_CHAT, MIN_CONTEXT, MIN_RAIL, fitColumns } from './layout'

const open = { railOpen: true, contextOpen: true, railWidth: 232, contextWidth: 380 }

describe('fitColumns', () => {
  it('gives both panels exactly what was asked for when there is room', () => {
    expect(fitColumns({ windowWidth: 1600, ...open })).toEqual({ rail: 232, context: 380 })
  })

  it('leaves a closed panel closed however wide the window is', () => {
    expect(fitColumns({ windowWidth: 2400, ...open, contextOpen: false }))
      .toEqual({ rail: 232, context: 0 })
  })

  it('squeezes both before dropping either, and never below the chat floor', () => {
    const fitted = fitColumns({ windowWidth: 900, ...open })
    expect(fitted.rail).toBeGreaterThanOrEqual(MIN_RAIL)
    expect(fitted.context).toBeGreaterThanOrEqual(MIN_CONTEXT)
    expect(900 - fitted.rail - fitted.context).toBeGreaterThanOrEqual(MIN_CHAT)
  })

  it('keeps a deliberately wide panel wider than a narrow one while squeezing', () => {
    const fitted = fitColumns({ windowWidth: 900, ...open, railWidth: 400, contextWidth: 400 })
    // Both asked for 400, but the rail's floor is lower, so it gives up more -- the point
    // is that neither is squeezed to its minimum while the other keeps everything.
    expect(fitted.rail).toBeGreaterThan(MIN_RAIL)
    expect(fitted.context).toBeGreaterThan(MIN_CONTEXT)
  })

  it('drops the workspace panel first: it is reference, the conversation is the tool', () => {
    const fitted = fitColumns({ windowWidth: 820, ...open })
    expect(fitted.context).toBe(0)
    expect(fitted.rail).toBe(MIN_RAIL)
    expect(820 - fitted.rail).toBeGreaterThanOrEqual(MIN_CHAT)
  })

  it('drops the rail too when even that will not fit', () => {
    expect(fitColumns({ windowWidth: 500, ...open })).toEqual({ rail: 0, context: 0 })
  })

  it('never returns a layout that leaves the chat below its floor', () => {
    // The bug this replaces computed the chat column to 0px on a narrow monitor, from
    // widths saved on a wide one -- transcript and composer gone entirely, reproduced on
    // every relaunch because the numbers were on disk.
    for (let width = 320; width <= 2000; width += 7) {
      const { rail, context } = fitColumns({ windowWidth: width, ...open })
      if (rail === 0 && context === 0) continue
      expect(width - rail - context).toBeGreaterThanOrEqual(MIN_CHAT)
    }
  })

  it('is a pure function of what it is given', () => {
    // It must not be tempting to "fix" a squeeze by writing it back: what the user asked
    // for and what fits right now are different facts, and only the first is saved.
    const args = { windowWidth: 900, ...open }
    const before = JSON.stringify(args)
    fitColumns(args)
    expect(JSON.stringify(args)).toBe(before)
  })

  it('agrees with its own constants', () => {
    expect(MIN_CHAT + MIN_RAIL + MIN_CONTEXT).toBe(840)
  })
})
