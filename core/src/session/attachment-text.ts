/**
 * The wrapper `attachFiles` puts around attached file bodies, and the reader that gets the
 * person's own words back out of it.
 *
 * Its own module because three places need it and the imports only run one way: `host.ts`
 * builds the blob, `replay.ts` un-builds it for display, and `session.ts` titles from it.
 *
 * Why it needs un-building: the blob IS the user message — the model has to see the file
 * bodies, so they go in the prompt as part of what the person said. That is right for the
 * model and wrong for everything that reads a user message back. Measured with the real
 * `attachFiles`: typing "fix the off-by-one in a()" with one file attached produced a message
 * whose replayed transcript row was the entire blob, and whose auto-title was
 * "The user attached these files: --- a.ts --- 1 export functio".
 *
 * The person's text is LAST, after the final blank line — see the template below — so
 * recovering it is a matter of finding where the blocks end, not of parsing them.
 */
export const ATTACHMENT_PREAMBLE = 'The user attached these files:\n\n'

/**
 * The person's own words from an `attachFiles` blob, or null when `content` is not one.
 *
 * Each attached block opens with `--- ` at the start of a line, so the person's text begins
 * after the last blank line that is not inside a block. Returns null rather than a guess when
 * the shape does not hold: showing the blob is where this started, and is recoverable by
 * scrolling; showing the wrong slice of it is not.
 */
export function attachmentUserText(content: string): string | null {
  if (!content.startsWith(ATTACHMENT_PREAMBLE)) return null
  const body = content.slice(ATTACHMENT_PREAMBLE.length)
  // Blocks are joined with '\n\n' and the person's text follows the last such join. Walk
  // back from the end to the last separator whose right-hand side does not open a block.
  let cut = -1
  for (let i = body.length; i >= 0; i--) {
    const at = body.lastIndexOf('\n\n', i)
    if (at === -1) break
    const after = body.slice(at + 2)
    if (!after.startsWith('--- ')) { cut = at + 2; break }
    i = at - 1
  }
  if (cut === -1) return null
  const text = body.slice(cut)
  return text === '' ? null : text
}
