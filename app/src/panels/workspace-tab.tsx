import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { ArrowLeftRight, CheckCheck, FolderPlus, ListFilter, Search, X } from 'lucide-preact'
import type { WorkspaceFolderView } from '@core/host/protocol'
import type { ChatItem } from '../lib/state'
import type { ProtocolClient } from '../lib/client'
import { DiffStatBadge, diffStat } from '../lib/diff'
import { decorateChanges } from '../lib/path-tree'
import type { GitView } from '../lib/git-views'
import { PanelError } from '../components/panel'
import { Button, IconButton } from '../ui/button'
import { Input } from '../ui/input'
import { type ChangeEntry, splitReviewed } from './changes-tab'
import { TreePanel, type MountActions, type MountInfo } from './tree'

/**
 * The Workspace tab (docs/UI-REDESIGN-2026-09.md §7): ONE tree, wearing this session's
 * changes.
 *
 * Git used to live on this tree as well — letters on the rows, `+`/`−` to stage, a commit
 * box above. It moved to the Git tab whole on 2026-09-08, by the owner's call once that
 * tab was complete: two places to stage from were one too many, and every reload here was
 * a second `git status` of the whole working tree on top of the Git tab's own. The tree's
 * right-click still opens a file's history and blame; everything else git is next door.
 *
 * The strip above the tree says how much this session moved in total; pressing it FILTERS
 * the same tree down to what changed — a filter, not a second view. A badge click opens the
 * DIFF as a tab beside the chat.
 *
 * The header owns the workspace's lifecycle: rename by clicking the name, add a folder,
 * switch, close, and a find box (Ctrl+P inside the panel) that asks the host's file index.
 * Folder rows on the tree carry their own access/rename/remove.
 */
export function WorkspaceTab({
  client, items, changes, onOpenFile, workspaceRoot, workspaceName, folderCount,
  reloadKey, isDevBridge, onReopenWorkspace, onSwitchWorkspace, onCloseWorkspace,
  sessionKey, reviewed, onMarkReviewed, onOpenView,
}: {
  client: ProtocolClient
  items: ChatItem[]
  changes: ChangeEntry[]
  /** Opens a file as a TAB beside the chat; `face: 'diff'` lands on the diff. */
  onOpenFile: (path: string, face?: 'file' | 'diff') => void
  /** Opens a file's history or blame as a tab — the tree's right-click Git items. */
  onOpenView?: (view: GitView) => void
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
  // null until `workspace.get` has answered: every action below refuses to build a folder
  // list from nothing, because saving one is how a workspace lost its folders — an Add
  // pressed before the answer, or while the folder picker was open, sent the new folder
  // alone and the host replaced the file with it. A ref alongside, so an action that runs
  // after an `await` (the picker) reads the list as it is NOW, not as it was at the click.
  const [folders, setFolders] = useState<WorkspaceFolderView[] | null>(null)
  const foldersRef = useRef<WorkspaceFolderView[] | null>(null)
  const [wsName, setWsName] = useState(workspaceName)
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [addingPath, setAddingPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filterChanged, setFilterChanged] = useState(false)
  const [find, setFind] = useState<string | null>(null)
  const findRef = useRef<HTMLInputElement>(null)

  // The filter is a judgement about ONE session's changes; a different session starts
  // unfiltered. (Reviewed state lives in App now, reset there the same way.)
  useEffect(() => {
    setFilterChanged(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey])

  const load = useCallback(() => {
    client.call('workspace.get', {})
      .then((r) => { foldersRef.current = r.folders; setFolders(r.folders); setWsName(r.name) })
      .catch((e: Error) => setError(e.message))
  }, [client])
  useEffect(() => { load() }, [load, workspaceRoot, reloadKey])

  const decor = useMemo(() => decorateChanges(changes.map((c) => ({
    openPath: c.openPath,
    revisions: c.revisions,
    ...(c.lastFailed !== undefined ? { lastFailed: c.lastFailed } : {}),
    stat: c.ok ? diffStat(c.content) : null,
  }))), [changes])

  const { hidden } = splitReviewed(changes, reviewed)
  const reviewedPaths = useMemo(() => new Set(hidden.map((e) => e.openPath)), [hidden])

  const unionCount = decor.files.size

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

  /** The attached folders as `workspace.set` takes them — the missing ones included, so a
   * save keeps a folder whose drive is out rather than dropping it from the file. */
  function secondaryOf(list: WorkspaceFolderView[]): { path: string; name?: string; access: 'write' | 'read' }[] {
    return list.filter((f) => !f.primary).map((f) => ({
      path: f.root,
      ...(f.name.trim() !== '' ? { name: f.name } : {}),
      access: f.access,
    }))
  }

  /** Runs a management action with the folder list as it is now, or says why it cannot yet. */
  function withFolders(action: (list: WorkspaceFolderView[]) => void): void {
    const list = foldersRef.current
    if (list === null) {
      setError('The folder list has not loaded yet — wait a moment and try again.')
      return
    }
    action(list)
  }

  function addFolder(path: string): void {
    const trimmed = path.trim()
    if (trimmed === '') return
    withFolders((list) => {
      if (list.some((f) => f.root.toLowerCase() === trimmed.toLowerCase())) {
        setError('that folder is already in this workspace')
        return
      }
      setAddingPath(null)
      apply(wsName, [...secondaryOf(list), { path: trimmed, access: 'write' as const }])
    })
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

  // A folder the definition names that is not mounted right now is not in the tree (there
  // is nothing to list under it); it is shown below the header instead, with its reason
  // and a Remove — and it stays in every list this tab saves until that Remove.
  const missing = (folders ?? []).filter((f) => f.missing !== undefined)
  const mounts: MountInfo[] = (folders ?? []).filter((f) => f.missing === undefined).map((f) => ({
    name: f.name, primary: f.primary, access: f.access, git: f.git,
  }))
  const mountActions: MountActions = {
    busy,
    toggleAccess: (name) => withFolders((list) => {
      apply(wsName, secondaryOf(list).map((f) => (
        f.name === name ? { ...f, access: f.access === 'read' ? 'write' as const : 'read' as const } : f
      )))
    }),
    remove: (name) => withFolders((list) => {
      apply(wsName, secondaryOf(list.filter((f) => f.name !== name)))
    }),
    rename: (name, next) => withFolders((list) => {
      apply(wsName, secondaryOf(list).map((f) => (f.name === name ? { ...f, name: next } : f)))
    }),
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
                if (e.key === 'Enter') { withFolders((list) => apply(nameDraft, secondaryOf(list))); setNameDraft(null) }
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
            disabled={busy || folders === null}
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

      {missing.map((f) => (
        <div
          key={f.root}
          data-missing-folder={f.name}
          class="mx-2.5 mb-1 flex shrink-0 items-center gap-2 rounded border border-border-soft px-2 py-1 font-ui text-[11.5px] text-dim"
          title={f.missing}
        >
          <span class="min-w-0 truncate">
            <span class="text-fg">{f.name}</span> is not available right now — {f.root}
          </span>
          <Button size="sm" variant="danger" class="ml-auto shrink-0" disabled={busy} onClick={() => mountActions.remove(f.name)}>
            Remove
          </Button>
        </div>
      ))}

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
          reloadKey={reloadKey}
          find={find}
          onReveal={() => setFind(null)}
          {...(onOpenView !== undefined ? { onOpenView } : {})}
        />
      </div>
    </div>
  )
}
