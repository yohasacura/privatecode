import { useMemo, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import type { ChatItem } from '../lib/state'
import { Icon } from '../components/icons'
import { ChangesTab, collectChanges } from './changes-tab'
import { FilesTab } from './files-tab'
import { HistoryTab } from './history-tab'
import { TerminalTab } from './terminal-tab'
import { useJobs } from '../lib/use-jobs'

/**
 * The right column: everything about the workspace that is not the conversation.
 *
 * Tabs rather than stacked panels because only one of these is ever the answer to what you
 * are looking at right now, and three permanently half-height panels was an earlier layout's
 * mistake. The tab bar carries live counts so the tab you are not on can still tell you
 * something happened.
 *
 * There were five tabs and there are now four. Jobs and Terminal were one question asked
 * twice, and the fifth tab did not fit: at the default panel width the bar was 398px of tabs
 * in a 380px panel, which put Terminal's right edge 19px past the window and made the whole
 * shell scroll sideways. Merging them fixed the layout by removing the reason for it rather
 * than by shrinking type until it squeezed in.
 *
 * Changes leads, and is the tab a new session opens on. This column answers "what has the
 * agent done to my workspace", and a file tree answers a question you could have asked
 * before it started.
 */

export type ContextTab = 'changes' | 'history' | 'files' | 'terminal'

export function ContextPanel({
  client, items, openPath, onOpenFile, hasSession, workspaceRoot, sessionKey,
}: {
  client: ProtocolClient
  items: ChatItem[]
  openPath: string | null
  onOpenFile: (path: string | null) => void
  hasSession: boolean
  /** Which workspace these paths belong to; see `TreePanel`. */
  workspaceRoot: string
  /** The live session's id. Keys the Changes tab, so its reviewed-state — a per-session
   * judgement — resets when the session does instead of leaking across. */
  sessionKey: string
}): VNode {
  const [tab, setTab] = useState<ContextTab>('changes')
  // Polled at the panel level so the Terminal badge is live on every tab, not only its own.
  const { jobs } = useJobs(client, hasSession, 2000)
  const runningJobs = jobs.filter((j) => j.running).length

  // `items` is a new array on every streamed token, so memoising on it directly would
  // never hit. The change list can only move when an item is ADDED or when a tool call
  // gets its result -- neither of which a token does -- so those two counts are an exact
  // key, and they cost a loop instead of a JSON.parse per write call per token.
  const resolvedTools = items.reduce((n, i) => n + (i.kind === 'tool' && i.result !== undefined ? 1 : 0), 0)
  const changes = useMemo(
    () => collectChanges(items),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the two counts above
    [items.length, resolvedTools],
  )

  const tabs: { id: ContextTab; label: string; icon: () => VNode; badge?: number }[] = [
    { id: 'changes', label: 'Changes', icon: Icon.diff, badge: changes.length },
    { id: 'history', label: 'History', icon: Icon.history },
    { id: 'files', label: 'Files', icon: Icon.files },
    { id: 'terminal', label: 'Terminal', icon: Icon.terminal, badge: runningJobs },
  ]

  return (
    <div class="context-panel">
      <div class="tabbar" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            class={`tab ${tab === t.id ? 'tab-active' : ''}`}
            onClick={() => setTab(t.id)}
            title={t.label}
            role="tab"
            aria-selected={tab === t.id}
          >
            {t.icon()}
            <span class="tab-label">{t.label}</span>
            {t.badge !== undefined && t.badge > 0 && <span class="tab-badge">{t.badge}</span>}
          </button>
        ))}
      </div>

      <div class="tab-body">
        {tab === 'changes' && (
          <ChangesTab
          key={sessionKey}
            changes={changes}
            onOpenFile={(p) => { onOpenFile(p); setTab('files') }}
            client={client}
            reloadKey={resolvedTools}
          />
        )}
        {tab === 'history' && <HistoryTab client={client} reloadKey={resolvedTools} />}
        {tab === 'files' && (
          <FilesTab
            client={client}
            toolItems={items}
            openPath={openPath}
            onOpenFile={onOpenFile}
            workspaceRoot={workspaceRoot}
          />
        )}
        {tab === 'terminal' && (
          <TerminalTab client={client} items={items} active={tab === 'terminal'} canRun={hasSession} />
        )}
      </div>
    </div>
  )
}
