import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import {
  ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Lock, LockOpen, Minus, MoreHorizontal,
  PencilLine, Plus, Search, Trash2, TriangleAlert,
} from 'lucide-preact'
import type { ProtocolClient } from '../lib/client'
import { compareTreeRows, type ChangeDecor } from '../lib/path-tree'
import type { ChatItem } from '../lib/state'
import { describeMark, type GhostRow, type GitLetter, type GitMark } from '../lib/git-scm'
import { Icon } from '../components/icons'
import { PanelEmpty, PanelLoading } from '../components/panel'
import { DRAG_THRESHOLD_PX, beginPathDrag, endPathDrag, movePathDrag } from '../lib/drag'
import { Button, IconButton } from '../ui/button'
import { Chip } from '../ui/chip'
import { cn } from '../ui/cn'
import { Input } from '../ui/input'
import { Menu } from '../ui/menu'

/**
 * The file tree (docs/UI-REDESIGN-2026-09.md §7 "Files"): lazy-loaded directories over
 * `fs.tree`, refreshed automatically when a write-family tool succeeds against a directory
 * the tree has already loaded, and a click on a file hands its path to `onOpenFile` (wired
 * by `App.tsx` to a tab beside the chat -- the tree itself never calls `fs.read`).
 *
 * Rows are 28px, folders open, files carry their kind, a changed file wears its diff shape
 * and its git letter on the right, staged rows are tinted. A mount's row carries its own
 * management in a menu. A folder that cannot be read says "access denied" and offers a
 * retry; a find box searches the host's index rather than the rows on screen.
 */

/** One directory's lazily-fetched listing. `entries: null` means "never fetched, or a
 * fetch is currently in flight with nothing cached yet" -- distinct from `[]`, an
 * genuinely empty directory. */
interface DirState {
  entries: { name: string; dir: boolean }[] | null
  loading: boolean
  error: string | null
}

function dirOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? '' : normalized.slice(0, idx)
}

/**
 * The tree-refresh path parser: given a write-family tool's name and its raw `tool.call`
 * args JSON, returns the workspace-relative directories a successful call just changed the
 * CONTENTS of -- `edit_file`/`write_file`/`delete_file` each name one directory (the parent
 * of `path`); `move_file` can name up to two (the parent of `from` AND of `to`,
 * deduplicated -- a move within the same directory returns just one). Any other tool name,
 * or JSON that does not parse or does not carry the expected string field(s), returns `[]`
 * rather than throwing.
 */
export function affectedDirectories(name: string, args: string): string[] {
  let obj: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(args)
    if (typeof parsed !== 'object' || parsed === null) return []
    obj = parsed as Record<string, unknown>
  } catch {
    return []
  }
  if (name === 'move_file') {
    const from = obj['from']
    const to = obj['to']
    const dirs = new Set<string>()
    if (typeof from === 'string') dirs.add(dirOf(from))
    if (typeof to === 'string') dirs.add(dirOf(to))
    return [...dirs]
  }
  if (name === 'edit_file' || name === 'write_file' || name === 'delete_file') {
    const path = obj['path']
    return typeof path === 'string' ? [dirOf(path)] : []
  }
  return []
}

/**
 * Press, move, drop: one tree row on its way to the composer.
 *
 * A module-level function, not a hook, because none of it is component state — the drag
 * store is module-level and the listeners live on `window` for exactly as long as the
 * button is held. Written as press-then-threshold rather than starting on the press itself
 * so that a row remains, first and foremost, a button you click to open a file.
 */
