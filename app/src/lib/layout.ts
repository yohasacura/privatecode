/**
 * How the three columns share a window that may be narrower than they want.
 *
 * Pure, and its own file, because the first version of this lived as an effect that wrote
 * the squeezed widths back into state — so docking to a small screen once permanently shrank
 * the layout you had set up on the big one, and the numbers were on disk, so it survived the
 * relaunch. What the user asked for and what fits right now are two different facts, and
 * only the first belongs in storage.
 *
 * The order things give way in is the ranking of what the window is for: the conversation is
 * the tool and never goes below its floor; the sessions rail is navigation; the workspace
 * panel is reference material you consult, so it is the first to go.
 */

/** Below this the transcript stops being readable and the composer starts wrapping. */
export const MIN_CHAT = 380
export const MIN_RAIL = 180
export const MIN_CONTEXT = 280

export interface Columns {
  /** Rendered width in px; `0` means there is no room for it in this window. */
  rail: number
  context: number
}

export function fitColumns({
  windowWidth, railOpen, contextOpen, railWidth, contextWidth,
}: {
  windowWidth: number
  railOpen: boolean
  contextOpen: boolean
  railWidth: number
  contextWidth: number
}): Columns {
  let rail = railOpen ? railWidth : 0
  let context = contextOpen ? contextWidth : 0

  const spare = windowWidth - MIN_CHAT
  if (rail + context <= spare) return { rail, context }

  // Squeeze first: both panels shrink towards their minimums in proportion, which keeps a
  // deliberately-wide panel wider than a deliberately-narrow one.
  const floor = (railOpen ? MIN_RAIL : 0) + (contextOpen ? MIN_CONTEXT : 0)
  if (floor <= spare) {
    const room = spare - floor
    const slack = (rail + context) - floor
    const keep = slack === 0 ? 0 : room / slack
    rail = railOpen ? Math.floor(MIN_RAIL + (rail - MIN_RAIL) * keep) : 0
    context = contextOpen ? Math.floor(MIN_CONTEXT + (context - MIN_CONTEXT) * keep) : 0
    return { rail, context }
  }

  // Squeezing is not enough. Drop the workspace panel, then the rail.
  if (railOpen && MIN_RAIL <= spare) return { rail: MIN_RAIL, context: 0 }
  return { rail: 0, context: 0 }
}
