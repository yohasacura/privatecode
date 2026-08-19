import type { ChatItem } from '../lib/state'
import { WRITE_TOOLS, presentTool } from '../lib/tools'

/**
 * The session's changes, as DATA. The tab that rendered this list is gone — the owner's
 * ruling was that Files and Changes are one thing, so the tree wears the change badges
 * and the diff face of an opened file carries Put back and Reviewed (file-view.tsx).
 * What remains here is the collection itself: every write this session made, collapsed
 * per path with a revision count, plus the reviewed-watermark split the badges dim by.
 */

export interface ChangeEntry {
  /** Transcript item id of the LAST write to this path -- also the render key. */
  id: number
  tool: string
  path: string
  ok: boolean
  content: string
  revisions: number
  /** What to actually open. `path` is for DISPLAY and for move_file reads "from → to",
   * which is not a path anything can read -- clicking such a row asked the host to open a
   * file that cannot exist and produced an ENOENT banner. */
  openPath: string
  /** Every path "Put back" must restore. One entry for an edit; TWO for a move — restoring
   * only the destination deleted the file from both places: the destination did not exist
   * at the session baseline (so restore removed it) and the source was never recreated. */
  restorePaths: string[]
  /** The LAST write to this path failed, but an earlier one succeeded — the row keeps the
   * successful diff and its Put back (a failed edit changed nothing on disk), and says so
   * instead of pretending the file was never changed. */
  lastFailed?: boolean
}

/**
 * Parsed targets, keyed by the ITEM OBJECT.
 *
 * `presentTool` is a `JSON.parse` of a write call's arguments, and those arguments carry the
 * ENTIRE new file. `collectChanges` runs on every appended item and every tool resolution —
 * roughly three times per write step — and re-parsed every earlier write each time: O(N²)
 * parses of file-sized documents, on the UI thread, whichever tab happens to be open.
 *
 * A `WeakMap` on the object, rather than a `Map` on `item.id`. The reducer never mutates an
 * item; it replaces the object, so the same object always means the same arguments and the
 * cache cannot go stale. Keying on the id would instead rest on ids being unique across the
 * whole app run — true today for the live transcript, and NOT true of a viewed session, which
 * numbers its own items from 1. That is the same overlap that put a hole in someone else's
 * conversation earlier today, and the app-side tests found it here immediately: they reuse
 * ids 1, 2, 3 across cases with different arguments, and the id-keyed version handed the
 * second case the first case's file.
 *
 * It also needs no clearing. An item the transcript has dropped is collectable.
 */
const parsedTargets = new WeakMap<ChatItem, ReturnType<typeof presentTool>>()

function targetOf(item: ChatItem & { kind: 'tool' }): ReturnType<typeof presentTool> {
  const hit = parsedTargets.get(item)
  if (hit) return hit
  const parsed = presentTool(item.name, item.args)
  parsedTargets.set(item, parsed)
  return parsed
}

export function collectChanges(items: ChatItem[]): ChangeEntry[] {
  const byPath = new Map<string, ChangeEntry>()
  for (const item of items) {
    if (item.kind !== 'tool' || item.result === undefined) continue
    if (!WRITE_TOOLS.has(item.name)) continue
    // A call that was stopped before it executed changed nothing, so it is not a change.
    // `Not run:` is the core's contract for that — a permission denial, a deferral, a
    // loop-detector refusal, or an extra call in a step that already acted. Listing them put
    // a phantom row here, and worse: last-write-wins meant a refused write to a path REPLACED
    // the successful write to the same path, taking its diff and its "Put back" button with
    // it.
    if (item.result.content.startsWith('Not run:')) continue
    const p = targetOf(item)
    const key = p.path ?? p.target
    if (key === '') continue
    const previous = byPath.get(key)
    // A write that RAN and failed changed nothing on disk, so it must not replace the
    // successful entry it follows — that took the real diff, the +/- total and the Put
    // back button off a file that genuinely was changed this session. The row keeps the
    // last SUCCESSFUL state and carries the failure as a flag; `id` still advances so a
    // reviewed row honestly resurfaces on the news.
    if (!item.result.ok && previous !== undefined && previous.ok) {
      byPath.set(key, { ...previous, id: item.id, revisions: previous.revisions + 1, lastFailed: true })
      continue
    }
    // Restore paths ACCUMULATE across revisions: `move a→b` then `edit b` is one entry
    // keyed on b, and putting it back must still recreate a — restoring only b deletes the
    // file outright (absent there at baseline) with the source never recreated.
    const restorePaths = [...new Set([
      ...(previous?.restorePaths ?? []),
      ...(p.fromPath !== undefined ? [p.fromPath] : []),
      p.path ?? key,
    ])]
    byPath.set(key, {
      id: item.id,
      tool: item.name,
      path: p.target,
      ok: item.result.ok,
      content: item.result.content,
      revisions: (previous?.revisions ?? 0) + 1,
      openPath: p.path ?? key,
      restorePaths,
    })
  }
  return [...byPath.values()].sort((a, b) => b.id - a.id)
}

/**
 * Which entries a reviewed-set still hides.
 *
 * The watermark is the entry's LAST-write item id, not a boolean: "reviewed" means "I have
 * seen this file as of that write". A newer write to the same path has a higher id, beats
 * the watermark, and the row honestly comes back — reviewing a file must never suppress
 * what the agent does to it afterwards. Pure and exported for its test.
 */
export function splitReviewed(
  entries: ChangeEntry[], reviewed: ReadonlyMap<string, number>,
): { visible: ChangeEntry[]; hidden: ChangeEntry[] } {
  const visible: ChangeEntry[] = []
  const hidden: ChangeEntry[] = []
  for (const entry of entries) {
    const mark = reviewed.get(entry.path)
    if (mark !== undefined && entry.id <= mark) hidden.push(entry)
    else visible.push(entry)
  }
  return { visible, hidden }
}