function startRowDrag(e: PointerEvent, path: string): void {
  // Left button only. A right-click opens no menu here today, but starting a drag from one
  // would be wrong the moment it does, and middle-drag is a scroll gesture on many mice.
  if (e.button !== 0) return

  const startX = e.clientX
  const startY = e.clientY
  let dragging = false

  // Pointer capture, so the moves keep arriving even when the pointer leaves the row — which
  // it does immediately, since the whole gesture is about ending up somewhere else. Captured
  // events still bubble to `window`, so the listeners below stay where they are. Guarded
  // because a row can be removed mid-gesture by a refresh, and capturing on a detached
  // element throws.
  const row = e.currentTarget
  if (row instanceof Element) {
    try { row.setPointerCapture(e.pointerId) } catch { /* the row went away; the window listeners still work */ }
  }

  function move(ev: PointerEvent): void {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return
      dragging = true
      beginPathDrag([path], ev.clientX, ev.clientY)
      return
    }
    movePathDrag(ev.clientX, ev.clientY)
  }

  function up(): void {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    if (!dragging) return

    // Ends the drag whatever happened to it — dropped on the composer, dropped on nothing,
    // dropped on another panel. The composer got its chance already: its listener is
    // registered in the CAPTURE phase on window, which the DOM runs before any bubble-phase
    // listener on the same event, so "the composer decides, then this cleans up" is an
    // ordering guarantee rather than a hope about registration order.
    endPathDrag()

    // The row's click fires after pointerup, and after a drag it would ALSO open the file
    // in a tab — two outcomes from one gesture. Swallowed once, on the way up.
    const swallow = (c: Event): void => { c.stopPropagation(); c.preventDefault() }
    window.addEventListener('click', swallow, { capture: true, once: true })
  }

  function cancel(): void {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    if (dragging) endPathDrag()
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
}

/** A workspace mount, as the tree's top-level row knows it. */
export interface MountInfo {
  name: string
  primary: boolean
  access: 'write' | 'read'
  git: string
}

/** What the inline management can DO — wired by the workspace tab, which owns the
 * workspace.set + re-open flow. Every action applies immediately: the folders on the
 * tree ARE the workspace, and a draft/save layer over them read as a second, redundant
 * panel (the user's verdict: clunky). */
export interface MountActions {
  toggleAccess(name: string): void
  remove(name: string): void
  rename(name: string, next: string): void
  /** True while a change is applying (the workspace re-opens); controls disable. */
  busy: boolean
}

/** Stage and unstage, right on the row that shows the change. Wired by the workspace
 * tab, which owns the git status and its reload. */
export interface GitRowActions {
  stage(path: string): void
  unstage(path: string): void
  /** True while a git call is in flight; the row actions ignore clicks. */
  busy: boolean
}

/** One row's chrome. `group/row` lets the hover-only controls inside it appear. */
const ROW = cn(
  'group/row flex h-7 w-full min-w-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap',
  'border-0 bg-transparent pr-1 text-left font-ui text-[13px] text-dim',
  'transition-colors duration-(--duration-fast) hover:bg-raised hover:text-fg',
  'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
)
/* Staged = chosen for the commit — the row itself says so (the owner asked for staged files
   highlighted, not a checkbox column). */
const STAGED = 'bg-(--user-wash) shadow-[inset_2px_0_0_var(--accent)] hover:bg-accent-soft'

const NAME_TONE: Record<GitLetter, string> = {
  M: 'text-yellow', R: 'text-yellow', A: 'text-green', U: 'text-green', D: 'text-red', '!': 'text-red font-semibold',
}

function indent(depth: number): { paddingLeft: string } {
  return { paddingLeft: `${depth * 12 + 6}px` }
}

/**
 * The git cluster on a changed file's row: hover actions first, then the letter.
 *
 * Spans with click handlers, not buttons — the row itself is a button and buttons cannot
 * nest. The letter is always visible; `+`/`−` appear on row hover, and an invisible
 * control is also an unclickable one (pointer-events), so a blind click cannot stage.
 */
