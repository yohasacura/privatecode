import { useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ChatItem } from '../lib/state'
import { DiffStatBadge, DiffView, diffStat } from '../lib/diff'
import { WRITE_TOOLS, presentTool } from '../lib/tools'
import { Icon } from '../components/icons'
import { PanelEmpty, PanelRow, PanelSection } from '../components/panel'
import { WorkingTree } from './working-tree'
import type { ProtocolClient } from '../lib/client'

/**
 * Changes tab: every write this session made, in one list, newest first.
 *
 * The transcript already shows each diff where it happened — this answers the other
 * question, the one the transcript is bad at: "what has it touched in total?". Files
 * edited more than once collapse into a single entry with a revision count, because seven
 * separate rows for the same file is a worse answer than one row that says seven.
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
    byPath.set(key, {
      id: item.id,
      tool: item.name,
      path: p.target,
      ok: item.result.ok,
      content: item.result.content,
      revisions: (previous?.revisions ?? 0) + 1,
      openPath: p.path ?? key,
    })
  }
  return [...byPath.values()].sort((a, b) => b.id - a.id)
}

/** Takes an already-collected list rather than the raw transcript: `context-panel.tsx`
 * memoises `collectChanges` so it does not re-run (and re-parse every write call's args)
 * on every streamed token. */
export function ChangesTab({
  changes: entries, onOpenFile, client, reloadKey,
}: {
  changes: ChangeEntry[]
  onOpenFile: (path: string) => void
  client: ProtocolClient
  /** Bumped when a turn resolves a tool, so the working tree follows the agent's writes. */
  reloadKey: number
}): VNode {
  // Bumped by a per-file revert so the working tree below re-reads itself: the revert
  // changed the disk, and a git status from before it is a lie.
  const [reverts, setReverts] = useState(0)
  if (entries.length === 0) {
    return (
      <div class="changes-tab">
        <PanelEmpty
          icon={Icon.diff()}
          title="Nothing changed yet"
          hint="Every file the agent writes in this session lands here, with its diff and a way back to the file."
        />
        <WorkingTree client={client} reloadKey={reloadKey + reverts} />
      </div>
    )
  }

  // The total, once, at the top. The transcript shows each diff where it happened; the
  // question this tab exists to answer is the one the transcript is bad at -- how much of
  // my workspace has moved -- and a per-row stat never adds up to that on its own.
  let added = 0
  let removed = 0
  for (const entry of entries) {
    if (!entry.ok) continue
    const stat = diffStat(entry.content)
    added += stat.added
    removed += stat.removed
  }

  return (
    <div class="changes-tab">
      <div class="changes-total">
        <span>{entries.length} file{entries.length === 1 ? '' : 's'}</span>
        <DiffStatBadge stat={{ added, removed }} />
      </div>
      <PanelSection title="This session">
        {entries.map((entry) => (
          <ChangeRow
            key={entry.id}
            entry={entry}
            onOpenFile={onOpenFile}
            client={client}
            onReverted={() => setReverts((n) => n + 1)}
          />
        ))}
      </PanelSection>
      <WorkingTree client={client} reloadKey={reloadKey + reverts} />
    </div>
  )
}

/**
 * One file the agent wrote, with the two things you can do about it.
 *
 * "Put it back" is the answer the app was missing: the only undo was a whole-workspace
 * rewind, so a turn that got four files right and the fifth wrong cost you all five. The
 * note is optional and goes to the model with the revert, because "put it back" and "here
 * is why" arriving separately is how it concludes the revert was a mistake and does it
 * again.
 */
function ChangeRow({
  entry, onOpenFile, client, onReverted,
}: {
  entry: ChangeEntry
  onOpenFile: (path: string) => void
  client: ProtocolClient
  onReverted: () => void
}): VNode {
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const stat = entry.ok ? diffStat(entry.content) : null

  function revert(): void {
    setBusy(true)
    client.call('checkpoints.restoreFile', {
      path: entry.openPath, ...(note.trim() !== '' ? { note: note.trim() } : {}),
    })
      .then(() => { setAsking(false); setNote(''); setFailed(null); onReverted() })
      .catch((e: Error) => setFailed(e.message))
      .finally(() => setBusy(false))
  }

  return (
    <PanelRow
      open={open || asking}
      onToggle={() => setOpen((o) => !o)}
      icon={Icon.file()}
      label={entry.path}
      mono
      title={entry.path}
      onOpen={() => onOpenFile(entry.openPath)}
      {...(entry.ok ? {} : { tone: 'bad' as const })}
      meta={
        <>
          {entry.revisions > 1 && <span class="tag">{entry.revisions}×</span>}
          {stat && <DiffStatBadge stat={stat} />}
          {!entry.ok && <span class="tag tag-danger">failed</span>}
        </>
      }
      actions={
        entry.ok
          ? (
            <button class="btn btn-small" onClick={() => setAsking(true)} disabled={asking}>
              Put back
            </button>
            )
          : undefined
      }
    >
      {asking && (
        <div class="revert-box">
          <p>
            Restore <code>{entry.path}</code> to how it was before this session started, and
            tell the agent why. Nothing else is touched.
          </p>
          {failed !== null && <div class="panel-error">{failed}</div>}
          <div class="revert-actions">
            <input
              class="input"
              value={note}
              placeholder="why (optional) — the agent is told"
              onInput={(e) => setNote(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') revert() }}
            />
            <button class="btn btn-danger btn-small" onClick={revert} disabled={busy}>
              {busy ? 'Restoring…' : 'Put it back'}
            </button>
            <button class="btn btn-small" onClick={() => { setAsking(false); setFailed(null) }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {open && <DiffView content={entry.content} dense />}
    </PanelRow>
  )
}
