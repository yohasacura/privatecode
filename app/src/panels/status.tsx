import { useEffect, useRef, useState } from 'preact/hooks'
import type { AgentMode } from '@core/permissions/engine'
import type { ProtocolClient } from '../lib/client'
import type { ChatState } from '../lib/state'

/**
 * The status bar, sessions drawer, and settings modal (Plan 4 Task 8): everything here
 * reads `ChatState` (via `App.tsx`'s shared `useChatSession`) rather than owning its own
 * copy of session/turn state -- the same one-source-of-truth reasoning Task 7 already
 * applied to tree/diffs. `onSessionSwitched`/`onModeChanged` are the two write paths back
 * into that shared state; everything else here is read-only against it plus its own
 * local UI state (drawer/modal open or closed, form field values).
 */

/** Wire shape of one `sessions.list` entry -- pulled from `HostMethodMap` rather than
 * importing `SessionMeta` from `core/src/session/store.ts` directly, so this file's only
 * cross-package dependency is the SAME protocol-types alias every other panel already
 * uses (see client.ts's header comment). */
type SessionMeta = { id: string; title: string; createdAt: string; updatedAt: string; workspaceRoot: string; mode: AgentMode }

/** `42.3k` / `1.2M` / `487` -- large-number formatting for the context-fill line; never
 * more than one decimal place, and never a unit suffix under 1000. */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function compactionFlashText(c: ChatState['lastCompaction']): string | null {
  if (!c) return null
  switch (c.state) {
    case 'started': return 'compacting…'
    case 'ready': return 'compaction ready'
    case 'applied': return `compacted: ${c.droppedMessages ?? 0} messages summarised`
    case 'postponed': return 'compaction postponed'
    case 'failed': return 'compaction failed'
    default: return null
  }
}

