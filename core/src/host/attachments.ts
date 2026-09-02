import { readFile, stat } from 'node:fs/promises'
import { ATTACHMENT_PREAMBLE } from '../session/attachment-text.js'
import type { Workspace } from '../workspace.js'
import { walkFiles } from './file-search.js'

/**
 * Files the user attached to a message with `@`.
 *
 * The point is to save a round trip: without it the model spends a whole step calling
 * `Read` on a path the person already knew, and sometimes spends two because it guessed
 * the path wrong. The cost is that the contents land in the transcript permanently — the
 * transcript IS the model's context and it is append-only — so this is budgeted, and the
 * budget is reported rather than applied quietly. An attachment that silently lost half a
 * file would be worse than no attachment: the model would answer confidently about code it
 * was never shown.
 *
 * Rendered in `Read`'s own format, numbered lines and all, because the model has
 * already seen thousands of those and a second format to learn buys nothing.
 */

/** Total across all attachments on one message. Roughly 10k tokens of a 131k window: enough
 * for a handful of real source files, small enough that attaching is never the thing that
 * triggers a compaction. */
export const ATTACH_BUDGET_CHARS = 40_000
/** No single file may eat the whole budget while others get nothing. */
const ATTACH_PER_FILE_CHARS = 24_000

/**
 * A folder attaches as a LISTING of the files under it, not as their contents.
 *
 * Contents was the obvious reading of "attach this folder" and it is the wrong one: a
 * source directory is routinely megabytes, so every folder attachment would spend the whole
 * budget on whichever files happened to be walked first and report the rest as dropped.
 * What the model actually needs from a folder is which files are IN it — from there
 * `Read` fetches the two that matter, at the moment it knows which two those are.
 *
 * Walked with the same skip list and the same ceiling the `@` picker uses (`file-search.ts`),
 * so a folder cannot attach a dependency tree and the walk cannot run away on a monorepo.
 */
const ATTACH_LISTING_MAX_FILES = 300

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

/**
 * One folder, rendered as the files under it.
 *
 * Deliberately NOT numbered like a file body: numbering says "these are lines of a
 * document", and reading a path off a numbered list invites the model to cite `folder:12`
 * as if that addressed something. Plain paths, one per line, in the same slash-separated
 * spelling every other tool takes back.
 */
async function folderListing(
  path: string, absolute: string,
): Promise<{ body: string; note?: string }> {
  let files: string[]
  try {
    // One over the cap, so "there were exactly this many" and "there were more" are
    // distinguishable — the same trick `Grep` plays on ripgrep's `--max-count`.
    files = await walkFiles(absolute, ATTACH_LISTING_MAX_FILES + 1)
  } catch (e) {
    return {
      body: '', note: `${path} could not be listed (${e instanceof Error ? e.message : String(e)})`,
    }
  }
  if (files.length === 0) {
    return { body: '', note: `${path} is a folder with no files in it` }
  }

  const clipped = files.length > ATTACH_LISTING_MAX_FILES
  const shown = files.slice(0, ATTACH_LISTING_MAX_FILES).sort()
  const body = shown.map((f) => `${path}/${f}`).join('\n')
  return clipped
    ? {
        body,
        note: `folder listing, first ${ATTACH_LISTING_MAX_FILES} files of more; ` +
          'Glob can narrow it',
      }
    : { body: body, note: `folder listing, ${shown.length} ${shown.length === 1 ? 'file' : 'files'}` }
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

    let absolute: string
    try {
      absolute = workspace.resolve(path)
    } catch (e) {
      const note = `${path} could not be read (${e instanceof Error ? e.message : String(e)})`
      attachments.push({ path, body: null, note })
      notes.push(note)
      continue
    }

    // Directories, before the read. Without this the `readFile` below returned EISDIR and
    // the person who dropped a folder onto the window got "could not be read (EISDIR:
    // illegal operation on a directory)" — an error message describing an implementation
    // detail of a thing they were entitled to ask for.
    let directory = false
    try {
      directory = (await stat(absolute)).isDirectory()
    } catch {
      // Left to `readFile` below to report: it fails on the same path for the same reason
      // and its message names the file, where a stat failure here would name only itself.
    }

    if (directory) {
      const listing = await folderListing(path, absolute)
      spent += listing.body.length
      if (listing.note !== undefined) {
        attachments.push({ path, body: listing.body, note: listing.note })
        notes.push(listing.note)
      } else {
        attachments.push({ path, body: listing.body })
      }
      continue
    }

    let raw: string
    try {
      raw = await readFile(absolute, 'utf8')
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
      const note = `${path} was clipped to its first ${lines} lines; Read can fetch the rest`
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
