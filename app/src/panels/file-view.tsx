import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { AlignLeft, Check, FileDiff, FileX, Search, Undo2 } from 'lucide-preact'
import type { FsReadResult, GitRepoView } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { DiffStatBadge, DiffView, diffStat } from '../lib/diff'
import { highlight } from '../lib/highlight'
import { Button, IconButton } from '../ui/button'
import { Chip } from '../ui/chip'
import { cn } from '../ui/cn'
import { Input } from '../ui/input'
import { Segmented } from '../ui/segmented'
import { PanelEmpty, PanelError, PanelLoading, PanelNote } from '../components/panel'
import type { ChangeEntry } from './changes-tab'

/**
 * One opened file, as a TAB beside the chat (docs/UI-REDESIGN-2026-09.md §7 "File and diff
 * tabs").
 *
 * The preview used to be an overlay inside the 420px side panel, which made reading code
 * the narrowest activity in the app. The owner's ruling: files and diffs are siblings of
 * the conversation — they open as tabs where the chat is, at the conversation's width,
 * and the chat keeps streaming underneath its own tab.
 *
 * Two faces. FILE is the content as it is now (read-only, jailed through `fs.read` like
 * every path the sidecar accepts), with line numbers, a wrap toggle and find-in-file. DIFF
 * is what changed: the session's own change when this session touched the file (with Put
 * back and Reviewed), otherwise whatever is uncommitted in git — so the letter on the tree
 * always has a diff behind it.
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

/** The host's "there is no such file", in the words each layer uses for it. */
export function isMissing(message: string): boolean {
  return /ENOENT|no such file|not found|does not exist|no longer exists/i.test(message)
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
}

const NO_LINES: string[] = []

/**
 * Split out purely so the highlight can be memoised — re-tokenising the whole file into
 * thousands of objects on every streamed token is the sustained-allocation pattern that
 * took the renderer out of memory once already.
 */
