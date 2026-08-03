import { useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ChatItem } from '../lib/state'
import { DiffStatBadge, DiffView, diffStat } from '../lib/diff'
import { WRITE_TOOLS, presentTool } from '../lib/tools'
import { Icon } from '../components/icons'

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
}

export function collectChanges(items: ChatItem[]): ChangeEntry[] {
  const byPath = new Map<string, ChangeEntry>()
  for (const item of items) {
    if (item.kind !== 'tool' || item.result === undefined) continue
    if (!WRITE_TOOLS.has(item.name)) continue
    const p = presentTool(item.name, item.args)
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
    })
  }
  return [...byPath.values()].sort((a, b) => b.id - a.id)
}

/** Takes an already-collected list rather than the raw transcript: `context-panel.tsx`
 * memoises `collectChanges` so it does not re-run (and re-parse every write call's args)
 * on every streamed token. */
export function ChangesTab({
  changes: entries, onOpenFile,
}: {
  changes: ChangeEntry[]
  onOpenFile: (path: string) => void
}): VNode {
  if (entries.length === 0) {
    return <div class="panel-placeholder">No files changed in this session yet.</div>
  }
  return (
    <div class="changes-tab">
      {entries.map((entry) => <ChangeRow key={entry.id} entry={entry} onOpenFile={onOpenFile} />)}
    </div>
  )
}

function ChangeRow({
  entry, onOpenFile,
}: {
  entry: ChangeEntry
  onOpenFile: (path: string) => void
}): VNode {
  const [open, setOpen] = useState(false)
  const stat = entry.ok ? diffStat(entry.content) : null

  return (
    <div class={`change ${entry.ok ? '' : 'change-failed'}`}>
      <div class="change-head">
        <button class="change-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? Icon.chevronDown() : Icon.chevronRight()}
        </button>
        <button class="change-path" onClick={() => onOpenFile(entry.path)} title={entry.path}>
          {entry.path}
        </button>
        {entry.revisions > 1 && <span class="tag">{entry.revisions}×</span>}
        {stat && <DiffStatBadge stat={stat} />}
        {!entry.ok && <span class="tag tag-danger">failed</span>}
      </div>
      {open && (
        <div class="change-body">
          <DiffView content={entry.content} dense />
        </div>
      )}
    </div>
  )
}
