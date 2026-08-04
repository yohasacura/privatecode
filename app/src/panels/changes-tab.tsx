import { useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ChatItem } from '../lib/state'
import { DiffStatBadge, DiffView, diffStat } from '../lib/diff'
import { WRITE_TOOLS, presentTool } from '../lib/tools'
import { Icon } from '../components/icons'
import { PanelEmpty, PanelRow } from '../components/panel'

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
      openPath: p.path ?? key,
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
    return (
      <PanelEmpty
        icon={Icon.diff()}
        title="Nothing changed yet"
        hint="Every file the agent writes in this session lands here, with its diff and a way back to the file."
      />
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
    <PanelRow
      open={open}
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
    >
      <DiffView content={entry.content} dense />
    </PanelRow>
  )
}
