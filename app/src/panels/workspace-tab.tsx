import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { WorkspaceFolderView } from '@core/host/protocol'
import type { ChatItem } from '../lib/state'
import type { ProtocolClient } from '../lib/client'
import { Icon } from '../components/icons'
import { DiffStatBadge, diffStat } from '../lib/diff'
import { decorateChanges } from '../lib/path-tree'
import { type ChangeEntry, splitReviewed } from './changes-tab'
import { FilesTab } from './files-tab'
import { WorkingTree } from './working-tree'
import type { MountActions, MountInfo } from './tree'

/**
 * The Workspace tab: ONE tree, wearing everything.
 *
 * «All files» and «Changes» used to be two states of this panel, and the owner's ruling
 * was that they are one thing: Files, with the changes carried as badges. So the tree is
 * the only view. The strip above it says how much moved in total; pressing it FILTERS the
 * same tree down to what the session touched — a filter, not a second view, so structure,
 * indent and badges never change shape. A badge click (or the toggle on an opened file)
 * shows the diff, where Put back and Reviewed live.
 *
 * The header owns the workspace's lifecycle: rename by clicking the name, add a folder,
 * switch, close. Folder rows on the tree carry their own access/rename/remove.
 */
export function WorkspaceTab({
  client, items, changes, openPath, onOpenFile, workspaceRoot, workspaceName, folderCount,
  reloadKey, isDevBridge, onReopenWorkspace, onSwitchWorkspace, onCloseWorkspace, sessionKey,
}: {
  client: ProtocolClient
  items: ChatItem[]
  changes: ChangeEntry[]
  openPath: string | null
  onOpenFile: (path: string | null) => void
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
}): VNode {
  const [folders, setFolders] = useState<WorkspaceFolderView[]>([])
  const [wsName, setWsName] = useState(workspaceName)
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [addingPath, setAddingPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filterChanged, setFilterChanged] = useState(false)
  /** Files marked reviewed, path -> the last-write id the review covered. A NEWER write
   * outruns its watermark and the badge honestly un-dims. View state only. */
  const [reviewed, setReviewed] = useState<ReadonlyMap<string, number>>(new Map())
  /** Bumped by a Put back so the working tree re-reads itself: the revert changed the
   * disk, and a git status from before it is a lie. */
  const [reverts, setReverts] = useState(0)

  // A different session starts unreviewed and unfiltered — these are judgements about
  // ONE session's changes, not about the workspace.
  useEffect(() => {
    setReviewed(new Map())
    setFilterChanged(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey])

  const load = useCallback(() => {
    client.call('workspace.get', {})
      .then((r) => { setFolders(r.folders); setWsName(r.name) })
      .catch((e: Error) => setError(e.message))
  }, [client])
  useEffect(() => { load() }, [load, workspaceRoot, reloadKey])

  const decor = useMemo(() => decorateChanges(changes.map((c) => ({
    openPath: c.openPath,
    revisions: c.revisions,
    ...(c.lastFailed !== undefined ? { lastFailed: c.lastFailed } : {}),
    stat: c.ok ? diffStat(c.content) : null,
  }))), [changes])

  const changesByPath = useMemo(
    () => new Map(changes.map((c) => [c.openPath, c])), [changes])

  const { hidden } = splitReviewed(changes, reviewed)
  const reviewedPaths = useMemo(() => new Set(hidden.map((e) => e.openPath)), [hidden])

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
   * init'ed the PREVIOUS workspace ("нельзя переименовать", as the owner reported it). */
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

  return (
    <div class="workspace-tab">
      <div class="workspace-head">
        {nameDraft !== null
          ? (
            <input
              class="input input-small workspace-name-input"
              value={nameDraft}
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
              class="workspace-title"
              title={`${workspaceRoot} — click to rename the workspace`}
              onClick={() => setNameDraft(wsName)}
            >
              {wsName === '' ? workspaceName : wsName}
            </button>
            )}
        <span class="workspace-meta">
          {folderCount} {folderCount === 1 ? 'folder' : 'folders'}
        </span>
        <span class="workspace-head-actions">
          <button
            class="icon-button"
            disabled={busy}
            onClick={() => (isDevBridge ? setAddingPath((v) => (v === null ? '' : null)) : void pickFolder())}
            title="Add a folder to the workspace"
          >
            {Icon.plus()}
          </button>
          <button
            class="icon-button"
            onClick={onSwitchWorkspace}
            title="Switch workspace — recents and the folder picker"
          >
            {Icon.swap()}
          </button>
          <button
            class="icon-button"
            onClick={onCloseWorkspace}
            title="Close the workspace — back to the start screen (sessions and files stay)"
          >
            {Icon.x()}
          </button>
        </span>
      </div>
      {addingPath !== null && (
        <input
          class="input input-small workspace-add-input"
          value={addingPath}
          placeholder="paste a folder path — Enter adds it"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onInput={(e) => setAddingPath(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addFolder(addingPath)
            if (e.key === 'Escape') { e.stopPropagation(); setAddingPath(null) }
          }}
        />
      )}
      {error !== null && <div class="workspace-error">{error}</div>}
      {changes.length > 0 && (
        <div class="workspace-changes-strip">
          <button
            class={filterChanged ? 'ws-view ws-view-active' : 'ws-view'}
            aria-pressed={filterChanged}
            onClick={() => setFilterChanged((v) => !v)}
            title={filterChanged
              ? 'Show every file again'
              : 'Filter the tree down to what this session changed'}
          >
            {changes.length} changed
            <DiffStatBadge stat={total} />
          </button>
          {changes.length > reviewedPaths.size && (
            <button
              class="btn btn-small"
              onClick={() => setReviewed((m) => {
                const next = new Map(m)
                for (const entry of changes) next.set(entry.path, entry.id)
                return next
              })}
              title="Dim every current change's badge; a newer write brings its badge back"
            >
              All reviewed
            </button>
          )}
        </div>
      )}
      <FilesTab
        client={client}
        toolItems={items}
        openPath={openPath}
        onOpenFile={onOpenFile}
        workspaceRoot={workspaceRoot}
        decor={decor}
        mounts={mounts}
        mountActions={mountActions}
        changesByPath={changesByPath}
        filterChanged={filterChanged}
        reviewedPaths={reviewedPaths}
        onMarkReviewed={(entry) => setReviewed((m) => new Map(m).set(entry.path, entry.id))}
        onReverted={() => setReverts((n) => n + 1)}
      />
      <WorkingTree client={client} reloadKey={reloadKey + reverts} />
    </div>
  )
}
