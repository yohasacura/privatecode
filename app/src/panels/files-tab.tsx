import { useEffect, useMemo, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import type { ChangeDecor } from '../lib/path-tree'
import type { ChatItem } from '../lib/state'
import { DiffStatBadge, DiffView, diffStat } from '../lib/diff'
import { highlight } from '../lib/highlight'
import { Icon } from '../components/icons'
import { PanelError } from '../components/panel'
import type { ChangeEntry } from './changes-tab'
import { TreePanel, type MountActions, type MountInfo } from './tree'

/**
 * Files tab: the workspace tree, and — over the whole of it — whatever file you opened.
 *
 * The preview used to split the column in half, which gave a three-entry tree 40% of the
 * height and the file you actually wanted to read the other 60%, with no line numbers, no
 * wrapping and a horizontal scrollbar at the bottom of the panel. Reading code was the one
 * thing that layout was for and the one thing it was worst at. It is an overlay now: the
 * tree keeps its height, the file gets all of it, and Escape or Back returns.
 *
 * Read-only and jailed host-side (`fs.read` resolves through `Workspace.resolve` like every
 * other path the sidecar accepts), so this cannot be used to look outside the folder you
 * opened.
 */

type Preview =
  | { kind: 'loading'; path: string }
  | { kind: 'loaded'; path: string; lines: string[]; truncated: boolean }
  | { kind: 'error'; path: string; message: string }

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
}

/**
 * Split out purely so the highlight can be memoised: this was the only unmemoised
 * `highlight()` call site left, and it re-tokenised the whole previewed file into
 * thousands of objects on every streamed token — the same sustained-allocation pattern
 * that took the renderer out of memory once already.
 */
function PreviewBody({ lines, ext, wrap }: { lines: string[]; ext: string; wrap: boolean }): VNode {
  const parts = useMemo(() => highlight(lines.join('\n'), ext), [lines, ext])
  return (
    <div class="preview-scroll">
      {/* Numbers are their own unselectable column against ONE `<pre>`, so copying the code
          never picks them up. They are hidden while wrapping, and that is a real trade
          rather than an oversight: a wrapped line occupies two rows and a numbers column
          beside it would be off by one from there down — a lying gutter is worse than
          none. */}
      {!wrap && (
        <pre class="preview-nums" aria-hidden="true">
          {lines.map((_, i) => i + 1).join('\n')}
        </pre>
      )}
      <pre class={`preview-code ${wrap ? 'preview-wrap' : ''}`}><code>{parts}</code></pre>
    </div>
  )
}

/**
 * A path where the FILENAME is the part that survives.
 *
 * Plain `text-overflow: ellipsis` on a narrow panel truncates the end, which is exactly the
 * half you need: `src/components/very/deep/thing…` tells you nothing. The directory shrinks
 * and the name never does.
 */
function PathLabel({ path }: { path: string }): VNode {
  const cut = path.lastIndexOf('/')
  return (
    <span class="preview-path" title={path}>
      {cut !== -1 && <span class="preview-dir">{path.slice(0, cut + 1)}</span>}
      <span class="preview-name">{cut === -1 ? path : path.slice(cut + 1)}</span>
    </span>
  )
}

/**
 * The DIFF face of an opened changed file: what this session did to it, with the two
 * things you can do about it. Put back restores EVERY path the change touched (for a
 * move that is the source and the destination — restoring only one deleted the file
 * outright), and says what it actually did; Reviewed dims the badge on the tree.
 */
