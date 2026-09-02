import { useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Files, History, Terminal } from 'lucide-preact'
import type { ProtocolClient } from '../lib/client'
import type { ChatItem } from '../lib/state'
import { Tabs, tabPanelId, type TabItem } from '../ui/tabs'
import type { ChangeEntry } from './changes-tab'
import { WorkspaceTab } from './workspace-tab'
import { HistoryTab } from './history-tab'
import { TerminalTab } from './terminal-tab'
import { useJobs } from '../lib/use-jobs'

/**
 * The right column: everything about the workspace that is not the conversation
 * (docs/UI-REDESIGN-2026-09.md §7).
 *
 * Tabs rather than stacked panels because only one of these is ever the answer to what you
 * are looking at right now, and three permanently half-height panels was an earlier layout's
 * mistake. The tab bar carries live counts so the tab you are not on can still tell you
 * something happened.
 *
 * There were five tabs and there are now three. Jobs and Terminal were one question asked
 * twice, and Files and Changes are one tree wearing the changes; the two extra bars did not
 * fit the panel's minimum width and pushed the whole shell sideways.
 */

export type ContextTab = 'workspace' | 'history' | 'terminal'

export const INSPECTOR = 'inspector'

export function ContextPanel({
  client, items, changes, reloadKey, onOpenFile, hasSession, workspaceRoot, workspaceName,
  folderCount, isDevBridge, onReopenWorkspace, onSwitchWorkspace, onCloseWorkspace,
  sessionKey, reviewed, onMarkReviewed,
}: {
  client: ProtocolClient
  items: ChatItem[]
  /** The session's changes, computed once in App — the chat-column diff tabs read the
   * same list, and two computations of one truth would drift. */
  changes: ChangeEntry[]
  /** Bumps when a write tool resolves or a Put back changes the disk. */
  reloadKey: number
  /** Opens a file as a TAB beside the chat; `face: 'diff'` lands on the diff. */
  onOpenFile: (path: string, face?: 'file' | 'diff') => void
  hasSession: boolean
  /** Which workspace these paths belong to; see `TreePanel`. */
  workspaceRoot: string
  workspaceName: string
  folderCount: number
  isDevBridge: boolean
  /** Re-opens the workspace after its folder set was edited inline. */
  onReopenWorkspace: () => void
  /** The workspace lifecycle controls the tab's header carries — see WorkspaceTab. */
  onSwitchWorkspace: () => void
  onCloseWorkspace: () => void
  /** The live session's id. Keys the Changes tab, so its reviewed-state — a per-session
   * judgement — resets when the session does instead of leaking across. */
  sessionKey: string
  reviewed: ReadonlyMap<string, number>
  onMarkReviewed: (entries: readonly ChangeEntry[]) => void
}): VNode {
  const [tab, setTab] = useState<ContextTab>('workspace')
  // Polled at the panel level so the Terminal badge is live on every tab, not only its own.
  const { jobs } = useJobs(client, hasSession, 2000)
  const runningJobs = jobs.filter((j) => j.running).length

  const tabs: TabItem<ContextTab>[] = [
    { id: 'workspace', label: 'Workspace', icon: <Files />, badge: changes.length },
    { id: 'history', label: 'History', icon: <History /> },
    { id: 'terminal', label: 'Terminal', icon: <Terminal />, badge: runningJobs },
  ]

  return (
    <div data-inspector="" class="flex h-full flex-col font-ui">
      <Tabs group={INSPECTOR} tabs={tabs} active={tab} onChange={setTab} label="Inspector" dense />

      <div
        role="tabpanel"
        id={tabPanelId(INSPECTOR, tab)}
        aria-labelledby={`${INSPECTOR}-tab-${tab}`}
        class="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {tab === 'workspace' && (
          <WorkspaceTab
            client={client}
            items={items}
            changes={changes}
            onOpenFile={onOpenFile}
            workspaceRoot={workspaceRoot}
            workspaceName={workspaceName}
            folderCount={folderCount}
            reloadKey={reloadKey}
            isDevBridge={isDevBridge}
            onReopenWorkspace={onReopenWorkspace}
            onSwitchWorkspace={onSwitchWorkspace}
            onCloseWorkspace={onCloseWorkspace}
            sessionKey={sessionKey}
            reviewed={reviewed}
            onMarkReviewed={onMarkReviewed}
          />
        )}
        {tab === 'history' && <HistoryTab client={client} reloadKey={reloadKey} />}
        {tab === 'terminal' && (
          <TerminalTab client={client} items={items} active={tab === 'terminal'} canRun={hasSession} />
        )}
      </div>
    </div>
  )
}
