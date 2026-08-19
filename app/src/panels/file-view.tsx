import { useEffect, useMemo, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { FsReadResult, GitRepoView } from '@core/host/protocol'
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
  | { kind: 'image'; dataUrl: string; bytes: number }
  | { kind: 'error'; message: string }

/**
 * What one `fs.read` answer becomes on screen.
 *
 * `fs.read` answers for a PNG/JPG/GIF/WebP/BMP/SVG with `lines: []` and an `image` payload
 * (host.ts's `IMAGE_TYPES`), and the tab used to keep only the lines: clicking any image in
 * the tree — the agent's own browser screenshots included, whose entire audience is the
 * person, since the model has no vision tower — opened a tab named after the file with a
 * completely blank body, no image and no explanation. Pure and exported for its test.
 */
export function loadedFrom(result: FsReadResult): Loaded {
  return result.image !== undefined
    ? { kind: 'image', dataUrl: result.image.dataUrl, bytes: result.image.bytes }
    : { kind: 'loaded', lines: result.lines, truncated: result.truncated }
}

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
 * Something a Put back attempt left on screen, tagged with the change it was about.
 *
 * The tag is the whole point. `collectChanges` keys one entry per path and replaces it —
 * new `id`, new diff — every time the agent writes that path again, so a tab left open on a
 * reverted file gets handed a NEW change in place of the one that was put back. Judging
 * "already reverted" by a bare string then left the old "src/a.ts restored" line sitting
 * above the newer diff with Put back — gated on that same string — hidden, so the newer
 * change could not be put back from the tab at all until the tab was switched away and back.
 */
interface RevertNote { entryId: number; text: string }

/** The note, if it still describes the change currently on screen. Pure and exported for
 * its test. */
export function noteFor(entry: ChangeEntry, note: RevertNote | null): string | null {
  return note !== null && note.entryId === entry.id ? note.text : null
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
  const [failed, setFailed] = useState<RevertNote | null>(null)
  const [outcome, setOutcome] = useState<RevertNote | null>(null)
  // Both notes are about ONE version of the change; a newer write to the same path is a
  // different change, and neither its outcome line nor its failure belongs to it.
  const shownOutcome = noteFor(entry, outcome)
  const shownFailure = noteFor(entry, failed)

  async function revert(): Promise<void> {
    setBusy(true)
    const results: string[] = []
    const entryId = entry.id
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
      setOutcome({ entryId, text: results.join(' · ') })
      onReverted?.()
    } catch (e) {
      // A failure halfway is not a clean failure: whatever restored before it is already
      // on disk. Say both halves, and refresh the git status for the part that happened.
      const message = e instanceof Error ? e.message : String(e)
      setFailed({
        entryId,
        text: results.length > 0
          ? `${message} — already put back before the failure: ${results.join(' · ')}`
          : message,
      })
      if (results.length > 0) onReverted?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="diff-face">
      <div class="diff-face-actions">
        {entry.ok && shownOutcome === null && (
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
      {shownOutcome !== null && <div class="revert-outcome">{shownOutcome}</div>}
      {asking && (
        <div class="revert-box">
          <p>
            Restore <code>{entry.path}</code> to how it was before this session started, and
            tell the agent why. A file that did not exist then is <b>deleted</b>. Nothing
            else is touched.
          </p>
          {shownFailure !== null && <div class="panel-error">{shownFailure}</div>}
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
 * Whether an empty `git diff HEAD` answer for this path means "the file is NEW" rather than
 * "the file is clean" — the only case where asking for the untracked diff is honest.
 *
 * Two shapes qualify, and both come from git status rather than from the empty diff itself:
 * an untracked file (`??`), which has no HEAD side at all; and a file with an `A` in its
 * status pair in a repository that has no commits yet, where `git diff HEAD` fails outright
 * (no HEAD to name) and so also answers with nothing. A staged add in a repository that
 * DOES have commits never reaches here — its HEAD diff is the whole file already.
 *
 * Matching is on the workspace-addressed path git reports, with a case-insensitive second
 * pass: git names the file as it sits on disk, while a tab opened from a tool card carries
 * whatever spelling the model typed, and on Windows `src/App.tsx` and `src/app.tsx` are one
 * file. Pure and exported for its test.
 */
export function wantsUntrackedDiff(repos: readonly GitRepoView[], path: string): boolean {
  const lower = path.toLowerCase()
  let loose: { code: string; untracked: boolean } | undefined
  for (const repo of repos) {
    for (const file of repo.files) {
      if (file.path === path) return file.untracked || file.code.includes('A')
      if (loose === undefined && file.path.toLowerCase() === lower) loose = file
    }
  }
  return loose !== undefined && (loose.untracked || loose.code.includes('A'))
}

/**
 * The DIFF face of a file the session did NOT touch: whatever is uncommitted in git.
 *
 * Two questions, not one. `git diff HEAD -- path` is the answer for a tracked file, but an
 * untracked file has no HEAD side, so git says nothing about it and a brand-new file would
 * read as unchanged. Its answer is `git diff --no-index -- /dev/null path`, which ignores
 * the index entirely and renders EVERY line as an addition — true for a new file, and a
 * flat lie for a clean tracked one. Asking for it on ANY empty HEAD diff, as this used to,
 * meant opening a file nobody had touched and being shown the whole thing painted green
 * under a control titled "show what is uncommitted in this file"; the placeholder below was
 * unreachable for every non-empty file in a repository. So the retry is gated on git status
 * calling the path new (`wantsUntrackedDiff`) — anything else with an empty HEAD diff has
 * nothing uncommitted, and says so.
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
        const status = await client.call('git.status', {})
        if (!wantsUntrackedDiff(status.repos, path)) return ''
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
        if (!cancelled) setLoaded(loadedFrom(r))
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
            {/* The image itself, at its own size inside the same scroller the text face
                uses — `.shot img` caps it at the pane's width. The caption carries the byte
                size because that is the one thing about an image the picture cannot say,
                and it is what tells a screenshot apart from a 4 MB asset. */}
            {loaded.kind === 'image' && (
              <div class="preview-scroll">
                <figure class="shot">
                  <img src={loaded.dataUrl} alt={path} />
                  <figcaption>{Math.max(1, Math.round(loaded.bytes / 1024))} KB</figcaption>
                </figure>
              </div>
            )}
          </>
          )}
    </div>
  )
}