function DiffFace({
  entry, client, reviewed, onMarkReviewed, onReverted,
}: {
  entry: ChangeEntry
  client: ProtocolClient
  reviewed: boolean
  onMarkReviewed?: (entry: ChangeEntry) => void
  onReverted?: () => void
}): VNode {
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)

  async function revert(): Promise<void> {
    setBusy(true)
    const results: string[] = []
    try {
      for (const path of entry.restorePaths) {
        const r = await client.call('checkpoints.restoreFile', {
          path, ...(note.trim() !== '' ? { note: note.trim() } : {}),
        })
        results.push(r.removed
          ? `${path} deleted — it did not exist before this session`
          : `${path} restored`)
      }
      setAsking(false)
      setNote('')
      setFailed(null)
      setOutcome(results.join(' · '))
      onReverted?.()
    } catch (e) {
      // A failure halfway is not a clean failure: whatever restored before it is already
      // on disk. Say both halves, and refresh the git status for the part that happened.
      const message = e instanceof Error ? e.message : String(e)
      setFailed(results.length > 0
        ? `${message} — already put back before the failure: ${results.join(' · ')}`
        : message)
      if (results.length > 0) onReverted?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="diff-face">
      <div class="diff-face-actions">
        {entry.ok && outcome === null && (
          <button class="btn btn-small" disabled={asking || busy} onClick={() => setAsking(true)}>
            Put back
          </button>
        )}
        {onMarkReviewed !== undefined && !reviewed && (
          <button
            class="btn btn-small"
            onClick={() => onMarkReviewed(entry)}
            title="Dim this change's badge on the tree — you have seen it and it is fine. A newer write brings it back."
          >
            {Icon.check()} Reviewed
          </button>
        )}
        {reviewed && <span class="tag">reviewed</span>}
      </div>
      {outcome !== null && <div class="revert-outcome">{outcome}</div>}
      {asking && (
        <div class="revert-box">
          <p>
            Restore <code>{entry.path}</code> to how it was before this session started, and
            tell the agent why. A file that did not exist then is <b>deleted</b>. Nothing
            else is touched.
          </p>
          {failed !== null && <div class="panel-error">{failed}</div>}
          <div class="revert-actions">
            <input
              class="input"
              value={note}
              placeholder="why it goes back (travels to the agent)"
              onInput={(e) => setNote(e.currentTarget.value)}
            />
            <button class="btn btn-small btn-danger" disabled={busy} onClick={() => void revert()}>
              {busy ? 'Putting back…' : 'Put back'}
            </button>
            <button class="btn btn-small" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div class="diff-face-body">
        {entry.ok
          ? <DiffView content={entry.content} />
          : <PanelError message={entry.content} />}
      </div>
    </div>
  )
}

export function FilesTab({
  client, toolItems, openPath, onOpenFile, workspaceRoot, decor, mounts, mountActions,
  changesByPath, filterChanged, reviewedPaths, onMarkReviewed, onReverted,
}: {
  client: ProtocolClient
  toolItems: ChatItem[]
  openPath: string | null
  onOpenFile: (path: string | null) => void
  /** Passed through to `TreePanel`, which uses it as its reset signal. */
  workspaceRoot: string
  /** Session-change badges for the unified Workspace view; absent = plain Files. */
  decor?: ChangeDecor
  /** Inline workspace management on the tree's own rows; absent = read-only tree. */
  mounts?: MountInfo[]
  mountActions?: MountActions
  /** The session's changes by openPath — what turns the preview into a DIFF view and
   * feeds Put back. Absent = plain Files, no diff affordances anywhere. */
  changesByPath?: ReadonlyMap<string, ChangeEntry>
  /** ONE view, filtered to what the session touched. */
  filterChanged?: boolean
  reviewedPaths?: ReadonlySet<string>
  onMarkReviewed?: (entry: ChangeEntry) => void
  /** A Put back changed the disk; whoever shows git status needs to hear about it. */
  onReverted?: () => void
}): VNode {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [wrap, setWrap] = useState(false)
  /** Which face of an opened CHANGED file is showing: its content, or its diff. */
  const [face, setFace] = useState<'file' | 'diff'>('file')

  useEffect(() => {
    if (openPath === null) {
      setPreview(null)
      return
    }
    setPreview({ kind: 'loading', path: openPath })
    // Two reads in flight resolve in whatever order the host answers. Without this the
    // slower one wins: the panel shows file A after you selected B, and re-selecting B
    // does nothing because `openPath` never changed.
    let cancelled = false
    client.call('fs.read', { path: openPath })
      .then((r) => {
        if (!cancelled) setPreview({ kind: 'loaded', path: openPath, lines: r.lines, truncated: r.truncated })
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setPreview({ kind: 'error', path: openPath, message: e instanceof Error ? e.message : String(e) })
        }
      })
    return () => { cancelled = true }
  }, [client, openPath])

  // Escape closes the file, not the app's other Escape-bound things: this listener only
  // exists while a preview is open, so a bare Escape still stops a turn the rest of the time.
  //
  // CAPTURE phase, and that is the whole protection: the composer's abort listener is a
  // bubble-phase listener on this same window, and stopPropagation between two same-phase
  // listeners on one EventTarget does nothing — registered later, this handler ran second,
  // and Esc on a preview closed it AND silently aborted the running turn. A capture
  // listener runs before window's bubble phase, and its stopPropagation ends the walk
  // before the abort handler is reached. One Esc, one action: close the file; the next
  // Esc, with no preview open, stops the turn as before.
  useEffect(() => {
    if (preview === null) return
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      // A capture listener runs before EVERY other Escape owner, so it must yield to
      // anything more immediate than a side-panel preview: an open dialog (settings,
      // palette), a composer picker, or the run card — each of those closes itself, and
      // consuming their Esc here closed a hidden preview instead.
      if (document.querySelector('.modal-overlay, .command-picker, .run-config') !== null) return
      e.stopPropagation()
      onOpenFile(null)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [preview, onOpenFile])

  const entry = preview !== null ? changesByPath?.get(preview.path) : undefined

  return (
    <div class="files-tab">
      <div class="files-tree">
        <TreePanel
          client={client}
          toolItems={toolItems}
          onOpenFile={(p) => { setFace('file'); onOpenFile(p) }}
          workspaceRoot={workspaceRoot}
          decor={decor}
          {...(mounts !== undefined ? { mounts } : {})}
          {...(mountActions !== undefined ? { mountActions } : {})}
          {...(filterChanged !== undefined ? { filterChanged } : {})}
          {...(reviewedPaths !== undefined ? { reviewedPaths } : {})}
          {...(changesByPath !== undefined
            ? { onOpenDiff: (p: string) => { setFace('diff'); onOpenFile(p) } }
            : {})}
        />
      </div>

      {preview && (
        <div class="preview">
          <div class="preview-head">
            <button class="icon-button" onClick={() => onOpenFile(null)} title="Back to the tree (Esc)">
              {Icon.arrowLeft()}
            </button>
            <PathLabel path={preview.path} />
            {face === 'file' && preview.kind === 'loaded' && preview.truncated && <span class="tag">truncated</span>}
            {/* An opened CHANGED file has two faces — its content and its diff — and the
                head switches between them. The badge doubles as the stat. */}
            {entry !== undefined && entry.ok && (
              <button
                class={`preview-face ${face === 'diff' ? 'preview-face-on' : ''}`}
                onClick={() => setFace((f) => (f === 'diff' ? 'file' : 'diff'))}
                title={face === 'diff' ? 'Show the file as it is now' : 'Show what this session changed'}
              >
                <DiffStatBadge stat={diffStat(entry.content)} />
                {entry.revisions > 1 && <span class="tag">{entry.revisions}×</span>}
              </button>
            )}
            {entry !== undefined && entry.lastFailed === true && <span class="tag tag-danger">last write failed</span>}
            {face === 'file' && preview.kind === 'loaded' && (
              <button
                class={`icon-button ${wrap ? 'icon-button-on' : ''}`}
                onClick={() => setWrap((w) => !w)}
                title={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
              >
                {Icon.wrap()}
              </button>
            )}
          </div>
          {face === 'diff' && entry !== undefined
            ? (
              <DiffFace
                entry={entry}
                client={client}
                reviewed={reviewedPaths?.has(preview.path) ?? false}
                {...(onMarkReviewed !== undefined ? { onMarkReviewed } : {})}
                {...(onReverted !== undefined ? { onReverted } : {})}
              />
              )
            : (
              <>
                {preview.kind === 'loading' && <div class="panel-placeholder loading-quiet">loading…</div>}
                {preview.kind === 'error' && <PanelError message={preview.message} />}
                {preview.kind === 'loaded' && (
                  <PreviewBody lines={preview.lines} ext={extensionOf(preview.path)} wrap={wrap} />
                )}
              </>
              )}
        </div>
      )}
    </div>
  )
}
