import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { createClient, wsUrlFromSearch, type ConnectionState, type ProtocolClient } from './lib/client'
import { useChatSession } from './lib/use-chat-session'
import { baseName } from './lib/format'
import { Icon } from './components/icons'
import { Splitter } from './components/split'
import { Composer } from './panels/composer'
import { ContextPanel } from './panels/context-panel'
import { SessionsRail, type SessionSwitch } from './panels/sessions-rail'
import { StatusBar, SettingsModal } from './panels/status'
import { Transcript } from './panels/transcript'
import './App.css'

/**
 * The shell: three columns — sessions, conversation, workspace context — plus a title bar
 * and a status bar.
 *
 * The previous shell gave the chat a third of the window between a file tree and a diff
 * list, which is an IDE's shape, not an agent's: the conversation IS the tool, and the
 * other two are reference material you consult occasionally. Here the centre column takes
 * everything the side columns do not, and both sides collapse to nothing (Ctrl+B / Ctrl+J)
 * and remember their width.
 *
 * The first-run flow is unchanged in substance and worth restating, because it was a real
 * bug: `status` answers `serverUp: false` by design before any `init`, so the original
 * header called it on boot and permanently reported "server unreachable" next to a working
 * server. Boot now reads the saved config, auto-connects to the last workspace if there is
 * one, and otherwise shows a welcome screen — `status` is only ever consulted after `init`.
 */

type Phase =
  | { kind: 'boot' }
  | { kind: 'welcome'; error: string | null }
  | { kind: 'initializing'; workspace: string }
  | { kind: 'ready'; workspace: string }

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8080'
const RAIL_DEFAULT = 232
const CONTEXT_DEFAULT = 380

/** Column widths and collapse state live in localStorage: a layout you have to re-arrange
 * on every launch is one you stop arranging. */
function loadLayout<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`pc.layout.${key}`)
    return raw === null ? fallback : JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function saveLayout(key: string, value: unknown): void {
  try { localStorage.setItem(`pc.layout.${key}`, JSON.stringify(value)) } catch { /* private mode */ }
}

