import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { WorkspaceFolderView } from '@core/host/protocol'
import type { ChatItem } from '../lib/state'
import type { ProtocolClient } from '../lib/client'
import { Icon } from '../components/icons'
import { decorateChanges } from '../lib/path-tree'
import { diffStat } from '../lib/diff'
import { ChangesTab, type ChangeEntry } from './changes-tab'
import { FilesTab } from './files-tab'
import type { MountActions, MountInfo } from './tree'

/**
 * The unified Workspace tab: ONE tree, wearing the session's changes AND the management.
 *
 * Changes and Files used to be two tabs answering halves of one question — "what is this
 * project" and "what did the agent do to it" — and the seam between them was a tab switch
 * that lost your place. Here the file tree is the ground truth and the changes are an
 * OVERLAY on it: a changed file carries its diff shape right on its row, a folder carries
 * the count of changed files under it, and the Changes view is the same structure
 * filtered down to what moved.
 *
 * Management went the same way — the user's verdict on the separate panel was
 * «костыльно»: the folders on the tree ARE the workspace, so their controls live on
 * their own rows (access, rename, remove; "+ Add folder" as the last row), and every
 * action applies immediately and re-opens the workspace. The full editor survives in
 * Settings for the rare bulk edit.
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
  /** Opens the settings dialog on its workspace section — recents and the folder picker.
   * Lives HERE because this tab is where the owner went looking for it. */
  onSwitchWorkspace: () => void
  /** Back to the start screen. The workspace's sessions and files are untouched. */
  onCloseWorkspace: () => void
  sessionKey: string
}): VNode {
  const [view, setView] = useState<'files' | 'changes'>('files')
  const [folders, setFolders] = useState<WorkspaceFolderView[]>([])
  const [wsName, setWsName] = useState(workspaceName)
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  /** One writer for every management action: the definition as it should now be, saved
   * and re-opened. The jail, the repo map and the file index all derive from the folder
   * set, so a re-open is correctness, not ceremony. */
  const apply = useCallback((name: string, next: { path: string; name?: string; access: 'write' | 'read' }[]) => {
    setBusy(true)
    setError(null)
    client.call('workspace.set', { name: name.trim(), folders: next })
      .then(() => onReopenWorkspace())
      .catch((e: Error) => { setError(e.message) })
      .finally(() => setBusy(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onReopenWorkspace is App's stable connect
  }, [client])

  const secondary = useCallback(() => folders.filter((f) => !f.primary).map((f) => ({
    path: f.root,
    ...(f.name.trim() !== '' ? { name: f.name } : {}),
    access: f.access,
  })), [folders])

  const mounts: MountInfo[] = folders.map((f) => ({
    name: f.name, primary: f.primary, access: f.access, git: f.git,
  }))
  const mountActions: MountActions = {
    isDevBridge,
    busy,
    toggleAccess: (name) => {
      apply(wsName, secondary().map((f, i) => {
        const view = folders.filter((x) => !x.primary)[i]!
        return view.name === name ? { ...f, access: f.access === 'read' ? 'write' as const : 'read' as const } : f
      }))
    },
    remove: (name) => {
      const keep = folders.filter((f) => !f.primary && f.name !== name)
      apply(wsName, keep.map((f) => ({
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
    addFolder: (path) => {
      if (folders.some((f) => f.root.toLowerCase() === path.toLowerCase())) {
        setError('that folder is already in this workspace')
        return
      }
      apply(wsName, [...secondary(), { path, access: 'write' as const }])
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
      {error !== null && <div class="workspace-error">{error}</div>}
      <div class="workspace-views" role="tablist">
        <button
          class={view === 'files' ? 'ws-view ws-view-active' : 'ws-view'}
          role="tab"
          aria-selected={view === 'files'}
          onClick={() => setView('files')}
        >
          All files
        </button>
        <button
          class={view === 'changes' ? 'ws-view ws-view-active' : 'ws-view'}
          role="tab"
          aria-selected={view === 'changes'}
          onClick={() => setView('changes')}
        >
          Changes{changes.length > 0 && <span class="tab-badge">{changes.length}</span>}
        </button>
      </div>
      {view === 'files'
        ? (
          <FilesTab
            client={client}
            toolItems={items}
            openPath={openPath}
            onOpenFile={onOpenFile}
            workspaceRoot={workspaceRoot}
            decor={decor}
            mounts={mounts}
            mountActions={mountActions}
          />
          )
        : (
          <ChangesTab
            key={sessionKey}
            changes={changes}
            onOpenFile={(p) => { onOpenFile(p); setView('files') }}
            client={client}
            reloadKey={reloadKey}
          />
          )}
    </div>
  )
}