function GitCluster({
  path, mark, actions,
}: {
  path: string
  mark: GitMark
  actions: GitRowActions | undefined
}): VNode {
  const act = 'inline-flex items-center rounded-sm text-dim opacity-0 pointer-events-none transition-opacity duration-(--duration-fast) ' +
    'group-hover/row:opacity-100 group-hover/row:pointer-events-auto group-focus-visible/row:opacity-100 group-focus-visible/row:pointer-events-auto ' +
    'hover:bg-raised hover:text-fg [&>svg]:size-[13px]'
  return (
    <span class="inline-flex shrink-0 items-center gap-0.5" data-git={mark.letter}>
      {actions !== undefined && mark.dirty && mark.letter !== '!' && (
        <span
          class={act}
          role="button"
          tabIndex={-1}
          title="Stage — include this file in the next commit"
          onClick={(e) => { e.stopPropagation(); if (!actions.busy) actions.stage(path) }}
        >
          <Plus />
        </span>
      )}
      {/* A conflict is not a thing to stage or unstage from a hover: `git add` would
          declare it resolved with the markers still in the file, and `git reset` would
          throw away the merge bookkeeping. The letter alone, loudly. */}
      {actions !== undefined && mark.staged && mark.letter !== '!' && (
        <span
          class={act}
          role="button"
          tabIndex={-1}
          title="Unstage — keep the change, take it out of the commit"
          onClick={(e) => { e.stopPropagation(); if (!actions.busy) actions.unstage(path) }}
        >
          <Minus />
        </span>
      )}
      {/* Last in the row, and a fixed-width box: every mark in the tree then lands on the
          same x whatever else the row carries — a diff stat, a read-only tag, the hover
          actions that appear to its left. */}
      <span
        class={cn('inline-flex h-4 w-[18px] shrink-0 items-center justify-center [&>svg]:size-[13px]', NAME_TONE[mark.letter])}
        title={describeMark(mark)}
      >
        {Icon.gitMark(mark.letter, mark.staged)}
      </span>
    </span>
  )
}

