import { describe, expect, test } from 'vitest'
import { layoutGraph } from './git-graph'

/**
 * The lanes beside the history, from parents alone. Newest first, like `git log`.
 */

describe('layoutGraph', () => {
  test('a straight line is one lane, every row connected to the next', () => {
    const rows = layoutGraph([
      { sha: 'c', parents: ['b'] }, { sha: 'b', parents: ['a'] }, { sha: 'a', parents: [] },
    ])
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(rows[0]?.edges).toEqual([{ from: 0, to: 0, colour: 0, passing: false }])
    expect(rows[2]?.edges).toEqual([])
    expect(rows.every((r) => r.width === 1)).toBe(true)
  })

  test('a merge opens a second lane for its second parent and closes it where the branches join', () => {
    // m merges f into c's line: m -> (c, f); f -> b; c -> b; b -> a.
    const rows = layoutGraph([
      { sha: 'm', parents: ['c', 'f'] },
      { sha: 'f', parents: ['b'] },
      { sha: 'c', parents: ['b'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] },
    ])
    const byLane = Object.fromEntries(rows.map((r) => [r.sha, r.lane]))
    expect(byLane).toEqual({ m: 0, f: 1, c: 0, b: 0, a: 0 })
    // Beneath m: its own lane continues to c, a new lane opens towards f.
    expect(rows[0]?.edges).toEqual([
      { from: 0, to: 0, colour: 0, passing: false },
      { from: 0, to: 1, colour: 1, passing: false },
    ])
    // Beneath f: lane 0 passes (waiting for c); f's lane heads for b — where lane 0 is not yet waiting.
    expect(rows[1]?.edges).toEqual([
      { from: 0, to: 0, colour: 0, passing: true },
      { from: 1, to: 1, colour: 1, passing: false },
    ])
    // Beneath c: both lanes now wait for b; c's lane continues and f's lane joins it at b.
    expect(rows[2]?.width).toBe(2)
    // Beneath b: b's lane continues to a, and f's lane, which also waited for b, curves in.
    expect(rows[3]?.edges).toEqual([
      { from: 0, to: 0, colour: 0, passing: false },
      { from: 1, to: 0, colour: 1, passing: false },
    ])
    expect(rows[3]?.width).toBe(2)
    expect(rows[4]?.width).toBe(1)
  })

  test('two branch tips with no merge sit in two lanes until their common ancestor', () => {
    const rows = layoutGraph([
      { sha: 'x', parents: ['a'] },
      { sha: 'y', parents: ['a'] },
      { sha: 'a', parents: [] },
    ])
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0])
    // y's lane heads for a, which lane 0 already waits for: it joins lane 0.
    expect(rows[1]?.edges).toEqual([
      { from: 0, to: 0, colour: 0, passing: true },
      { from: 1, to: 0, colour: 1, passing: false },
    ])
    expect(rows[2]?.width).toBe(1)
  })

  test('an empty history is an empty graph', () => {
    expect(layoutGraph([])).toEqual([])
  })
})
