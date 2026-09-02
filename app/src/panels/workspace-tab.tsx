import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { ArrowLeftRight, CheckCheck, FolderPlus, GitBranch, ListFilter, Search, X } from 'lucide-preact'
import type { GitRepoView, WorkspaceFolderView } from '@core/host/protocol'
import type { ChatItem } from '../lib/state'
import type { ProtocolClient } from '../lib/client'
import { DiffStatBadge, diffStat } from '../lib/diff'
import { decorateChanges } from '../lib/path-tree'
import { ghostRows, gitMarks, letterOf } from '../lib/git-scm'
import { PanelError, PanelNote } from '../components/panel'
import { Button, IconButton } from '../ui/button'
import { Chip } from '../ui/chip'
import { cn } from '../ui/cn'
import { Input } from '../ui/input'
import { type ChangeEntry, splitReviewed } from './changes-tab'
import { TreePanel, type GitRowActions, type MountActions, type MountInfo } from './tree'

/**
 * The Workspace tab (docs/UI-REDESIGN-2026-09.md §7): ONE tree, wearing everything —
 * including git.
 *
 * The working tree used to be its own section below the files: a second list of the same
 * files, with checkboxes. The owner's ruling was that git lives ON the tree — the working
 * tree belongs on the files themselves: each changed file carries its letter, a staged
 * file's row highlights (staging IS the selection), `+`/`−` on the row move a file in and
 * out of the next commit, and the commit box sits above the tree where a message is
 * written after the changes were read.
 *
 * The strip under the commit box says how much moved in total; pressing it FILTERS the
 * same tree down to what changed — a filter, not a second view. A badge or letter click
 * opens the DIFF as a tab beside the chat.
 *
 * The header owns the workspace's lifecycle: rename by clicking the name, add a folder,
 * switch, close, and a find box (Ctrl+P inside the panel) that asks the host's file index.
 * Folder rows on the tree carry their own access/rename/remove.
 */
