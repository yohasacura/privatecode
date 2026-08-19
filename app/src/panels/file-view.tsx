import { useEffect, useMemo, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import { DiffStatBadge, DiffView, diffStat } from '../lib/diff'
import { highlight } from '../lib/highlight'
import { Icon } from '../components/icons'
import { PanelError } from '../components/panel'
import type { ChangeEntry } from './changes-tab'

/**
 * One opened file, as a TAB beside the chat.
 *
 * The preview used to be an overlay inside the 420px side panel, which made reading code
 * the narrowest activity in the app. The owner's ruling: files and diffs are siblings of
 * the conversation — they open as tabs where the chat is, at the conversation's width,
 * and the chat keeps streaming underneath its own tab.
 *
 * Two faces. FILE is the content as it is now (read-only, jailed through `fs.read` like
 * every path the sidecar accepts). DIFF is what changed: the session's own change when
 * this session touched the file (with Put back and Reviewed), otherwise whatever is
 * uncommitted in git — so the letter on the tree always has a diff behind it.
 */

type Loaded =
  | { kind: 'loading' }
  | { kind: 'loaded'; lines: string[]; truncated: boolean }
  | { kind: 'error'; message: string }

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
}

/**
 * Split out purely so the highlight can be memoised — re-tokenising the whole file into
 * thousands of objects on every streamed token is the sustained-allocation pattern that
 * took the renderer out of memory once already.
 */
function PreviewBody({ lines, ext, wrap }: { lines: string[]; ext: string; wrap: boolean }): VNode {
  const parts = useMemo(() => highlight(lines.join('\n'), ext), [lines, ext])
  return (
    <div class="preview-scroll">
      {/* Numbers are their own unselectable column against ONE `<pre>`, so copying the code
          never picks them up. Hidden while wrapping: a wrapped line occupies two rows and a
          numbers column beside it would lie from there down. */}
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
 * A path where the FILENAME is the part that survives: the directory shrinks under
 * ellipsis and the name never does.
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
 * The DIFF face of a file this session changed: what the session did, with the two things
 * you can do about it. Put back restores EVERY path the change touched (for a move that is
 * the source and the destination); Reviewed dims the badge on the tree.
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

/**
 * The DIFF face of a file the session did NOT touch: whatever is uncommitted in git.
 * Fetched against HEAD first; an empty answer retries as untracked (`--no-index`), which
 * is how a brand-new file shows every line instead of nothing.
 */
function GitDiffFace({ client, path }: { client: ProtocolClient; path: string }): VNode {
  const [diff, setDiff] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDiff(null)
    setFailed(null)
    client.call('git.diff', { path, untracked: false })
      .then(async (r) => {
        if (r.diff.trim() !== '') return r.diff
        const u = await client.call('git.diff', { path, untracked: true })
        return u.diff
      })
      .then((d) => { if (!cancelled) setDiff(d) })
      .catch((e: Error) => { if (!cancelled) setFailed(e.message) })
    return () => { cancelled = true }
  }, [client, path])

  if (failed !== null) return <PanelError message={failed} />
  if (diff === null) return <div class="panel-placeholder loading-quiet">loading…</div>
  if (diff.trim() === '') return <div class="panel-placeholder">nothing uncommitted in this file</div>
  return <div class="diff-face"><div class="diff-face-body"><DiffView content={diff} /></div></div>
}

export function FileView({
  client, path, face, onFaceChange, entry, reviewed, onMarkReviewed, onReverted,
}: {
  client: ProtocolClient
  path: string
  face: 'file' | 'diff'
  /** The face is TAB state (it survives switching away and back), so the tab owns it. */
  onFaceChange: (face: 'file' | 'diff') => void
  /** This session's change to the file, when there is one — the diff face then carries
   * Put back and Reviewed. Absent, the diff face falls back to git. */
  entry: ChangeEntry | undefined
  reviewed: boolean
  onMarkReviewed?: (entry: ChangeEntry) => void
  /** A Put back changed the disk; whoever shows git status needs to hear about it. */
  onReverted?: () => void
}): VNode {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const [wrap, setWrap] = useState(false)

  useEffect(() => {
    setLoaded({ kind: 'loading' })
    // Two reads in flight resolve in whatever order the host answers; without the flag the
    // slower one wins and the tab shows a file it is not named after.
    let cancelled = false
    client.call('fs.read', { path })
      .then((r) => {
        if (!cancelled) setLoaded({ kind: 'loaded', lines: r.lines, truncated: r.truncated })
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoaded({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
        }
      })
    return () => { cancelled = true }
  }, [client, path])

  return (
    <div class="file-view">
      <div class="preview-head">
        <PathLabel path={path} />
        {face === 'file' && loaded.kind === 'loaded' && loaded.truncated && <span class="tag">truncated</span>}
        {/* The face toggle. With a session change it wears the diff stat; without one it
            is a plain diff glyph that answers with git. */}
        {entry !== undefined && entry.ok
          ? (
            <button
              class={`preview-face ${face === 'diff' ? 'preview-face-on' : ''}`}
              onClick={() => onFaceChange(face === 'diff' ? 'file' : 'diff')}
              title={face === 'diff' ? 'Show the file as it is now' : 'Show what this session changed'}
            >
              <DiffStatBadge stat={diffStat(entry.content)} />
              {entry.revisions > 1 && <span class="tag">{entry.revisions}×</span>}
            </button>
            )
          : (
            <button
              class={`icon-button ${face === 'diff' ? 'icon-button-on' : ''}`}
              onClick={() => onFaceChange(face === 'diff' ? 'file' : 'diff')}
              title={face === 'diff' ? 'Show the file as it is now' : 'Show what is uncommitted in this file'}
            >
              {Icon.diff()}
            </button>
            )}
        {entry !== undefined && entry.lastFailed === true && <span class="tag tag-danger">last write failed</span>}
        {face === 'file' && loaded.kind === 'loaded' && (
          <button
            class={`icon-button ${wrap ? 'icon-button-on' : ''}`}
            onClick={() => setWrap((w) => !w)}
            title={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
          >
            {Icon.wrap()}
          </button>
        )}
      </div>
      {face === 'diff'
        ? entry !== undefined
          ? (
            <DiffFace
              entry={entry}
              client={client}
              reviewed={reviewed}
              {...(onMarkReviewed !== undefined ? { onMarkReviewed } : {})}
              {...(onReverted !== undefined ? { onReverted } : {})}
            />
            )
          : <GitDiffFace client={client} path={path} />
        : (
          <>
            {loaded.kind === 'loading' && <div class="panel-placeholder loading-quiet">loading…</div>}
            {loaded.kind === 'error' && <PanelError message={loaded.message} />}
            {loaded.kind === 'loaded' && (
              <PreviewBody lines={loaded.lines} ext={extensionOf(path)} wrap={wrap} />
            )}
          </>
          )}
    </div>
  )
}
