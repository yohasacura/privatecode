import { readFile } from 'node:fs/promises'
import { ATTACHMENT_PREAMBLE } from '../session/attachment-text.js'
import type { Workspace } from '../workspace.js'

/**
 * Files the user attached to a message with `@`.
 *
 * The point is to save a round trip: without it the model spends a whole step calling
 * `read_file` on a path the person already knew, and sometimes spends two because it guessed
 * the path wrong. The cost is that the contents land in the transcript permanently — the
 * transcript IS the model's context and it is append-only — so this is budgeted, and the
 * budget is reported rather than applied quietly. An attachment that silently lost half a
 * file would be worse than no attachment: the model would answer confidently about code it
 * was never shown.
 *
 * Rendered in `read_file`'s own format, numbered lines and all, because the model has
 * already seen thousands of those and a second format to learn buys nothing.
 */

/** Total across all attachments on one message. Roughly 10k tokens of a 131k window: enough
 * for a handful of real source files, small enough that attaching is never the thing that
 * triggers a compaction. */
export const ATTACH_BUDGET_CHARS = 40_000
/** No single file may eat the whole budget while others get nothing. */
const ATTACH_PER_FILE_CHARS = 24_000

export interface Attachment {
  path: string
  /** Rendered block, or `null` when the file could not be read at all. */
  body: string | null
  /** Present when the file was cut, or could not be read; shown to the user AND to the
   * model, because both need to know they are looking at part of something. */
  note?: string
}

export interface AttachedMessage {
  /** The user's own words, with the attached blocks before them. */
  text: string
  /** One line per attachment for the window to show. Empty when nothing was attached. */
  notes: string[]
}

function numbered(body: string): { text: string; lines: number } {
  const lines = body.split('\n')
  return {
    text: lines.map((line, i) => `${i + 1}\t${line}`).join('\n'),
    lines: lines.length,
  }
}

/**
 * Reads each path and composes the message the model will actually receive.
 *
 * The user's words go LAST. Instruction-following degrades when the ask is buried above a
 * few hundred lines of source, and the ask is the part that must not be missed.
 */
export async function attachFiles(
  workspace: Workspace,
  paths: readonly string[],
  text: string,
): Promise<AttachedMessage> {
  if (paths.length === 0) return { text, notes: [] }

  const attachments: Attachment[] = []
  const notes: string[] = []
  let spent = 0
  // Deduplicated: attaching the same file twice costs the context window twice and tells
  // the model nothing new. The picker allows it; the message should not.
  const unique = [...new Set(paths)]

  for (const path of unique) {
    if (spent >= ATTACH_BUDGET_CHARS) {
      const note = `${path} was not attached: the ${ATTACH_BUDGET_CHARS}-character attachment budget was already spent`
      attachments.push({ path, body: null, note })
      notes.push(note)
      continue
    }

    let raw: string
    try {
      raw = await readFile(workspace.resolve(path), 'utf8')
    } catch (e) {
      const note = `${path} could not be read (${e instanceof Error ? e.message : String(e)})`
      attachments.push({ path, body: null, note })
      notes.push(note)
      continue
    }

    const room = Math.min(ATTACH_PER_FILE_CHARS, ATTACH_BUDGET_CHARS - spent)
    const clipped = raw.length > room
    const shown = clipped ? raw.slice(0, room) : raw
    const { text: body, lines } = numbered(shown)
    spent += body.length

    if (clipped) {
      const note = `${path} was clipped to its first ${lines} lines; read_file can fetch the rest`
      attachments.push({ path, body, note })
      notes.push(note)
    } else {
      attachments.push({ path, body })
    }
  }

  const blocks = attachments.map((a) => {
    const header = a.note !== undefined ? `${a.path} — ${a.note}` : a.path
    return a.body === null ? `--- ${header} ---` : `--- ${header} ---\n${a.body}`
  })

  return {
    // The wrapper is a shared constant, not a literal: `replay.ts` has to recognise this
    // shape to show the person's own words instead of the whole blob, and `session.ts` has to
    // title from them. See `attachment-text.ts`.
    text: `${ATTACHMENT_PREAMBLE}${blocks.join('\n\n')}\n\n${text}`,
    notes,
  }
}