export function StatusBar({
  client, chatState, isDevBridge, onSessionSwitched,
}: {
  client: ProtocolClient
  chatState: ChatState
  /** Dev-bridge mode (a `?ws=` URL) means the workspace picker is a plain text field; a
   * release build (real Tauri IPC) uses the native folder-picker dialog instead -- see
   * `pickWorkspaceDialog` below. */
  isDevBridge: boolean
  onSessionSwitched: (info: { sessionId: string; mode: AgentMode; contextLength: number | null; title: string }) => void
}) {
  const [serverUp, setServerUp] = useState<boolean | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const turnRunningRef = useRef(chatState.turnRunning)
  turnRunningRef.current = chatState.turnRunning

  // Server dot: polls `status` every 10s while idle, NEVER while a turn is running --
  // the single-slot server discipline (Global Constraint 5) means a status poll firing
  // mid-generation would be a second concurrent request against a server that can only
  // ever serve one. The interval itself keeps ticking regardless (so it does not need to
  // be re-subscribed every time a turn starts/ends); the in-flight guard is what actually
  // enforces "never during a turn".
  useEffect(() => {
    let cancelled = false
    function poll(): void {
      if (turnRunningRef.current) return
      client.call('status', {}).then((r) => {
        if (cancelled) return
        setServerUp(r.serverUp)
        setModel(r.model ?? null)
      }).catch(() => { if (!cancelled) setServerUp(false) })
    }
    poll()
    const id = setInterval(poll, 10_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [client])

  // Compaction flash: shows the latest event's text for a few seconds, then clears --
  // `seq` (not just `state`) is the dependency, so a SECOND event with the same state
  // string (two 'postponed's in a row) re-triggers the timer instead of being a no-op.
  useEffect(() => {
    const text = compactionFlashText(chatState.lastCompaction)
    setFlash(text)
    if (text === null) return
    const id = setTimeout(() => setFlash(null), 4_000)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on seq, not the object
  }, [chatState.lastCompaction?.seq])

  const session = chatState.session
  const lastStep = chatState.lastStepDone

  const contextLine = (() => {
    if (!session || session.contextLength === null || lastStep?.promptTokens === undefined) return null
    const used = lastStep.promptTokens
    const total = session.contextLength
    const pct = total > 0 ? Math.round((used / total) * 100) : 0
    return `${formatTokenCount(used)}/${formatTokenCount(total)} (${pct}%)`
  })()

  return (
    <>
      <footer class="shell-status" aria-label="status bar">
        <span class={`status-dot ${serverUp === null ? 'status-unknown' : serverUp ? 'status-up' : 'status-down'}`} />
        <span class="status-item">{model ?? 'model unknown'}</span>
        {session && <span class="status-badge">{session.mode}</span>}
        {lastStep?.tokensPerSecond !== undefined && (
          <span class="status-item">{lastStep.tokensPerSecond.toFixed(1)} tok/s</span>
        )}
        {contextLine && <span class="status-item">{contextLine}</span>}
        {lastStep?.draftAcceptance !== undefined && (
          <span class="status-item">MTP {(lastStep.draftAcceptance * 100).toFixed(0)}%</span>
        )}
        {session && <span class="status-item status-title">{session.title || '(untitled session)'}</span>}
        {flash && <span class="status-flash">{flash}</span>}
        <span class="status-spacer" />
        <button class="status-button" disabled={!session} onClick={() => setSessionsOpen(true)}>Sessions</button>
        <button class="status-button" onClick={() => setSettingsOpen(true)}>Settings</button>
      </footer>

      {sessionsOpen && session && (
        <SessionsDrawer
          client={client}
          onClose={() => setSessionsOpen(false)}
          onSessionSwitched={(info) => { onSessionSwitched(info); setSessionsOpen(false) }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          client={client}
          isDevBridge={isDevBridge}
          onClose={() => setSettingsOpen(false)}
          onSessionSwitched={(info) => { onSessionSwitched(info); setSettingsOpen(false) }}
        />
      )}
    </>
  )
}

function SessionsDrawer({
  client, onClose, onSessionSwitched,
}: {
  client: ProtocolClient
  onClose: () => void
  onSessionSwitched: (info: { sessionId: string; mode: AgentMode; contextLength: number | null; title: string }) => void
}) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    client.call('sessions.list', {})
      .then((r) => setSessions(r.sessions))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [client])

  function resume(id: string): void {
    client.call('sessions.resume', { id })
      .then((r) => onSessionSwitched({ sessionId: r.sessionId, mode: r.mode, contextLength: r.contextLength, title: r.title }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  function startNew(): void {
    client.call('sessions.new', {})
      .then((r) => onSessionSwitched({ sessionId: r.sessionId, mode: r.mode, contextLength: r.contextLength, title: r.title }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div class="drawer-overlay" onClick={onClose}>
      <div class="drawer" onClick={(e) => e.stopPropagation()}>
        <div class="drawer-header">
          <b>Sessions</b>
          <button onClick={startNew}>New session</button>
          <button class="drawer-close" onClick={onClose}>×</button>
        </div>
        {error && <div class="chat-error">⚠ {error}</div>}
        {sessions === null && !error && <div class="panel-placeholder">loading…</div>}
        {sessions && sessions.length === 0 && <div class="panel-placeholder">no saved sessions yet</div>}
        <div class="drawer-list">
          {sessions?.map((s) => (
            <div key={s.id} class="drawer-row">
              <div class="drawer-row-title">{s.title || '(untitled)'}</div>
              <div class="drawer-row-meta">{s.mode} · updated {s.updatedAt}</div>
              <button onClick={() => resume(s.id)}>Resume</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function SettingsModal({
  client, isDevBridge, onClose, onSessionSwitched,
}: {
  client: ProtocolClient
  isDevBridge: boolean
  onClose: () => void
  onSessionSwitched: (info: { sessionId: string; mode: AgentMode; contextLength: number | null; title: string }) => void
}) {
  const [serverUrl, setServerUrl] = useState('http://127.0.0.1:8080')
  const [workspace, setWorkspace] = useState('')
  const [recent, setRecent] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    client.call('config.get', {})
      .then((r) => {
        if (r.serverUrl !== undefined) setServerUrl(r.serverUrl)
        setRecent(r.recentWorkspaces)
      })
      .catch(() => { /* config.get degrading to defaults is already handled host-side; nothing more to do here */ })
  }, [client])

  async function pickWorkspaceDialog(): Promise<void> {
    // Release-only: the dev-bridge transport has no Tauri window behind it to own a
    // native dialog, so that mode uses the plain text field below instead.
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({ directory: true, multiple: false })
    if (typeof result === 'string') setWorkspace(result)
  }

  function connect(): void {
    if (workspace.trim() === '' || serverUrl.trim() === '') return
    setConnecting(true)
    setError(null)
    client.call('init', { workspaceRoot: workspace.trim(), serverUrl: serverUrl.trim() })
      .then((r) => {
        client.call('config.set', { serverUrl: serverUrl.trim(), recentWorkspace: workspace.trim() }).catch(() => {})
        onSessionSwitched({ sessionId: r.sessionId, mode: r.mode, contextLength: r.contextLength, title: r.title })
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setConnecting(false))
  }

  return (
    <div class="drawer-overlay" onClick={onClose}>
      <div class="drawer settings-modal" onClick={(e) => e.stopPropagation()}>
        <div class="drawer-header">
          <b>Settings</b>
          <button class="drawer-close" onClick={onClose}>×</button>
        </div>

        <label class="settings-label">Server URL</label>
        <input
          class="settings-input"
          value={serverUrl}
          onInput={(e) => setServerUrl(e.currentTarget.value)}
          placeholder="http://127.0.0.1:8080"
        />

        <label class="settings-label">Workspace</label>
        {isDevBridge ? (
          <input
            class="settings-input"
            value={workspace}
            onInput={(e) => setWorkspace(e.currentTarget.value)}
            placeholder="C:/path/to/project"
          />
        ) : (
          <div class="settings-workspace-row">
            <input class="settings-input" value={workspace} readOnly placeholder="(none picked)" />
            <button onClick={() => void pickWorkspaceDialog()}>Browse…</button>
          </div>
        )}

        {recent.length > 0 && (
          <div class="settings-recent">
            <div class="settings-label">Recent workspaces</div>
            {recent.map((w) => (
              <div key={w} class="settings-recent-row" onClick={() => setWorkspace(w)}>{w}</div>
            ))}
          </div>
        )}

        {error && <div class="chat-error">⚠ {error}</div>}

        <button
          class="settings-connect"
          disabled={connecting || workspace.trim() === '' || serverUrl.trim() === ''}
          onClick={connect}
        >
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </div>
  )
}