export default function App() {
  const [client, setClient] = useState<ProtocolClient | null>(null)
  const [connState, setConnState] = useState<ConnectionState>('connecting')
  const [phase, setPhase] = useState<Phase>({ kind: 'boot' })
  const [workspaceInput, setWorkspaceInput] = useState('')
  const [serverInput, setServerInput] = useState(DEFAULT_SERVER_URL)
  const [recents, setRecents] = useState<string[]>([])
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sessionsKey, setSessionsKey] = useState(0)
  const [chatState, dispatch] = useChatSession(client)

  const [railOpen, setRailOpen] = useState(() => loadLayout('railOpen', true))
  const [contextOpen, setContextOpen] = useState(() => loadLayout('contextOpen', true))
  const [railWidth, setRailWidth] = useState(() => loadLayout('railWidth', RAIL_DEFAULT))
  const [contextWidth, setContextWidth] = useState(() => loadLayout('contextWidth', CONTEXT_DEFAULT))

  const isDevBridge = wsUrlFromSearch(window.location.search) !== undefined
  const bootStarted = useRef(false)

  useEffect(() => { saveLayout('railOpen', railOpen) }, [railOpen])
  useEffect(() => { saveLayout('contextOpen', contextOpen) }, [contextOpen])
  useEffect(() => { saveLayout('railWidth', railWidth) }, [railWidth])
  useEffect(() => { saveLayout('contextWidth', contextWidth) }, [contextWidth])

  useEffect(() => {
    const c: ProtocolClient = createClient(wsUrlFromSearch(window.location.search))
    setClient(c)
    const unsubState = c.onStateChange(setConnState)
    // Debug convenience only: any script in this WebView could reach the same object
    // anyway, so exposing it grants nothing new.
    ;(window as unknown as { __pcClient?: ProtocolClient }).__pcClient = c
    return () => { unsubState(); c.close() }
  }, [])

  const connect = useCallback(async (c: ProtocolClient, workspace: string, serverUrl: string): Promise<void> => {
    setPhase({ kind: 'initializing', workspace })
    try {
      const init = await c.call('init', { workspaceRoot: workspace, serverUrl })
      dispatch({
        type: 'session-switched',
        sessionId: init.sessionId,
        mode: init.mode,
        contextLength: init.contextLength,
        title: init.title,
      })
      // Remember what worked; the next launch auto-connects with exactly this.
      c.call('config.set', { serverUrl, recentWorkspace: workspace }).catch(() => {})
      setPhase({ kind: 'ready', workspace })
      setSessionsKey((k) => k + 1)
    } catch (e) {
      setPhase({
        kind: 'welcome',
        error: `Could not open that folder: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }, [dispatch])

  // Boot: learn the saved config, then auto-connect or show the welcome screen.
  useEffect(() => {
    if (!client || bootStarted.current) return
    bootStarted.current = true
    client.call('config.get', {})
      .then((cfg) => {
        const savedUrl = cfg.serverUrl ?? DEFAULT_SERVER_URL
        setServerInput(savedUrl)
        setRecents(cfg.recentWorkspaces)
        const last = cfg.recentWorkspaces[0]
        if (last) {
          setWorkspaceInput(last)
          void connect(client, last, savedUrl)
        } else {
          setPhase({ kind: 'welcome', error: null })
        }
      })
      .catch((e: unknown) => {
        setPhase({
          kind: 'welcome',
          error: `The agent process did not answer (${e instanceof Error ? e.message : String(e)}).`,
        })
      })
  }, [client, connect])

  // A finished turn may have written the session title, so the rail is refreshed then --
  // there is no protocol event for "a session's metadata changed".
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !chatState.turnRunning) setSessionsKey((k) => k + 1)
    wasRunning.current = chatState.turnRunning
  }, [chatState.turnRunning])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!e.ctrlKey || e.altKey) return
      if (e.key === 'b' || e.key === 'B') { e.preventDefault(); setRailOpen((v) => !v) }
      if (e.key === 'j' || e.key === 'J') { e.preventDefault(); setContextOpen((v) => !v) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function pickWorkspaceDialog(): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({ directory: true, multiple: false })
    if (typeof result === 'string') setWorkspaceInput(result)
  }

  function onSessionSwitched(info: SessionSwitch): void {
    dispatch({ type: 'session-switched', ...info })
    setPreviewPath(null)
  }

  const ready = phase.kind === 'ready'
  const workspaceRoot = phase.kind === 'ready' ? phase.workspace : ''

  return (
    <div class="shell">
      <header class="titlebar" data-tauri-drag-region>
        <span class="brand" data-tauri-drag-region>
          <span class="brand-mark" aria-hidden="true">{Icon.shield()}</span>
          PrivateCode
        </span>
        {ready && (
          <span class="titlebar-workspace" title={workspaceRoot}>{baseName(workspaceRoot)}</span>
        )}
        {chatState.session?.title && (
          <span class="titlebar-session" title={chatState.session.title}>{chatState.session.title}</span>
        )}
        <span class="titlebar-spacer" data-tauri-drag-region />
        <span class={`conn-dot conn-${connState}`} title={`agent process: ${connState}`} />
        <button
          class={`icon-button ${railOpen ? 'icon-button-on' : ''}`}
          onClick={() => setRailOpen((v) => !v)}
          title="Sessions (Ctrl+B)"
        >
          {Icon.sidebar()}
        </button>
        <button
          class={`icon-button ${contextOpen ? 'icon-button-on' : ''}`}
          onClick={() => setContextOpen((v) => !v)}
          title="Workspace panel (Ctrl+J)"
        >
          {Icon.panelRight()}
        </button>
      </header>

      {ready && client
        ? (
          <div class="body">
            {railOpen && (
              <>
                <aside class="column column-rail" style={{ width: `${railWidth}px` }}>
                  <SessionsRail
                    client={client}
                    workspaceRoot={workspaceRoot}
                    activeSessionId={chatState.session?.sessionId ?? null}
                    onSessionSwitched={onSessionSwitched}
                    onOpenSettings={() => setSettingsOpen(true)}
                    reloadKey={sessionsKey}
                  />
                </aside>
                <Splitter side="left" min={180} max={420} current={railWidth} onResize={setRailWidth} />
              </>
            )}

            <main class="column column-chat">
              <Transcript
                client={client}
                state={chatState}
                dispatch={dispatch}
                onOpenFile={(path) => { setPreviewPath(path); setContextOpen(true) }}
              />
              <Composer client={client} state={chatState} dispatch={dispatch} />
            </main>

            {contextOpen && (
              <>
                <Splitter side="right" min={280} max={720} current={contextWidth} onResize={setContextWidth} />
                <aside class="column column-context" style={{ width: `${contextWidth}px` }}>
                  <ContextPanel
                    client={client}
                    items={chatState.items}
                    openPath={previewPath}
                    onOpenFile={setPreviewPath}
                    hasSession={chatState.session !== null}
                  />
                </aside>
              </>
            )}
          </div>
          )
        : (
          <div class="welcome">
            <div class="welcome-card">
              <div class="welcome-logo" aria-hidden="true">{Icon.shield()}</div>
              <h1>PrivateCode</h1>
              <p class="welcome-sub">A coding agent that runs entirely on your machine.</p>

              {phase.kind === 'boot' && <p class="welcome-wait">starting the agent…</p>}
              {phase.kind === 'initializing' && (
                <p class="welcome-wait">opening {baseName(phase.workspace)}…</p>
              )}

              {phase.kind === 'welcome' && client && (
                <>
                  {phase.error && <div class="panel-error">{phase.error}</div>}

                  <label class="field-label" for="ws-input">Project folder</label>
                  <div class="field-row">
                    <input
                      id="ws-input"
                      class="input"
                      placeholder={isDevBridge ? 'D:\\Projects\\my-app' : 'pick a folder…'}
                      value={workspaceInput}
                      onInput={(e) => setWorkspaceInput((e.target as HTMLInputElement).value)}
                    />
                    {!isDevBridge && (
                      <button class="btn" onClick={() => void pickWorkspaceDialog()}>Browse…</button>
                    )}
                  </div>

                  {recents.length > 0 && (
                    <div class="recent-list">
                      {recents.slice(0, 5).map((r) => (
                        <button key={r} class="recent-item" title={r} onClick={() => setWorkspaceInput(r)}>
                          {baseName(r)}
                        </button>
                      ))}
                    </div>
                  )}

                  <label class="field-label" for="srv-input">Model server</label>
                  <input
                    id="srv-input"
                    class="input"
                    value={serverInput}
                    onInput={(e) => setServerInput((e.target as HTMLInputElement).value)}
                  />

                  <button
                    class="btn btn-primary welcome-connect"
                    disabled={workspaceInput.trim() === '' || serverInput.trim() === ''}
                    onClick={() => void connect(client, workspaceInput.trim(), serverInput.trim())}
                  >
                    Open workspace
                  </button>
                </>
              )}
            </div>
          </div>
          )}

      {client && ready && <StatusBar client={client} chatState={chatState} />}

      {settingsOpen && client && (
        <SettingsModal
          client={client}
          isDevBridge={isDevBridge}
          onClose={() => setSettingsOpen(false)}
          onSessionSwitched={(info) => {
            dispatch({ type: 'session-switched', ...info })
            setPhase({ kind: 'ready', workspace: info.workspaceRoot })
            setPreviewPath(null)
            setSessionsKey((k) => k + 1)
            setSettingsOpen(false)
          }}
        />
      )}
    </div>
  )
}
