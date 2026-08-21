import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { AgentMode } from '@core/permissions/engine'
import type { TranscriptEntry } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { relativeTime } from '../lib/format'
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
  compactAt?: number
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
  client, activeSessionId, viewingSessionId, turnRunning,
  onSessionSwitched, onView, onOpenSettings, reloadKey,
}: {
  client: ProtocolClient
  /** The session the composer talks to — the one that is, or can be, working. */
  activeSessionId: string | null
  /** The session being READ, when that is not the active one. */
  viewingSessionId: string | null
  turnRunning: boolean
  onSessionSwitched: (info: SessionSwitch) => void
  /** Clicking a session READS it. Becoming it happens when you send — see the composer. */
  onView: (id: string) => void
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
      problems: r.problems, items: r.items, contextUsed: r.contextUsed, ...(r.compactAt !== undefined ? { compactAt: r.compactAt } : {}),
    })))
  }

  // No `resume` here any more. Clicking a session used to BECOME it, which tore down the
  // live session and aborted whatever turn was running: "let me glance at yesterday" and
  // "abandon what I am doing" were the same click. Now the click reads, and sending is what
  // commits to the switch.

  return (
    <div class="rail">
      {/* The workspace switcher used to sit here, above the sessions — the owner looked
          for it in the Workspace tab and found a duplicate here instead. It lives on the
          tab now; this rail is sessions, full stop. */}
      <button class="rail-new btn btn-primary" onClick={startNew} disabled={busy}>
        {Icon.plus()} New session
      </button>

      <div class="rail-section">Sessions</div>

      {error && <button class="rail-error" onClick={load} title="click to retry">{error}</button>}
      {sessions === null && !error && <div class="rail-placeholder loading-quiet">loading…</div>}
      {sessions?.length === 0 && <div class="rail-placeholder">nothing saved yet</div>}

      <div class="rail-list">
        {sessions?.map((s) => (
          <button
            key={s.id}
            class={[
              'rail-item',
              s.id === activeSessionId ? 'rail-item-active' : '',
              // The one you are LOOKING at, when that is not the one that works.
              s.id === viewingSessionId && s.id !== activeSessionId ? 'rail-item-viewing' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => onView(s.id)}
            disabled={busy}
            // "the running session keeps going" is only reassuring while something RUNS —
            // read next to an idle composer it claimed a running session that did not exist.
            title={s.id === activeSessionId
              ? `${s.title || '(untitled)'}\nthe active session — typing below continues it`
              : turnRunning
                ? `${s.title || '(untitled)'}\nclick to read it — the running session keeps going`
                : `${s.title || '(untitled)'}\nclick to read it — sending a message is what makes it the active one`}
          >
            <span class="rail-item-title">{s.title || '(untitled)'}</span>
            <span class="rail-item-meta">
              {s.id === activeSessionId && (
                <span
                  class={`rail-item-live ${turnRunning ? 'rail-item-live-busy' : ''}`}
                  title={turnRunning ? 'working right now' : 'the active session'}
                >
                  {turnRunning ? 'working' : 'active'}
                </span>
              )}
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