function PreviewBody({ lines, ext, wrap, jump }: {
  lines: string[]
  ext: string
  wrap: boolean
  /** A find hit to bring into view; `seq` makes the same line jumpable twice. */
  jump: { line: number; seq: number } | null
}): VNode {
  const parts = useMemo(() => highlight(lines.join('\n'), ext), [lines, ext])
  const scrollRef = useRef<HTMLDivElement>(null)
  const codeRef = useRef<HTMLPreElement>(null)
  // A hit scrolls into view by arithmetic rather than by a DOM node per line: the code is
  // one <pre>, so a line's offset is its index times the pre's line height.
  useEffect(() => {
    if (jump === null) return
    const el = scrollRef.current
    const pre = codeRef.current
    if (el === null || pre === null || lines.length === 0) return
    const lineHeight = pre.scrollHeight / lines.length
    el.scrollTop = Math.max(0, jump.line * lineHeight - el.clientHeight / 3)
  }, [jump, lines.length])
  return (
    <div ref={scrollRef} data-preview="" class="flex min-h-0 flex-1 items-start overflow-auto">
      {/* Numbers are their own unselectable column against ONE `<pre>`, so copying the code
          never picks them up. Hidden while wrapping: a wrapped line occupies two rows and a
          numbers column beside it would lie from there down. */}
      {!wrap && (
        <pre
          aria-hidden="true"
          class="sticky left-0 m-0 shrink-0 select-none bg-bg py-2 pl-2.5 pr-2 text-right font-mono text-[11.5px] leading-[1.55] text-ghost"
        >
          {lines.map((_, i) => i + 1).join('\n')}
        </pre>
      )}
      <pre
        ref={codeRef}
        data-code=""
        class={cn(
          'm-0 min-w-0 flex-1 py-2 pl-1 pr-3 font-mono text-[11.5px] leading-[1.55] text-dim',
          wrap && 'whitespace-pre-wrap break-words',
        )}
      >
        <code>{parts}</code>
      </pre>
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
    <span class="flex min-w-0 flex-1 font-mono text-[11.5px]" title={path}>
      {cut !== -1 && <span class="truncate text-faint">{path.slice(0, cut + 1)}</span>}
      <span class="shrink-0 text-fg">{cut === -1 ? path : path.slice(cut + 1)}</span>
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
    <div data-face="diff" class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center gap-1.5 border-b border-border-soft px-2.5 py-1.5">
        {entry.ok && shownOutcome === null && (
          <Button size="sm" icon={<Undo2 />} disabled={asking || busy} onClick={() => setAsking(true)} data-action="put-back">
            Put back
          </Button>
        )}
        {onMarkReviewed !== undefined && !reviewed && (
          <Button
            size="sm"
            icon={<Check />}
            onClick={() => onMarkReviewed(entry)}
            title="Dim this change's badge on the tree — you have seen it and it is fine. A newer write brings it back."
          >
            Reviewed
          </Button>
        )}
        {reviewed && <Chip tone="green" icon={<Check />}>reviewed</Chip>}
      </div>
      {shownOutcome !== null && <PanelNote tone="good">{shownOutcome}</PanelNote>}
      {asking && (
        <div
          data-confirm="put-back"
          class="mx-2.5 mt-2 rounded-md border border-red-line bg-red-soft p-2.5 font-ui text-[12.5px] leading-[1.45] text-fg"
        >
          <p class="m-0 mb-2">
            Restore <code>{entry.path}</code> to how it was before this session started, and
            tell the agent why. A file that did not exist then is <b>deleted</b>. Nothing
            else is touched.
          </p>
          {shownFailure !== null && <PanelError message={shownFailure} />}
          <div class="flex flex-wrap items-center gap-1.5">
            <Input
              class="min-w-[150px] flex-1"
              value={note}
              placeholder="why it goes back (travels to the agent)"
              aria-label="Why it goes back"
              onInput={(e) => setNote(e.currentTarget.value)}
            />
            <Button size="sm" variant="danger" disabled={busy} loading={busy} onClick={() => void revert()}>
              Put back
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setAsking(false)}>Cancel</Button>
          </div>
        </div>
      )}
      <div class="min-h-0 overflow-auto px-3.5 pb-3 pt-2">
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
  const [tries, setTries] = useState(0)

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
  }, [client, path, tries])

  if (failed !== null) return <PanelError message={failed} onRetry={() => setTries((n) => n + 1)} />
  if (diff === null) return <PanelLoading />
  if (diff.trim() === '') {
    return <PanelEmpty icon={<FileDiff />} title="Nothing uncommitted in this file" hint="Git has the same bytes as the disk." />
  }
  return (
    <div data-face="diff" class="flex min-h-0 flex-1 flex-col">
      <div class="min-h-0 overflow-auto px-3.5 pb-3 pt-2"><DiffView content={diff} /></div>
    </div>
  )
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
  const [reads, setReads] = useState(0)
  // Find in file: null while closed, the query while open.
  const [find, setFind] = useState<string | null>(null)
  const [at, setAt] = useState(0)
  const [jump, setJump] = useState<{ line: number; seq: number } | null>(null)
  const findRef = useRef<HTMLInputElement>(null)

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
  }, [client, path, reads])

  const lines = loaded.kind === 'loaded' ? loaded.lines : NO_LINES
  const matches = useMemo(() => {
    const q = (find ?? '').trim().toLowerCase()
    if (q === '') return []
    const out: number[] = []
    lines.forEach((line, i) => { if (line.toLowerCase().includes(q)) out.push(i) })
    return out
  }, [lines, find])

  function goTo(index: number): void {
    if (matches.length === 0) return
    const i = ((index % matches.length) + matches.length) % matches.length
    setAt(i)
    setJump((j) => ({ line: matches[i]!, seq: (j?.seq ?? 0) + 1 }))
  }
  // A new query lands on its first hit.
  useEffect(() => {
    setAt(0)
    if (matches.length > 0) setJump((j) => ({ line: matches[0]!, seq: (j?.seq ?? 0) + 1 }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the hits, not the setter
  }, [matches])

  function openFind(): void {
    setFind((f) => f ?? '')
    requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select() })
  }

  const missing = loaded.kind === 'error' && isMissing(loaded.message)
  const faces = [
    { value: 'file' as const, label: 'File', hint: 'The file as it is now' },
    {
      value: 'diff' as const,
      label: 'Diff',
      hint: entry !== undefined && entry.ok ? 'What this session changed' : 'What is uncommitted in this file',
    },
  ]

  return (
    <div
      data-file-view=""
      tabIndex={-1}
      class="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && face === 'file') {
          e.preventDefault()
          openFind()
        }
      }}
    >
      <div class="flex shrink-0 items-center gap-2 border-b border-border-soft bg-panel py-1 pl-2.5 pr-2 font-ui">
        <PathLabel path={path} />
        {face === 'file' && loaded.kind === 'loaded' && loaded.truncated && (
          <Chip tone="yellow" title="The host reads the first 2,000 lines of a file into a tab">first 2,000 lines</Chip>
        )}
        {entry !== undefined && entry.lastFailed === true && <Chip tone="red">last write failed</Chip>}
        {entry !== undefined && entry.ok && (
          <Chip mono title={entry.revisions > 1 ? `Written ${entry.revisions} times this session` : 'What this session changed'}>
            <DiffStatBadge stat={diffStat(entry.content)} />
            {entry.revisions > 1 && <span class="ml-1">{entry.revisions}×</span>}
          </Chip>
        )}
        <Segmented size="sm" label="Show the file or its diff" options={faces} value={face} onChange={onFaceChange} />
        {face === 'file' && loaded.kind === 'loaded' && (
          <>
            <IconButton
              size="sm"
              label={find === null ? 'Find in file (Ctrl+F)' : 'Close find'}
              active={find !== null}
              onClick={() => (find === null ? openFind() : setFind(null))}
            >
              <Search />
            </IconButton>
            <IconButton
              size="sm"
              label={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
              active={wrap}
              onClick={() => setWrap((w) => !w)}
            >
              <AlignLeft />
            </IconButton>
          </>
        )}
      </div>

      {face === 'file' && find !== null && loaded.kind === 'loaded' && (
        <div data-find="" class="flex shrink-0 items-center gap-2 border-b border-border-soft bg-panel px-2 py-1 font-ui">
          <Input
            ref={findRef}
            class="h-6 max-w-[260px] text-[12px]"
            value={find}
            placeholder="find in file"
            aria-label="Find in file"
            onInput={(e) => setFind(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); goTo(at + (e.shiftKey ? -1 : 1)) }
              else if (e.key === 'Escape') { e.stopPropagation(); setFind(null) }
            }}
          />
          <span class="text-[11.5px] tabular-nums text-faint" data-find-count="" aria-live="polite">
            {find.trim() === '' ? '' : matches.length === 0 ? 'no matches' : `${at + 1} of ${matches.length}`}
          </span>
          <span class="text-[11px] text-faint">Enter next · Shift+Enter previous · Esc closes</span>
        </div>
      )}

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
            {loaded.kind === 'loading' && <PanelLoading />}
            {loaded.kind === 'error' && (missing
              ? (
                <PanelEmpty
                  icon={<FileX />}
                  title="This file no longer exists"
                  hint={entry !== undefined
                    ? 'It was deleted or moved since it was opened. The diff face still shows what this session did to it.'
                    : 'It was deleted or moved since it was opened.'}
                  action={
                    <span class="flex gap-1.5">
                      <Button size="sm" onClick={() => setReads((n) => n + 1)}>Try again</Button>
                      {entry !== undefined && <Button size="sm" variant="ghost" onClick={() => onFaceChange('diff')}>Show the diff</Button>}
                    </span>
                  }
                />
                )
              : <PanelError message={loaded.message} onRetry={() => setReads((n) => n + 1)} />)}
            {loaded.kind === 'loaded' && (
              <PreviewBody lines={loaded.lines} ext={extensionOf(path)} wrap={wrap} jump={jump} />
            )}
            {/* The image itself, at its own size inside the same scroller the text face
                uses — `.shot img` caps it at the pane's width. The caption carries the byte
                size because that is the one thing about an image the picture cannot say,
                and it is what tells a screenshot apart from a 4 MB asset. */}
            {loaded.kind === 'image' && (
              <div class="flex min-h-0 flex-1 items-start overflow-auto">
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
