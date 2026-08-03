import { useEffect, useState } from 'preact/hooks'
import type { ProtocolClient } from '../lib/client'
import type { ChatItem, PendingApproval } from '../lib/state'

/**
 * The diffs panel (Plan 4 Task 7): a per-session RECORD of every write-family tool call
 * that has completed (path, kind, the rendered diff/confirmation text the tool itself
 * returned, +/- coloring by line prefix), plus the currently pending approval's detail
 * pinned at top while a card is open, plus the read-only file preview `tree.tsx` opens.
 *
 * This panel does not approve or reject anything -- that flow lives entirely in
 * `approvals.tsx`'s card (per-file accept/reject-with-comment IS that flow); this is only
 * ever a record of what already happened, and a preview of what a file currently looks
 * like.
 */

const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'move_file', 'delete_file'])

export interface DiffEntry {
  id: number
  tool: string
  path: string
  ok: boolean
  content: string
}

function pathFromArgs(name: string, argsJson: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (name === 'move_file') {
    const from = obj['from']
    const to = obj['to']
    return typeof from === 'string' && typeof to === 'string' ? `${from} -> ${to}` : null
  }
  const path = obj['path']
  return typeof path === 'string' ? path : null
}

/**
 * The tool.result -> diff-entry mapper (Task 7's own name for it, in the plan's
 * verification bullet): turns one chat transcript `tool` item into a `DiffEntry`, or
 * `null` when it isn't a COMPLETED write-family call at all -- a read-only tool
 * (`read_file`, `search_code`, ...), a call still awaiting its result, or args that failed
 * to parse all return `null` rather than a malformed entry.
 */
export function toDiffEntry(item: ChatItem): DiffEntry | null {
  if (item.kind !== 'tool' || item.result === undefined) return null
  if (!WRITE_TOOLS.has(item.name)) return null
  const path = pathFromArgs(item.name, item.args)
  if (path === null) return null
  return { id: item.id, tool: item.name, path, ok: item.result.ok, content: item.result.content }
}

/** `+`/`-` prefixed lines (edit_file's own `renderDiff` format -- see edit-file.ts) get
 * colored; everything else (a `---`/`+++`/`@@` header line, or a write_file/move_file/
 * delete_file confirmation string that never had diff syntax to begin with) is neutral. */
function diffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'diff-remove'
  return 'diff-context'
}

function DiffEntryRow({ entry }: { entry: DiffEntry }) {
  const lines = entry.content.split('\n')
  return (
    <div class={`diff-entry ${entry.ok ? 'diff-entry-ok' : 'diff-entry-fail'}`}>
      <div class="diff-entry-header">
        <span class="diff-entry-icon">{entry.ok ? '✓' : '✗'}</span>
        <b>{entry.tool}</b>
        <span class="diff-entry-path">{entry.path}</span>
      </div>
      <pre class="diff-body">
        {lines.map((line, i) => <div key={i} class={`diff-line ${diffLineClass(line)}`}>{line}</div>)}
      </pre>
    </div>
  )
}

type PreviewState =
  | { kind: 'loading'; path: string }
  | { kind: 'loaded'; path: string; lines: string[]; truncated: boolean }
  | { kind: 'error'; path: string; message: string }

export function DiffsPanel({
  client, toolItems, pendingApproval, previewPath,
}: {
  client: ProtocolClient
  toolItems: ChatItem[]
  pendingApproval: PendingApproval | null
  previewPath: string | null
}) {
  const [preview, setPreview] = useState<PreviewState | null>(null)

  useEffect(() => {
    if (previewPath === null) {
      setPreview(null)
      return
    }
    setPreview({ kind: 'loading', path: previewPath })
    client.call('fs.read', { path: previewPath })
      .then((r) => setPreview({ kind: 'loaded', path: previewPath, lines: r.lines, truncated: r.truncated }))
      .catch((e: unknown) => {
        setPreview({ kind: 'error', path: previewPath, message: e instanceof Error ? e.message : String(e) })
      })
  }, [client, previewPath])

  const entries = toolItems.map(toDiffEntry).filter((e): e is DiffEntry => e !== null)

  return (
    <div class="diffs-panel">
      {pendingApproval && (
        <div class="diffs-pinned">
          <div class="diffs-pinned-label">pending: {pendingApproval.tool}</div>
          <pre class="approval-detail">{pendingApproval.detail}</pre>
        </div>
      )}
      {preview && (
        <div class="file-preview">
          <div class="file-preview-header">
            {preview.path}
            {preview.kind === 'loaded' && preview.truncated ? ' (truncated)' : ''}
          </div>
          {preview.kind === 'loading' && <div class="panel-placeholder">loading preview…</div>}
          {preview.kind === 'error' && <div class="chat-error">⚠ {preview.message}</div>}
          {preview.kind === 'loaded' && <pre class="file-preview-body">{preview.lines.join('\n')}</pre>}
        </div>
      )}
      <div class="diffs-list">
        {entries.length === 0 && <div class="panel-placeholder">no changes yet this session</div>}
        {entries.map((entry) => <DiffEntryRow key={entry.id} entry={entry} />)}
      </div>
    </div>
  )
}
