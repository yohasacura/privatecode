import { useMemo, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import type { ChatItem } from '../lib/state'
import { Icon } from '../components/icons'
import { ChangesTab, collectChanges } from './changes-tab'
import { FilesTab } from './files-tab'
import { JobsTab } from './jobs-tab'
import { TerminalTab } from './terminal-tab'
import { useJobs } from '../lib/use-jobs'

/**
 * The right column: everything about the workspace that is not the conversation.
 *
 * Tabs rather than stacked panels because only one of these is ever the answer to what you
 * are looking at right now, and three permanently half-height panels was the previous
 * layout's mistake. The tab bar carries live counts so the tab you are not on can still
 * tell you something happened.
 */

export type ContextTab = 'files' | 'changes' | 'jobs' | 'terminal'

export function ContextPanel({
  client, items, openPath, onOpenFile, hasSession,
}: {
  client: ProtocolClient
  items: ChatItem[]
  openPath: string | null
  onOpenFile: (path: string | null) => void
  hasSession: boolean
}): VNode {
  const [tab, setTab] = useState<ContextTab>('files')
  // Polled at the panel level so the Jobs badge is live on every tab, not only its own.
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
  const changeCount = changes.length

  const tabs: { id: ContextTab; label: string; icon: () => VNode; badge?: number }[] = [
    { id: 'files', label: 'Files', icon: Icon.files },
    { id: 'changes', label: 'Changes', icon: Icon.diff, badge: changeCount },
    { id: 'jobs', label: 'Jobs', icon: Icon.jobs, badge: runningJobs },
    { id: 'terminal', label: 'Terminal', icon: Icon.terminal },
  ]

  return (
    <div class="context-panel">
      <div class="tabbar">
        {tabs.map((t) => (
          <button
            key={t.id}
            class={`tab ${tab === t.id ? 'tab-active' : ''}`}
            onClick={() => setTab(t.id)}
            title={t.label}
          >
            {t.icon()}
            <span class="tab-label">{t.label}</span>
            {t.badge !== undefined && t.badge > 0 && <span class="tab-badge">{t.badge}</span>}
          </button>
        ))}
      </div>

      <div class="tab-body">
        {tab === 'files' && (
          <FilesTab client={client} toolItems={items} openPath={openPath} onOpenFile={onOpenFile} />
        )}
        {tab === 'changes' && (
          <ChangesTab changes={changes} onOpenFile={(p) => { onOpenFile(p); setTab('files') }} />
        )}
        {tab === 'jobs' && <JobsTab client={client} active={tab === 'jobs'} />}
        {tab === 'terminal' && (
          <TerminalTab client={client} items={items} active={tab === 'terminal'} canRun={hasSession} />
        )}
      </div>
    </div>
  )
}