export function WorkspaceTab({
  client, items, changes, onOpenFile, workspaceRoot, workspaceName, folderCount,
  reloadKey, isDevBridge, onReopenWorkspace, onSwitchWorkspace, onCloseWorkspace,
  sessionKey, reviewed, onMarkReviewed,
}: {
  client: ProtocolClient
  items: ChatItem[]
  changes: ChangeEntry[]
  /** Opens a file as a TAB beside the chat; `face: 'diff'` lands on the diff. */
  onOpenFile: (path: string, face?: 'file' | 'diff') => void
  workspaceRoot: string
  workspaceName: string
  folderCount: number
  reloadKey: number
  isDevBridge: boolean
  /** Re-opens the workspace after the folder set was edited — the same full init a
   * launch does, wired by App because only it owns the connect flow. */
  onReopenWorkspace: () => void
  /** Opens the switcher dialog — recents as one-click buttons, and the folder picker. */
  onSwitchWorkspace: () => void
  /** Back to the start screen. The workspace's sessions and files are untouched. */
  onCloseWorkspace: () => void
  sessionKey: string
  /** Reviewed watermarks, owned by App now — the diff face lives in a chat-column tab,
   * and two owners of one judgement would drift. */
  reviewed: ReadonlyMap<string, number>
  onMarkReviewed: (entries: readonly ChangeEntry[]) => void
}): VNode {
  const [folders, setFolders] = useState<WorkspaceFolderView[]>([])
  const [wsName, setWsName] = useState(workspaceName)
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [addingPath, setAddingPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filterChanged, setFilterChanged] = useState(false)
  const [find, setFind] = useState<string | null>(null)
  const findRef = useRef<HTMLInputElement>(null)

  // Git, ON the tree. Loaded here because this tab owns the reload rhythm: every
  // resolved write-tool bumps `reloadKey`, and every stage/unstage/commit reloads too.
  const [repos, setRepos] = useState<GitRepoView[]>([])
  const [unversioned, setUnversioned] = useState<{ mount: string }[]>([])
  const [gitProblem, setGitProblem] = useState<string | null>(null)
  const [gitBusy, setGitBusy] = useState(false)
  const [repoChoice, setRepoChoice] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [gitNote, setGitNote] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null)

  // The filter is a judgement about ONE session's changes; a different session starts
  // unfiltered. (Reviewed state lives in App now, reset there the same way.)
  useEffect(() => {
    setFilterChanged(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey])

  const load = useCallback(() => {
    client.call('workspace.get', {})
      .then((r) => { setFolders(r.folders); setWsName(r.name) })
      .catch((e: Error) => setError(e.message))
  }, [client])
  useEffect(() => { load() }, [load, workspaceRoot, reloadKey])

  const loadGit = useCallback(() => {
    client.call('git.status', {})
      .then((r) => {
        setRepos(r.repos)
        setUnversioned(r.unversioned)
        setGitProblem(r.problem ?? null)
      })
      .catch((e: Error) => setGitProblem(e.message))
  }, [client])
  useEffect(() => { loadGit() }, [loadGit, workspaceRoot, reloadKey])

  const marks = useMemo(() => gitMarks(repos), [repos])

  const decor = useMemo(() => {
    const base = decorateChanges(changes.map((c) => ({
      openPath: c.openPath,
      revisions: c.revisions,
      ...(c.lastFailed !== undefined ? { lastFailed: c.lastFailed } : {}),
      stat: c.ok ? diffStat(c.content) : null,
    })))
    // Directory counts are the UNION: a folder holding a git-only change (your own edit,
    // or something left over from before the session) still confesses while collapsed.
    for (const path of marks.keys()) {
      if (base.files.has(path)) continue
      let dir = ''
      for (const segment of path.split('/').slice(0, -1)) {
        dir = dir === '' ? segment : `${dir}/${segment}`
        base.dirs.set(dir, (base.dirs.get(dir) ?? 0) + 1)
      }
    }
    return base
  }, [changes, marks])

  const ghosts = useMemo(() => ghostRows(
    marks,
    changes.filter((c) => c.tool === 'delete_file' && c.ok).map((c) => c.openPath),
  ), [marks, changes])

  const { hidden } = splitReviewed(changes, reviewed)
  const reviewedPaths = useMemo(() => new Set(hidden.map((e) => e.openPath)), [hidden])

  const unionCount = useMemo(
    () => new Set([...decor.files.keys(), ...marks.keys()]).size, [decor, marks])

  const total = useMemo(() => {
    let added = 0
    let removed = 0
    for (const entry of changes) {
      if (!entry.ok) continue
      const stat = diffStat(entry.content)
      added += stat.added
      removed += stat.removed
    }
    return { added, removed }
  }, [changes])

  /** One writer for every management action: the definition as it should now be, saved
   * and re-opened. The jail, the repo map and the file index all derive from the folder
   * set, so a re-open is correctness, not ceremony.
   *
   * A plain function, deliberately NOT useCallback: `onReopenWorkspace` is an inline
   * closure over App's CURRENT workspaceRoot, and memoising this on `[client]` froze the
   * first render's copy — proven live: switch workspaces, rename, and the re-open
   * init'ed the PREVIOUS workspace ("renaming does not work", as the owner reported it). */
  function apply(name: string, next: { path: string; name?: string; access: 'write' | 'read' }[]): void {
    setBusy(true)
    setError(null)
    client.call('workspace.set', { name: name.trim(), folders: next })
      .then(() => onReopenWorkspace())
      .catch((e: Error) => { setError(e.message) })
      .finally(() => setBusy(false))
  }

  const secondary = useCallback(() => folders.filter((f) => !f.primary).map((f) => ({
    path: f.root,
    ...(f.name.trim() !== '' ? { name: f.name } : {}),
    access: f.access,
  })), [folders])

  function addFolder(path: string): void {
    const trimmed = path.trim()
    if (trimmed === '') return
    if (folders.some((f) => f.root.toLowerCase() === trimmed.toLowerCase())) {
      setError('that folder is already in this workspace')
      return
    }
    setAddingPath(null)
    apply(wsName, [...secondary(), { path: trimmed, access: 'write' as const }])
  }

  async function pickFolder(): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({ directory: true, multiple: false })
    if (typeof result === 'string') addFolder(result)
  }

  function openFind(): void {
    setFind((f) => f ?? '')
    requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select() })
  }

  const mounts: MountInfo[] = folders.map((f) => ({
    name: f.name, primary: f.primary, access: f.access, git: f.git,
  }))
  const mountActions: MountActions = {
    busy,
    toggleAccess: (name) => {
      apply(wsName, folders.filter((f) => !f.primary).map((f) => ({
        path: f.root,
        ...(f.name.trim() !== '' ? { name: f.name } : {}),
        access: f.name === name ? (f.access === 'read' ? 'write' as const : 'read' as const) : f.access,
      })))
    },
    remove: (name) => {
      apply(wsName, folders.filter((f) => !f.primary && f.name !== name).map((f) => ({
        path: f.root,
        ...(f.name.trim() !== '' ? { name: f.name } : {}),
        access: f.access,
      })))
    },
    rename: (name, next) => {
      apply(wsName, folders.filter((f) => !f.primary).map((f) => ({
        path: f.root,
        ...(f.name === name ? { name: next } : (f.name.trim() !== '' ? { name: f.name } : {})),
        access: f.access,
      })))
    },
  }

  // The repository the commit box is addressed to. One repo is the ordinary case; with
  // several, chips above the box pick, and a vanished choice falls back to the first.
  const repo = repos.find((r) => r.root === repoChoice) ?? repos[0]
  // Conflicts stand APART from every staging set: `git add` on one declares it resolved
  // with the markers still in the file, `git reset` throws away the merge bookkeeping,
  // and porcelain's `UU` parses as "staged" — which without this filter put conflicts
  // into Stage all, Unstage all AND the commit count at once.
  const conflicted = (repo?.files ?? []).filter((f) => letterOf(f.code) === '!')
  const stagedFiles = (repo?.files ?? []).filter((f) => f.staged && letterOf(f.code) !== '!')
  const stagedCount = stagedFiles.length
  const dirtyPaths = (repo?.files ?? [])
    .filter((f) => (f.untracked || (f.code[1] !== undefined && f.code[1] !== ' ')) && letterOf(f.code) !== '!')
    .map((f) => f.path)
  // A staged rename is TWO index entries (old name deleted, new name added); unstaging
  // must name both, or the old name's deletion survives alone and Commit deletes the file.
  const stagedPaths = stagedFiles.flatMap(
    (f) => (f.oldPath !== undefined ? [f.path, f.oldPath] : [f.path]))

  function gitApply(method: 'git.stage' | 'git.unstage', paths: string[]): void {
    if (paths.length === 0 || gitBusy) return
    setGitBusy(true)
    setGitNote(null)
    client.call(method, { paths })
      .then((r) => {
        if (!r.ok) setGitNote({ kind: 'bad', text: r.problem ?? 'git said no' })
      })
      .catch((e: Error) => setGitNote({ kind: 'bad', text: e.message }))
      .finally(() => { setGitBusy(false); loadGit() })
  }

  const gitActions: GitRowActions = {
    busy: gitBusy,
    stage: (path) => gitApply('git.stage', [path]),
    unstage: (path) => {
      const oldPath = marks.get(path)?.oldPath
      gitApply('git.unstage', oldPath !== undefined ? [path, oldPath] : [path])
    },
  }

  function commit(): void {
    if (repo === undefined || gitBusy) return
    setGitBusy(true)
    setGitNote(null)
    client.call('git.commit', { root: repo.root, message: message.trim() || repo.suggestion })
      .then((r) => {
        if (r.ok) {
          setMessage('')
          setGitNote({ kind: 'ok', text: `committed${r.sha !== undefined ? ` ${r.sha}` : ''}` })
        } else {
          setGitNote({ kind: 'bad', text: r.problem ?? 'the commit did not happen' })
        }
      })
      .catch((e: Error) => setGitNote({ kind: 'bad', text: e.message }))
      .finally(() => { setGitBusy(false); loadGit() })
  }

  const shownName = wsName === '' ? workspaceName : wsName

  return (
    <div
      data-panel="workspace"
      tabIndex={-1}
      class="flex h-full min-h-0 flex-col font-ui outline-none"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); e.stopPropagation(); openFind() }
      }}
    >
      <div class="flex shrink-0 items-center gap-2 px-2.5 pb-1 pt-2">
        {nameDraft !== null
          ? (
            <Input
              data-workspace-name=""
              class="h-6 max-w-[220px] text-[12.5px]"
              value={nameDraft}
              aria-label="Workspace name"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onInput={(e) => setNameDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { apply(nameDraft, secondary()); setNameDraft(null) }
                if (e.key === 'Escape') { e.stopPropagation(); setNameDraft(null) }
              }}
            />
            )
          : (
            <button
              type="button"
              data-workspace-title=""
              class="min-w-0 shrink cursor-pointer truncate border-0 bg-transparent p-0 text-left text-[13px] font-semibold text-fg hover:underline hover:decoration-dotted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              title={`${workspaceRoot} — click to rename the workspace`}
              onClick={() => setNameDraft(wsName)}
            >
              {shownName}
            </button>
            )}
        <span class="shrink-0 whitespace-nowrap text-[11.5px] text-dim">
          {folderCount} {folderCount === 1 ? 'folder' : 'folders'}
        </span>
        <span class="ml-auto flex shrink-0 gap-0.5">
          <IconButton size="sm" label="Find a file (Ctrl+P)" active={find !== null} onClick={() => (find === null ? openFind() : setFind(null))}>
            <Search />
          </IconButton>
          <IconButton
            size="sm"
            label="Add a folder to the workspace"
            disabled={busy}
            onClick={() => (isDevBridge ? setAddingPath((v) => (v === null ? '' : null)) : void pickFolder())}
          >
            <FolderPlus />
          </IconButton>
          <IconButton size="sm" label="Switch workspace — recents and the folder picker" onClick={onSwitchWorkspace}>
            <ArrowLeftRight />
          </IconButton>
          <IconButton size="sm" label="Close the workspace — back to the start screen (sessions and files stay)" onClick={onCloseWorkspace}>
            <X />
          </IconButton>
        </span>
      </div>

      {find !== null && (
        <div class="shrink-0 px-2.5 pb-1.5">
          <Input
            ref={findRef}
            data-find-file=""
            class="h-6 text-[12px]"
            value={find}
            placeholder="find a file by name — Esc closes"
            aria-label="Find a file"
            onInput={(e) => setFind(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setFind(null) } }}
          />
        </div>
      )}

      {addingPath !== null && (
        <div class="shrink-0 px-2.5 pb-1.5">
          <Input
            data-add-folder=""
            class="h-6 text-[12px]"
            value={addingPath}
            placeholder="paste a folder path — Enter adds it"
            aria-label="Folder to add"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onInput={(e) => setAddingPath(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addFolder(addingPath)
              if (e.key === 'Escape') { e.stopPropagation(); setAddingPath(null) }
            }}
          />
        </div>
      )}
      {error !== null && <PanelError message={error} />}

      {/* The commit box, above the tree it commits from. Only when git is actually
          there — a workspace under no version control gets the tree and nothing else. */}
      {repo !== undefined && (
        <div data-scm="" class="flex shrink-0 flex-col gap-1.5 border-b border-border-soft px-2.5 py-2">
          {repos.length > 1 && (
            <div class="flex flex-wrap gap-1" role="group" aria-label="Repository">
              {repos.map((r) => (
                <button
                  key={r.root}
                  type="button"
                  aria-pressed={r.root === repo.root}
                  class={cn(
                    'cursor-pointer rounded-full border border-border bg-transparent px-2 py-px text-[11.5px] text-dim transition-colors duration-(--duration-fast) hover:border-accent-line hover:text-fg',
                    r.root === repo.root && 'border-accent text-fg',
                  )}
                  onClick={() => setRepoChoice(r.root)}
                  title={r.root}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
          <Input
            class="h-7 text-[12.5px]"
            value={message}
            placeholder={repo.suggestion !== '' ? repo.suggestion : 'Commit message'}
            aria-label="Commit message"
            onInput={(e) => setMessage(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && stagedCount > 0) commit() }}
          />
          <div class="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="primary"
              disabled={gitBusy || stagedCount === 0}
              loading={gitBusy}
              onClick={commit}
              data-action="commit"
              title={stagedCount === 0
                ? 'Nothing staged yet — + on a changed row, or Stage all'
                : `Commit ${stagedCount} staged file${stagedCount === 1 ? '' : 's'}`}
            >
              Commit{stagedCount > 0 ? ` ${stagedCount}` : ''}
            </Button>
            {dirtyPaths.length > 0 && (
              <Button size="sm" disabled={gitBusy} onClick={() => gitApply('git.stage', dirtyPaths)} title="Stage every change in this repository">
                Stage all
              </Button>
            )}
            {stagedPaths.length > 0 && (
              <Button size="sm" disabled={gitBusy} onClick={() => gitApply('git.unstage', stagedPaths)} title="Take everything back out of the commit — changes stay on disk">
                Unstage all
              </Button>
            )}
            <Chip class="ml-auto min-w-0" icon={<GitBranch />} title={repo.root}>
              <span class="truncate">{repo.branch ?? 'no branch'}</span>
            </Chip>
          </div>
          {conflicted.length > 0 && (
            <PanelNote tone="bad" inset>
              {conflicted.length} conflicted file{conflicted.length === 1 ? '' : 's'} — resolve
              {conflicted.length === 1 ? ' it' : ' them'} in an editor first; git will not
              commit over a conflict.
            </PanelNote>
          )}
          {stagedCount === 0 && repo.files.length > 0 && conflicted.length === 0 && gitNote === null && (
            <div class="text-[11.5px] leading-[1.5] text-faint">
              Stage what the commit should carry — <b>+</b> on a row, or Stage all. Staged
              rows highlight.
            </div>
          )}
          {gitNote !== null && (
            <PanelNote tone={gitNote.kind === 'ok' ? 'good' : 'bad'} inset>{gitNote.text}</PanelNote>
          )}
          {repo.problem !== undefined && <PanelNote inset>{repo.problem}</PanelNote>}
          {unversioned.length > 0 && (
            <PanelNote inset>Not under version control: {unversioned.map((u) => u.mount).join(', ')}.</PanelNote>
          )}
        </div>
      )}
      {gitProblem !== null && (
        <PanelNote tone="warn" title="Git is not available for this workspace, so the tree carries no marks">{gitProblem}</PanelNote>
      )}

      {unionCount > 0 && (
        <div class="flex shrink-0 items-center gap-1.5 border-b border-border-soft px-2.5 pb-2 pt-0.5">
          <Button
            size="sm"
            variant={filterChanged ? 'secondary' : 'ghost'}
            icon={<ListFilter />}
            aria-pressed={filterChanged}
            data-action="filter-changed"
            onClick={() => setFilterChanged((v) => !v)}
            title={filterChanged
              ? 'Show every file again'
              : 'Filter the tree down to what changed — this session and uncommitted'}
          >
            {unionCount} changed
            {changes.length > 0 && <DiffStatBadge stat={total} />}
          </Button>
          {changes.length > reviewedPaths.size && (
            <Button
              size="sm"
              variant="ghost"
              icon={<CheckCheck />}
              onClick={() => onMarkReviewed(changes)}
              title="Dim every current change's badge; a newer write brings its badge back"
            >
              All reviewed
            </Button>
          )}
        </div>
      )}

      <div class="min-h-0 flex-1 overflow-auto py-1.5">
        <TreePanel
          client={client}
          toolItems={items}
          onOpenFile={(p) => onOpenFile(p, 'file')}
          workspaceRoot={workspaceRoot}
          decor={decor}
          mounts={mounts}
          mountActions={mountActions}
          filterChanged={filterChanged}
          reviewedPaths={reviewedPaths}
          onOpenDiff={(p) => onOpenFile(p, 'diff')}
          git={marks}
          gitActions={gitActions}
          ghosts={ghosts}
          reloadKey={reloadKey}
          find={find}
          onReveal={() => setFind(null)}
        />
      </div>
    </div>
  )
}