export function TreePanel({
  client, toolItems, onOpenFile, workspaceRoot, decor, mounts, mountActions,
  filterChanged, reviewedPaths, onOpenDiff, git, gitActions, ghosts, reloadKey, find, onReveal,
}: {
  client: ProtocolClient
  /**
   * Bumped when something OUTSIDE this session touched the disk — a Put back, or the
   * window regaining focus after a branch switch in another editor.
   *
   * The tree used to refresh only where a write TOOL had been, so a branch switch left it
   * showing files that no longer existed and hiding files that now did. Re-fetching only
   * the directories already loaded (rather than resetting to the root) is what makes this
   * usable: the expanded shape of a tree is a place you navigated to, and throwing it away
   * on every alt-tab would be a worse bug than the stale rows.
   */
  reloadKey: number
  toolItems: ChatItem[]
  onOpenFile: (path: string) => void
  /**
   * The workspace these paths belong to. Not displayed — it is the reset signal.
   *
   * Opening a different workspace does NOT replace `client` (the same socket serves every
   * workspace this process ever opens), so an effect keyed on `client` alone never re-runs
   * and the panel goes on showing the previous project's files under the new project's
   * name. Found by opening a second workspace in the running app: the tree still listed
   * `src/`, `tests/` and `AGENTS.md` from the workspace before it, none of which existed
   * in the new one. Clicking one would have asked the host for a path outside the jail.
   */
  workspaceRoot: string
  /** Session-change overlay for the unified Workspace view: badges on changed files and
   * change counts on the directories that contain them. Absent = the plain Files tree. */
  decor: ChangeDecor | undefined
  /** The workspace's folder set, for inline management ON the top-level rows. Absent =
   * a plain read-only tree (the standalone Files context). */
  mounts?: MountInfo[]
  mountActions?: MountActions
  /** ONE view, filtered — the owner's ruling on «All files vs Changes»: when true, only
   * rows the session touched render (the decor is the filter). */
  filterChanged?: boolean
  /** Files whose change has been looked at; their badges dim. */
  reviewedPaths?: ReadonlySet<string>
  /** Clicking a change badge jumps straight to the DIFF, not the file body. */
  onOpenDiff?: (path: string) => void
  /** Git worn ON the rows: one letter per changed file, staged rows highlighted. */
  git?: ReadonlyMap<string, GitMark>
  /** Stage/unstage on hover, next to the letter. */
  gitActions?: GitRowActions
  /** Deleted files, grouped by parent directory — rows the disk listing cannot have. */
  ghosts?: ReadonlyMap<string, GhostRow[]>
  /** A name to find. Non-empty replaces the tree with what the host's index matches;
   * null or empty shows the tree. The index, not the rows: a tree of fifty thousand files
   * has loaded a few hundred of them. */
  find?: string | null
  /** A found folder was chosen: the tree has opened the way to it and the find can close. */
  onReveal?: () => void
}) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  // Read inside effects/callbacks that must not re-run on every `dirs` change themselves
  // (loadDir already updates `dirs` via a functional setState, so it never needs to read
  // this) -- used only to decide "has this directory ever been loaded" without adding
  // `dirs` to the tool-processing effect's own dependency array.
  const dirsRef = useRef(dirs)
  dirsRef.current = dirs
  const processedToolIds = useRef(new Set<number>())

  function loadDir(path: string): void {
    setDirs((prev) => ({ ...prev, [path]: { entries: prev[path]?.entries ?? null, loading: true, error: null } }))
    client.call('fs.tree', { path })
      .then((result) => {
        setDirs((prev) => ({ ...prev, [path]: { entries: result.entries, loading: false, error: null } }))
      })
      .catch((e: unknown) => {
        setDirs((prev) => ({
          ...prev,
          [path]: { entries: prev[path]?.entries ?? null, loading: false, error: e instanceof Error ? e.message : String(e) },
        }))
      })
  }

  // Every piece of state here is about ONE workspace: which directories were loaded, which
  // were expanded, and which tool results have already been folded in. On a switch they are
  // all wrong at once, so they are all discarded together and the root is re-fetched.
  useEffect(() => {
    setDirs({})
    setExpanded(new Set(['']))
    processedToolIds.current = new Set()
    loadDir('')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadDir is stable per client
  }, [client, workspaceRoot])

  // An external change re-reads every directory the tree is currently showing, and leaves
  // `expanded` alone. Skipped on the first render (`reloadKey` starts at 0 and the mount
  // effect above already fetched the root) so this does not double-fetch on open.
  const lastReload = useRef(reloadKey)
  useEffect(() => {
    if (lastReload.current === reloadKey) return
    lastReload.current = reloadKey
    for (const path of Object.keys(dirsRef.current)) loadDir(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadDir is stable per client
  }, [reloadKey])

  // Refresh: a write-family tool succeeding against a directory the tree ALREADY has
  // loaded gets that one directory re-fetched. `processedToolIds` guards against handling
  // the same completed tool item twice across re-renders (this effect re-runs on every
  // `toolItems` change, i.e. on every new chat event, not just tool.result ones).
  useEffect(() => {
    for (const item of toolItems) {
      if (item.kind !== 'tool' || item.result === undefined) continue
      if (processedToolIds.current.has(item.id)) continue
      processedToolIds.current.add(item.id)
      if (!item.result.ok) continue
      for (const dir of affectedDirectories(item.name, item.args)) {
        // Walk UP to the nearest directory the tree has actually loaded. The affected dir
        // is the file's immediate parent — for a write into a freshly created folder that
        // parent was never loaded, the event was dropped, and the new folder stayed
        // invisible until a remount. The loaded ANCESTOR's contents did change (it gained
        // the folder), so that is the one to re-fetch.
        let target: string | undefined = dir
        while (target !== undefined && dirsRef.current[target] === undefined) {
          target = target === '' ? undefined : (target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '')
        }
        if (target !== undefined) loadDir(target)
      }
    }
  }, [toolItems])

  function toggle(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        if (dirsRef.current[path] === undefined) loadDir(path)
      }
      return next
    })
  }

  /** Open every folder on the way to `path`, loading the ones the tree has not seen. */
  function reveal(path: string): void {
    const parts = path.split('/')
    const ancestors: string[] = []
    for (let i = 1; i <= parts.length; i++) ancestors.push(parts.slice(0, i).join('/'))
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const a of ancestors) {
        next.add(a)
        if (dirsRef.current[a] === undefined) loadDir(a)
      }
      return next
    })
    onReveal?.()
  }

  const query = (find ?? '').trim()
  if (query !== '') {
    return (
      <FindResults
        client={client}
        query={query}
        onOpenFile={onOpenFile}
        onOpenFolder={reveal}
      />
    )
  }

  return (
    <div data-tree="" class="font-ui text-[13px]">
      <DirChildren
        path="" dirs={dirs} expanded={expanded} onToggle={toggle} onOpenFile={onOpenFile}
        onRetry={loadDir} depth={0} decor={decor}
        {...(mounts !== undefined ? { mounts } : {})}
        {...(mountActions !== undefined ? { mountActions } : {})}
        {...(filterChanged !== undefined ? { filterChanged } : {})}
        {...(reviewedPaths !== undefined ? { reviewedPaths } : {})}
        {...(onOpenDiff !== undefined ? { onOpenDiff } : {})}
        {...(git !== undefined ? { git } : {})}
        {...(gitActions !== undefined ? { gitActions } : {})}
        {...(ghosts !== undefined ? { ghosts } : {})}
      />
      {filterChanged === true && decor !== undefined && decor.files.size === 0 && (
        <div class="px-2 py-1 text-[11.5px] text-faint">nothing changed this session</div>
      )}
    </div>
  )
}

