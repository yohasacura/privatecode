import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { AgentMode } from '@core/permissions/engine'
import type { TranscriptEntry } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { baseName, relativeTime } from '../lib/format'
import { Icon } from '../components/icons'

/**
 * The left column: which conversation you are in, and every other one you could go back to.
 *
 * This used to be a modal drawer behind a status-bar button, which meant resuming yesterday's
 * work took a click into a dialog that then covered the thing you were trying to compare it
 * to. A conversation list is navigation, and navigation belongs in a rail.
 */

export interface SessionSwitch {
  sessionId: string
  mode: AgentMode
  contextLength: number | null
  title: string
  /** Config problems the engine found while building this session. Carried here rather
   * than left to the `settings.problem` events alone: the host emits those BEFORE the
   * reply that ends the switch, and the switch resets the transcript, so an event-only
   * path is wiped microseconds after it lands. */
  problems: string[]
  /** How full the context already is, so the status bar has something true to show before
   * the first message rather than after it. */
  contextUsed: { promptTokens: number | null; approxTokens: number }
  /** The conversation this session already had. Empty for a new one. */
  items: readonly TranscriptEntry[]
}

type SessionMeta = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  workspaceRoot: string
  mode: AgentMode
}

export function SessionsRail({
  client, workspaceRoot, activeSessionId, onSessionSwitched, onOpenSettings, reloadKey,
}: {
  client: ProtocolClient
  workspaceRoot: string
  activeSessionId: string | null
  onSessionSwitched: (info: SessionSwitch) => void
  onOpenSettings: () => void
  /** Bumped by the shell whenever the session set may have changed (a turn finished, so a
   * title may have been written; a session was created). */
  reloadKey: number
}): VNode {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    client.call('sessions.list', {})
      .then((r) => { setSessions(r.sessions); setError(null) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [client])

  useEffect(load, [load, reloadKey])

  function switchTo(promise: Promise<SessionSwitch>): void {
    setBusy(true)
    promise
      .then((info) => { onSessionSwitched(info); load() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  function startNew(): void {
    switchTo(client.call('sessions.new', {}).then((r) => ({
      sessionId: r.sessionId, mode: r.mode, contextLength: r.contextLength, title: r.title,
      problems: r.problems, items: r.items, contextUsed: r.contextUsed,
    })))
  }

  function resume(id: string): void {
    if (id === activeSessionId) return
    switchTo(client.call('sessions.resume', { id }).then((r) => ({
      sessionId: r.sessionId, mode: r.mode, contextLength: r.contextLength, title: r.title,
      problems: r.problems, items: r.items, contextUsed: r.contextUsed,
    })))
  }

  return (
    <div class="rail">
      <button class="rail-workspace" onClick={onOpenSettings} title={`${workspaceRoot}\nclick to switch workspace`}>
        {Icon.folder()}
        <span class="rail-workspace-name">{baseName(workspaceRoot)}</span>
        {Icon.chevronDown()}
      </button>

      <button class="rail-new btn btn-primary" onClick={startNew} disabled={busy}>
        {Icon.plus()} New session
      </button>

      <div class="rail-section">Sessions</div>

      {error && <div class="rail-error" onClick={load} title="click to retry">{error}</div>}
      {sessions === null && !error && <div class="rail-placeholder">loading…</div>}
      {sessions?.length === 0 && <div class="rail-placeholder">nothing saved yet</div>}

      <div class="rail-list">
        {sessions?.map((s) => (
          <button
            key={s.id}
            class={`rail-item ${s.id === activeSessionId ? 'rail-item-active' : ''}`}
            onClick={() => resume(s.id)}
            disabled={busy}
            title={s.title || '(untitled)'}
          >
            <span class="rail-item-title">{s.title || '(untitled)'}</span>
            <span class="rail-item-meta">
              {relativeTime(s.updatedAt)}
              <span class={`rail-item-mode mode-${s.mode}`}>{s.mode}</span>
            </span>
          </button>
        ))}
      </div>

      <button class="rail-settings" onClick={onOpenSettings}>
        {Icon.gear()} Settings
      </button>
    </div>
  )
}
