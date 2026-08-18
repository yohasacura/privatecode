import { useMemo, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ChatItem } from '../lib/state'
import type { ProtocolClient } from '../lib/client'
import { Icon } from '../components/icons'
import { decorateChanges } from '../lib/path-tree'
import { diffStat } from '../lib/diff'
import { ChangesTab, type ChangeEntry } from './changes-tab'
import { FilesTab } from './files-tab'
import { Folders } from './folders'

/**
 * The unified Workspace tab: ONE tree, wearing the session's changes.
 *
 * Changes and Files used to be two tabs answering halves of one question — "what is this
 * project" and "what did the agent do to it" — and the seam between them was a tab switch
 * that lost your place. Here the file tree is the ground truth and the changes are an
 * OVERLAY on it: a changed file carries its diff shape right on its row, a folder carries
 * the count of changed files under it, and the «Изменения» view is the same structure
 * filtered down to what moved — diffs, Put back and the reviewed fold included.
 *
 * The workspace's own identity lives at the top: its name, what it is made of, and the
 * folder management that used to hide in Settings — adding a project folder is workspace
 * work, not configuration.
 */
export function WorkspaceTab({
  client, items, changes, openPath, onOpenFile, workspaceRoot, workspaceName, folderCount,
  reloadKey, isDevBridge, onReopenWorkspace, sessionKey,
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
  sessionKey: string
}): VNode {
  const [view, setView] = useState<'files' | 'changes'>('files')
  const [managing, setManaging] = useState(false)

  const decor = useMemo(() => decorateChanges(changes.map((c) => ({
    openPath: c.openPath,
    revisions: c.revisions,
    ...(c.lastFailed !== undefined ? { lastFailed: c.lastFailed } : {}),
    stat: c.ok ? diffStat(c.content) : null,
  }))), [changes])

  return (
    <div class="workspace-tab">
      <div class="workspace-head">
        <span class="workspace-title" title={workspaceRoot}>{workspaceName}</span>
        <span class="workspace-meta">
          {folderCount} {folderCount === 1 ? 'папка' : folderCount < 5 ? 'папки' : 'папок'}
        </span>
        <span class="changes-total-spacer" />
        <button
          class={managing ? 'btn btn-small btn-toggled' : 'btn btn-small'}
          onClick={() => setManaging((m) => !m)}
          title="Состав воркспейса: добавить или убрать папку, переименовать, поменять доступ"
        >
          {Icon.folder()} Управление
        </button>
      </div>
      {managing && (
        <div class="workspace-manage">
          <Folders client={client} isDevBridge={isDevBridge} onChanged={onReopenWorkspace} />
        </div>
      )}
      <div class="workspace-views" role="tablist">
        <button
          class={view === 'files' ? 'ws-view ws-view-active' : 'ws-view'}
          role="tab"
          aria-selected={view === 'files'}
          onClick={() => setView('files')}
        >
          Все файлы
        </button>
        <button
          class={view === 'changes' ? 'ws-view ws-view-active' : 'ws-view'}
          role="tab"
          aria-selected={view === 'changes'}
          onClick={() => setView('changes')}
        >
          Изменения{changes.length > 0 ? ` ${changes.length}` : ''}
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