/**
 * What the host's file index says matches the query: files and folders, as rows that open
 * or reveal. Asked after a short pause so a name typed at speed costs one round trip.
 */
function FindResults({
  client, query, onOpenFile, onOpenFolder,
}: {
  client: ProtocolClient
  query: string
  onOpenFile: (path: string) => void
  onOpenFolder: (path: string) => void
}): VNode {
  const [hits, setHits] = useState<{ path: string; dir: boolean }[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setFailed(null)
    const id = setTimeout(() => {
      client.call('fs.find', { query, limit: 60 })
        .then((r) => { if (!cancelled) setHits(r.entries) })
        .catch((e: unknown) => { if (!cancelled) setFailed(e instanceof Error ? e.message : String(e)) })
    }, 120)
    return () => { cancelled = true; clearTimeout(id) }
  }, [client, query])

  if (failed !== null) {
    return <div data-tree-find="" class="px-2.5 py-2 font-ui text-[12px] text-red">{failed}</div>
  }
  if (hits === null) return <div data-tree-find=""><PanelLoading what="looking…" /></div>
  if (hits.length === 0) {
    return (
      <div data-tree-find="">
        <PanelEmpty icon={<Search />} title={`No files match “${query}”`} hint="Names are matched anywhere in the path." />
      </div>
    )
  }
  return (
    <div data-tree-find="" class="font-ui text-[13px]">
      {hits.map((h) => (
        <button
          key={h.path}
          type="button"
          data-tree-row={h.path}
          class={ROW}
          style={indent(0)}
          title={h.dir ? `${h.path} — open it in the tree` : h.path}
          onClick={() => (h.dir ? onOpenFolder(h.path) : onOpenFile(h.path))}
        >
          <span class={cn('flex shrink-0 [&>svg]:size-3.5', h.dir ? 'text-blue opacity-75' : 'text-faint')}>
            {h.dir ? <Folder /> : <FileText />}
          </span>
          <span data-tree-name="" class="min-w-0 flex-1 truncate font-mono text-[12px]">{h.path}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * The management cluster on a mount's own row: a menu, hidden until the row is hovered so
 * the tree stays a tree, and a two-step remove that is an inline question rather than a
 * dialog — a stray click must not silently unmount a project, and a dialog for an action
 * this reversible would be ceremony.
 */
function MountControls({ mount, actions }: { mount: MountInfo; actions: MountActions }): VNode {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  if (mount.primary) {
    return (
      <Chip class="mr-1.5 h-4 shrink-0 px-1.5 text-[10px]" title="The main folder — sessions, checkpoints and workspace settings live here">
        main
      </Chip>
    )
  }
  if (renaming !== null) {
    return (
      <Input
        data-rename-folder=""
        class="mr-1.5 h-6 w-40 text-[12px]"
        value={renaming}
        aria-label="New name for the folder"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onInput={(e) => setRenaming(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && renaming.trim() !== '') { actions.rename(mount.name, renaming.trim()); setRenaming(null) }
          if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null) }
        }}
      />
    )
  }
  if (confirming) {
    return (
      <span data-confirm="remove-folder" class="mr-1.5 flex shrink-0 items-center gap-1 font-ui text-[11.5px]">
        <span class="text-fg">Remove from the workspace?</span>
        <Button size="sm" variant="danger" disabled={actions.busy} onClick={() => { setConfirming(false); actions.remove(mount.name) }}>
          Remove
        </Button>
        <Button size="sm" disabled={actions.busy} onClick={() => setConfirming(false)}>Keep</Button>
      </span>
    )
  }
  return (
    <span class="mr-1 shrink-0 opacity-0 transition-opacity duration-(--duration-fast) focus-within:opacity-100 group-hover/mount:opacity-100">
      <Menu
        label={`Actions for ${mount.name}`}
        items={[
          {
            id: 'access',
            label: mount.access === 'read' ? 'Allow writes' : 'Make read-only',
            icon: mount.access === 'read' ? <LockOpen /> : <Lock />,
            disabled: actions.busy,
            onSelect: () => actions.toggleAccess(mount.name),
          },
          { id: 'rename', label: 'Rename…', icon: <PencilLine />, disabled: actions.busy, onSelect: () => setRenaming(mount.name) },
          { id: 'remove', label: 'Remove from workspace…', icon: <Trash2 />, danger: true, disabled: actions.busy, onSelect: () => setConfirming(true) },
        ]}
        trigger={(p) => <IconButton size="sm" label={`Actions for ${mount.name}`} {...p}><MoreHorizontal /></IconButton>}
      />
    </span>
  )
}

function DirChildren({
  path, dirs, expanded, onToggle, onOpenFile, onRetry, depth, decor, mounts, mountActions,
  filterChanged, reviewedPaths, onOpenDiff, git, gitActions, ghosts,
}: {
  path: string
  dirs: Record<string, DirState>
  expanded: Set<string>
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** A directory that failed to load (most commonly: the root, fetched before `init` has
   * ever been called -- there is no session yet to answer `fs.tree` with) is not a dead
   * end: the row offers the SAME fetch again. Nothing here knows about `init` events
   * specifically (the protocol has none for it -- init is a request/reply, not a
   * broadcast), so "let the user ask again" is the general-purpose fix rather than one
   * more special case wired to session lifecycle. */
  onRetry: (path: string) => void
  depth: number
  decor: ChangeDecor | undefined
  mounts?: MountInfo[]
  mountActions?: MountActions
  filterChanged?: boolean
  reviewedPaths?: ReadonlySet<string>
  onOpenDiff?: (path: string) => void
  git?: ReadonlyMap<string, GitMark>
  gitActions?: GitRowActions
  ghosts?: ReadonlyMap<string, GhostRow[]>
}) {
  const state = dirs[path]
  if (!state) return null
  if (state.error) {
    // "access denied" in two words, because that is the one reason a person can act on —
    // the rest of the message is the OS's spelling of it, kept in the tooltip.
    const denied = /EACCES|EPERM|denied|not permitted/i.test(state.error)
    return (
      <div data-tree-error="" class="flex items-center gap-1.5 py-0.5 pr-1 font-ui text-[11.5px] text-red" style={indent(depth)}>
        <span class="inline-flex shrink-0 [&>svg]:size-3.5">{denied ? <Lock /> : <TriangleAlert />}</span>
        <span class="min-w-0 flex-1 truncate" title={state.error}>{denied ? 'access denied' : state.error}</span>
        <Button size="sm" variant="ghost" onClick={() => onRetry(path)}>Retry</Button>
      </div>
    )
  }
  if (state.entries === null) {
    return state.loading
      ? <div class="py-1 font-ui text-[11.5px] text-faint motion-safe:animate-pulse" style={indent(depth)}>loading…</div>
      : null
  }
  const entries = state.entries

  // Deleted files, folded in among the files the disk still has: the listing cannot
  // contain them, and a deletion nobody can see is the change most worth seeing. A name
  // that somehow exists on disk again (deleted, then recreated untracked) is not ghosted.
  //
  // A directory deleted WHOLE takes its listing with it, so its ghosts would render
  // nowhere. They are claimed here by the deepest listing that still exists: a ghost
  // whose parent directory is gone shows in the nearest surviving ancestor, wearing the
  // missing part of its path as its name (`docs/guide.md` at the root after `rm -rf
  // docs`). "Gone" is decided locally — the ghost's first path segment below this
  // listing is not among its directories — which is exactly when no deeper DirChildren
  // can exist to claim it.
  const prefix = path === '' ? '' : `${path}/`
  const ghostList: GhostRow[] = []
  if (ghosts !== undefined) {
    for (const [dir, list] of ghosts) {
      if (dir === path) {
        ghostList.push(...list.filter((g) => !entries.some((e) => e.name === g.name)))
        continue
      }
      if (!dir.startsWith(prefix) || dir === '') continue
      const below = dir.slice(prefix.length)
      const first = below.split('/')[0]!
      if (entries.some((e) => e.dir && e.name === first)) continue
      ghostList.push(...list.map((g) => ({ name: `${below}/${g.name}`, path: g.path })))
    }
  }

  // A directory emptied BY deletions is not "empty" — it is where the ghosts live.
  if (entries.length === 0 && ghostList.length === 0 && path !== '') {
    return <div class="py-1 font-ui text-[11.5px] text-faint" style={{ paddingLeft: `${depth * 12 + 28}px` }}>empty</div>
  }

  // ONE view, filtered — not a second view: with the filter on, a row renders only when
  // something changed it — the session's decor OR git — and the tree's structure, indent
  // and badges stay exactly what they are the rest of the time. Directory counts are
  // already the union (the workspace tab merges git-only files in before passing decor).
  const shown = filterChanged === true && decor !== undefined
    ? entries.filter((entry) => {
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`
        return entry.dir
          ? (decor.dirs.get(childPath) ?? 0) > 0
          : decor.files.has(childPath) || git?.has(childPath) === true
      })
    : entries

  // One list, in explorer order. The ghosts are merged in rather than appended so a
  // deleted file sits where it lived — the folder still reads like the folder, which is
  // the whole point of showing it at all.
  const rows: ({ ghost: false; name: string; dir: boolean } | { ghost: true; name: string; dir: boolean; path: string })[] = [
    ...shown.map((e) => ({ ghost: false as const, name: e.name, dir: e.dir })),
    ...ghostList.map((g) => ({ ghost: true as const, name: g.name, dir: false, path: g.path })),
  ].sort(compareTreeRows)

  return (
    <>
      {rows.map((row) => {
        if (row.ghost) return renderGhost(row)
        const entry = { name: row.name, dir: row.dir }
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`
        const isExpanded = expanded.has(childPath)
        // The workspace's own folders, managed right where they are seen: a top-level
        // row that IS a mount wears its controls, and the separate management panel is
        // gone. Nested buttons are invalid HTML, so a mount row is a flex wrapper with
        // the ordinary row-button beside the controls, not inside it.
        const mount = depth === 0 && entry.dir ? mounts?.find((m) => m.name === entry.name) : undefined
        const fileChange = !entry.dir ? decor?.files.get(childPath) : undefined
        const mark = !entry.dir ? git?.get(childPath) : undefined
        const count = entry.dir && decor !== undefined ? (decor.dirs.get(childPath) ?? 0) : 0
        const rowNode = (
          /* A button, not a div with onClick: bare divs cannot take focus, so the whole
              tree was unreachable by keyboard — not one directory could be expanded, not
              one file opened, without a mouse. A button gets Tab, Enter and Space for
              free, and aria-expanded tells a screen reader which rows unfold. */
          <button
            type="button"
            data-tree-row={childPath}
            data-kind={entry.dir ? 'dir' : 'file'}
            class={cn(ROW, mark?.staged === true && STAGED, mount !== undefined && 'flex-1')}
            style={indent(depth)}
            onClick={() => (entry.dir ? onToggle(childPath) : onOpenFile(childPath))}
            title={childPath}
            aria-expanded={entry.dir ? isExpanded : undefined}
            /* Drag a row onto the composer to attach it. Directories too: a folder
               attaches as a listing of what is in it, which is what you actually mean by
               dragging `src` at a question. `childPath` is already in the exact spelling
               `attach` takes — the tree builds it that way for the host — so nothing is
               converted on the way.

               Pointer events rather than `draggable`, because HTML5 drag-and-drop does not
               work in this window at all; see `lib/drag.ts` for why, and why that is not
               a preference. */
            onPointerDown={(e) => startRowDrag(e, childPath)}
          >
            <span class="flex w-4 shrink-0 text-faint [&>svg]:size-3.5">
              {entry.dir ? (isExpanded ? <ChevronDown /> : <ChevronRight />) : null}
            </span>
            <span class={cn('flex shrink-0 [&>svg]:size-3.5', entry.dir ? 'text-blue opacity-75' : 'text-faint')}>
              {entry.dir ? (isExpanded ? <FolderOpen /> : <Folder />) : <FileText />}
            </span>
            <span data-tree-name="" class={cn('min-w-0 flex-1 truncate', mark !== undefined && NAME_TONE[mark.letter])}>
              {entry.name}
            </span>
            {mount !== undefined && mount.access === 'read' && (
              <Chip class="ml-1 h-4 shrink-0 px-1.5 text-[10px]" icon={<Lock />} title="Read-only: the agent reads and searches here, and cannot write">
                read-only
              </Chip>
            )}
            {/* The fingerprints, right on the tree: a changed file carries its diff
                shape, a folder carries how many changed files hide under it. */}
            {count > 0 && (
              <span class="flex w-[18px] shrink-0 items-center justify-center text-[10.5px] tabular-nums text-accent" title={`${count} changed inside`}>
                {count}
              </span>
            )}
            {fileChange !== undefined && (
              // The badge is the door to the DIFF: a span with its own click (a button
              // cannot nest inside the row button), stopping propagation so the row's
              // open-the-file click stays separate. Reviewed changes dim.
              <span
                data-change=""
                class={cn(
                  'shrink-0 whitespace-nowrap text-[10.5px] tabular-nums text-dim',
                  fileChange.lastFailed && 'text-red',
                  reviewedPaths?.has(childPath) && 'opacity-45',
                )}
                title="Show the diff"
                onClick={onOpenDiff !== undefined
                  ? (e) => { e.stopPropagation(); onOpenDiff(childPath) }
                  : undefined}
              >
                {fileChange.revisions > 1 ? `${fileChange.revisions}× ` : ''}
                +{fileChange.added} −{fileChange.removed}
              </span>
            )}
            {mark !== undefined && (
              <GitCluster path={childPath} mark={mark} actions={gitActions} />
            )}
          </button>
        )
        return (
          <div key={childPath}>
            {mount !== undefined && mountActions !== undefined
              ? <div class="group/mount flex items-center hover:bg-raised">{rowNode}<MountControls mount={mount} actions={mountActions} /></div>
              : rowNode}
            {entry.dir && isExpanded && (
              <DirChildren
                path={childPath} dirs={dirs} expanded={expanded} onToggle={onToggle}
                onOpenFile={onOpenFile} onRetry={onRetry} depth={depth + 1} decor={decor}
                {...(filterChanged !== undefined ? { filterChanged } : {})}
                {...(reviewedPaths !== undefined ? { reviewedPaths } : {})}
                {...(onOpenDiff !== undefined ? { onOpenDiff } : {})}
                {...(git !== undefined ? { git } : {})}
                {...(gitActions !== undefined ? { gitActions } : {})}
                {...(ghosts !== undefined ? { ghosts } : {})}
              />
            )}
          </div>
        )
      })}
    </>
  )

  /** A deleted file's row. Same shape as a living one, struck through, and it opens the
   * diff rather than a file the disk no longer has. */
  function renderGhost(g: { name: string; path: string }): VNode {
    const mark = git?.get(g.path)
    const fileChange = decor?.files.get(g.path)
    return (
      <button
        key={`ghost:${g.path}`}
        type="button"
        data-tree-row={g.path}
        data-kind="ghost"
        // A staged deletion is as much "chosen for the commit" as a staged edit —
        // the ghost row wears the same highlight the living rows do.
        class={cn(ROW, 'opacity-75', mark?.staged === true && STAGED)}
        style={indent(depth)}
        title={`${g.path} — deleted; click for the diff`}
        onClick={() => onOpenDiff?.(g.path)}
      >
        <span class="flex w-4 shrink-0" />
        <span class="flex shrink-0 text-faint [&>svg]:size-3.5"><FileText /></span>
        <span data-tree-name="" class="min-w-0 flex-1 truncate text-red line-through">{g.name}</span>
        {fileChange !== undefined && (
          <span class="shrink-0 whitespace-nowrap text-[10.5px] tabular-nums text-dim">
            +{fileChange.added} −{fileChange.removed}
          </span>
        )}
        {mark !== undefined && (
          <GitCluster path={g.path} mark={mark} actions={gitActions} />
        )}
      </button>
    )
  }
}
