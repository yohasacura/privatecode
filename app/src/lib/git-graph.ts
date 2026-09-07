/**
 * The commit graph's lanes — the coloured lines beside the history list — computed from
 * `git log`'s order and each commit's parents, the way Visual Studio's Git Repository window
 * draws its multi-branch history.
 *
 * Rows arrive newest first, which is the direction the walk goes: a lane is a promise
 * that some later row will be the commit it names. A commit lands in the first lane that
 * was waiting for it (or opens a new one at the right), then leaves its first parent in
 * that lane and opens one lane per further parent — unless another lane already waits
 * for that parent, in which case the line simply joins it. Two lanes waiting for the same
 * commit collapse into the leftmost when that commit arrives. Pure and exported for its
 * test; the SVG is drawn from `edges` alone.
 */

export interface GraphRow {
  sha: string
  /** The column this commit's dot sits in. */
  lane: number
  /** Lines from this row's lanes to the next row's, drawn in the gap beneath the row. */
  edges: GraphEdge[]
  /** How many lanes are live beneath this row, for the SVG's width. */
  width: number
  colour: number
}

export interface GraphEdge {
  from: number
  to: number
  colour: number
  /** The line continues a lane that does not involve this commit. */
  passing: boolean
}

interface Lane {
  waitingFor: string
  colour: number
}

export const LANE_COLOURS = 8

export function layoutGraph(commits: readonly { sha: string; parents: readonly string[] }[]): GraphRow[] {
  const rows: GraphRow[] = []
  let lanes: (Lane | null)[] = []
  let nextColour = 0
  const takeColour = (): number => { const c = nextColour % LANE_COLOURS; nextColour += 1; return c }

  for (const commit of commits) {
    // Where this commit lands: the leftmost lane waiting for it, or a new one.
    let lane = lanes.findIndex((l) => l !== null && l.waitingFor === commit.sha)
    let colour: number
    if (lane === -1) {
      lane = lanes.indexOf(null)
      if (lane === -1) { lane = lanes.length; lanes.push(null) }
      colour = takeColour()
      lanes[lane] = { waitingFor: commit.sha, colour }
    } else {
      colour = lanes[lane]!.colour
    }
    // Every OTHER lane that waited for this same commit merges into this one.
    const merging = lanes.map((l, i) => (i !== lane && l !== null && l.waitingFor === commit.sha ? i : -1)).filter((i) => i >= 0)

    const before = lanes.map((l) => (l === null ? null : { ...l }))
    // The lanes beneath this row: the commit's lane now waits for its first parent; the
    // merging lanes close; further parents open or join lanes.
    const after: (Lane | null)[] = before.map((l) => (l === null ? null : { ...l }))
    for (const i of merging) after[i] = null
    const [first, ...others] = commit.parents
    if (first === undefined) after[lane] = null
    else after[lane] = { waitingFor: first, colour }
    const edges: GraphEdge[] = []
    // Passing lanes: anything live that is not this commit's business continues straight.
    for (let i = 0; i < before.length; i += 1) {
      const l = before[i] ?? null
      if (l === null || i === lane || merging.includes(i)) continue
      edges.push({ from: i, to: i, colour: l.colour, passing: true })
    }
    // The lane this commit leaves behind.
    if (first !== undefined) {
      const already = before.findIndex((l, i) => i !== lane && l !== null && l.waitingFor === first && !merging.includes(i))
      if (already !== -1 && already < lane) {
        // The first parent is also awaited by a lane to the left: join it there and free
        // this one, so the graph does not carry two lines to the same commit.
        after[lane] = null
        edges.push({ from: lane, to: already, colour, passing: false })
      } else {
        edges.push({ from: lane, to: lane, colour, passing: false })
      }
    }
    // The merging lanes end here: a line from each into this commit's lane.
    for (const i of merging) edges.push({ from: i, to: lane, colour: before[i]!.colour, passing: false })
    // Further parents.
    for (const parent of others) {
      const existing = after.findIndex((l) => l !== null && l.waitingFor === parent)
      if (existing !== -1) {
        edges.push({ from: lane, to: existing, colour: after[existing]!.colour, passing: false })
        continue
      }
      let free = after.indexOf(null)
      if (free === -1) { free = after.length; after.push(null) }
      const c = takeColour()
      after[free] = { waitingFor: parent, colour: c }
      edges.push({ from: lane, to: free, colour: c, passing: false })
    }
    // Trailing empty lanes are dropped so the width is honest.
    while (after.length > 0 && after[after.length - 1] === null) after.pop()
    rows.push({ sha: commit.sha, lane, edges, width: Math.max(before.length, after.length, lane + 1), colour })
    lanes = after
  }
  return rows
}
