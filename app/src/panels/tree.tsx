import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import type { ChangeDecor } from '../lib/path-tree'
import type { ChatItem } from '../lib/state'
import { describeMark, type GhostRow, type GitMark } from '../lib/git-scm'
import { Icon } from '../components/icons'

/**
 * The file tree panel (Plan 4 Task 7): lazy-loaded directories over `fs.tree`, refreshed
 * automatically when a write-family tool succeeds against a directory the tree has
 * already loaded, and a click on a file hands its path to `onOpenFile` (wired by `App.tsx`
 * to the diffs panel's preview area -- the tree itself never calls `fs.read`).
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
 * The tree-refresh path parser (Task 7's own name for it, in the plan's verification
 * bullet): given a write-family tool's name and its raw `tool.call` args JSON, returns the
 * workspace-relative directories a successful call just changed the CONTENTS of --
 * `edit_file`/`write_file`/`delete_file` each name one directory (the parent of `path`);
 * `move_file` can name up to two (the parent of `from` AND of `to`, deduplicated -- a move
 * within the same directory returns just one). Any other tool name, or JSON that does not
 * parse or does not carry the expected string field(s), returns `[]` rather than throwing
 * -- a malformed or unrecognized call is simply nothing to refresh, not a crash.
 */
export function affectedDirectories(name: string, argsJson: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const obj = parsed as Record<string, unknown>

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
 * panel (the user's word was «костыльно»). */
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

/**
 * The git cluster on a changed file's row: hover actions first, then the letter.
 *
 * Spans with click handlers, not buttons — the row itself is a button and buttons cannot
 * nest. The letter is always visible; `+`/`−` appear on row hover (CSS gates
 * pointer-events with opacity, so an invisible control is also an unclickable one).
 */
function GitCluster({
  path, mark, actions,
}: {
  path: string
  mark: GitMark
  actions: GitRowActions | undefined
}): VNode {
  return (
    <span class="tree-git">
      {actions !== undefined && mark.dirty && mark.letter !== '!' && (
        <span
          class="tree-git-act"
          role="button"
          title="Stage — include this file in the next commit"
          onClick={(e) => { e.stopPropagation(); if (!actions.busy) actions.stage(path) }}
        >
          {Icon.plus()}
        </span>
      )}
      {/* A conflict is not a thing to stage or unstage from a hover: `git add` would
          declare it resolved with the markers still in the file, and `git reset` would
          throw away the merge bookkeeping. The letter alone, loudly. */}
      {actions !== undefined && mark.staged && mark.letter !== '!' && (
        <span
          class="tree-git-act"
          role="button"
          title="Unstage — keep the change, take it out of the commit"
          onClick={(e) => { e.stopPropagation(); if (!actions.busy) actions.unstage(path) }}
        >
          {Icon.minus()}
        </span>
      )}
      <span
        class={`tree-git-letter tree-git-${mark.letter === '!' ? 'conflict' : mark.letter.toLowerCase()}${mark.staged ? ' tree-git-letter-staged' : ''}`}
        title={describeMark(mark)}
      >
        {mark.letter}
      </span>
    </span>
  )
}

export function TreePanel({
  client, toolItems, onOpenFile, workspaceRoot, decor, mounts, mountActions,
  filterChanged, reviewedPaths, onOpenDiff, git, gitActions, ghosts,
}: {
  client: ProtocolClient
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

  return (
    <div class="tree-panel">
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
        <div class="tree-empty">nothing changed this session</div>
      )}
    </div>
  )
}

/**
 * The management cluster on a mount's own row. Hidden until the row is hovered — the
 * tree stays a tree — and the remove is a two-click arm ("Remove?") rather than a
 * confirm dialog: a stray click must not silently unmount a project, and a dialog for
 * an action this reversible would be ceremony.
 */
function MountControls({ mount, actions }: { mount: MountInfo; actions: MountActions }): VNode {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const id = setTimeout(() => setArmed(false), 3_000)
    return () => clearTimeout(id)
  }, [armed])

  if (mount.primary) {
    return (
      <span class="tree-mount-controls tree-mount-controls-open">
        <span class="tag" title="The main folder — sessions, checkpoints and workspace settings live here">main</span>
      </span>
    )
  }
  if (renaming !== null) {
    return (
      <span class="tree-mount-controls tree-mount-controls-open">
        <input
          class="input input-small"
          value={renaming}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onInput={(e) => setRenaming(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && renaming.trim() !== '') { actions.rename(mount.name, renaming.trim()); setRenaming(null) }
            if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null) }
          }}
        />
      </span>
    )
  }
  return (
    <span class={armed ? 'tree-mount-controls tree-mount-controls-open' : 'tree-mount-controls'}>
      <button
        class="tree-mount-btn"
        disabled={actions.busy}
        title={mount.access === 'read'
          ? 'Read-only: the agent reads and searches here, and cannot write. Click to allow writes.'
          : 'Writable. Click to make this folder read-only.'}
        onClick={() => actions.toggleAccess(mount.name)}
      >
        {mount.access === 'read' ? 'read-only' : 'writable'}
      </button>
      <button
        class="tree-mount-btn"
        disabled={actions.busy}
        title="Rename — this is the name the agent sees the folder under"
        onClick={() => setRenaming(mount.name)}
      >
        ✎
      </button>
      <button
        class={armed ? 'tree-mount-btn tree-mount-danger' : 'tree-mount-btn'}
        disabled={actions.busy}
        title="Remove the folder from the workspace — files on disk are untouched"
        onClick={() => {
          if (armed) { setArmed(false); actions.remove(mount.name) } else setArmed(true)
        }}
      >
        {armed ? 'Remove?' : Icon.x()}
      </button>
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
   * end: clicking the error retries the SAME fetch. Nothing here knows about `init`
   * events specifically (the protocol has none for it -- init is a request/reply, not a
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
    return (
      <button
        class="tree-error"
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        onClick={() => onRetry(path)}
        title="Click to retry"
      >
        ⚠ {state.error} (click to retry)
      </button>
    )
  }
  if (state.entries === null) {
    return state.loading ? <div class="tree-loading loading-quiet" style={{ paddingLeft: `${depth * 12 + 6}px` }}>loading…</div> : null
  }
  const entries = state.entries

  // Deleted files, appended after what the disk still has: the listing cannot contain
  // them, and a deletion nobody can see is the change most worth seeing. A name that
  // somehow exists on disk again (deleted, then recreated untracked) is not ghosted.
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
    ghostList.sort((a, b) => a.name.localeCompare(b.name))
  }

  // A directory emptied BY deletions is not "empty" — it is where the ghosts live.
  if (entries.length === 0 && ghostList.length === 0 && path !== '') {
    return <div class="tree-empty" style={{ paddingLeft: `${depth * 12 + 28}px` }}>empty</div>
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

  return (
    <>
      {shown.map((entry) => {
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`
        const isExpanded = expanded.has(childPath)
        // The workspace's own folders, managed right where they are seen: a top-level
        // row that IS a mount wears its controls, and the separate management panel is
        // gone. Nested buttons are invalid HTML, so a mount row is a flex wrapper with
        // the ordinary row-button beside the controls, not inside it.
        const mount = depth === 0 && entry.dir ? mounts?.find((m) => m.name === entry.name) : undefined
        const fileChange = !entry.dir ? decor?.files.get(childPath) : undefined
        const mark = !entry.dir ? git?.get(childPath) : undefined
        const row = (
          /* A button, not a div with onClick: bare divs cannot take focus, so the whole
              tree was unreachable by keyboard — not one directory could be expanded, not
              one file opened, without a mouse. A button gets Tab, Enter and Space for
              free, and aria-expanded tells a screen reader which rows unfold. */
          <button
            class={[
              'tree-row',
              entry.dir ? 'tree-dir' : 'tree-file',
              mount !== undefined ? 'tree-mount-main' : '',
              // Staged = selected for the commit — the row itself says so («подсвети
              // файлы если я их выбрал для коммита»), not a checkbox column.
              mark?.staged === true ? 'tree-row-staged' : '',
            ].filter(Boolean).join(' ')}
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
            onClick={() => (entry.dir ? onToggle(childPath) : onOpenFile(childPath))}
            title={childPath}
            aria-expanded={entry.dir ? isExpanded : undefined}
          >
            <span class="tree-chevron">
              {entry.dir ? (isExpanded ? Icon.chevronDown() : Icon.chevronRight()) : null}
            </span>
            <span class="tree-icon">{entry.dir ? Icon.folder() : Icon.file()}</span>
            <span class={`tree-name${mark !== undefined ? ` tree-name-git-${mark.letter === '!' ? 'conflict' : mark.letter.toLowerCase()}` : ''}`}>
              {entry.name}
            </span>
            {mount !== undefined && mount.access === 'read' && (
              <span class="tree-mount-ro" title="Read-only">read-only</span>
            )}
            {/* The fingerprints, right on the tree: a changed file carries its diff
                shape, a folder carries how many changed files hide under it. */}
            {entry.dir && decor !== undefined && (decor.dirs.get(childPath) ?? 0) > 0 && (
              <span class="tree-change-count">{decor.dirs.get(childPath)}</span>
            )}
            {fileChange !== undefined && (
              // The badge is the door to the DIFF: a span with its own click (a button
              // cannot nest inside the row button), stopping propagation so the row's
              // open-the-file click stays separate. Reviewed changes dim.
              <span
                class={[
                  'tree-change-stat',
                  fileChange.lastFailed ? 'tree-change-failed' : '',
                  reviewedPaths?.has(childPath) ? 'tree-change-reviewed' : '',
                ].filter(Boolean).join(' ')}
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
              ? <div class="tree-mount">{row}<MountControls mount={mount} actions={mountActions} /></div>
              : row}
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
      {ghostList.map((g) => {
        const mark = git?.get(g.path)
        const fileChange = decor?.files.get(g.path)
        return (
          <button
            key={`ghost:${g.path}`}
            class="tree-row tree-file tree-ghost"
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
            title={`${g.path} — deleted; click for the diff`}
            onClick={() => onOpenDiff?.(g.path)}
          >
            <span class="tree-chevron" />
            <span class="tree-icon">{Icon.file()}</span>
            <span class="tree-name tree-name-ghost">{g.name}</span>
            {fileChange !== undefined && (
              <span class="tree-change-stat">
                +{fileChange.added} −{fileChange.removed}
              </span>
            )}
            {mark !== undefined && (
              <GitCluster path={g.path} mark={mark} actions={gitActions} />
            )}
          </button>
        )
      })}
    </>
  )
}
