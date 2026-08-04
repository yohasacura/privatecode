import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import {
  createClient, restartSidecar, sidecarStderr, withTimeout, wsUrlFromSearch,
  type ConnectionState, type ProtocolClient,
} from './lib/client'
import { useChatSession } from './lib/use-chat-session'
import { baseName } from './lib/format'
import { MIN_CONTEXT, MIN_RAIL, fitColumns } from './lib/layout'
import { Icon } from './components/icons'
import { Splitter } from './components/split'
import { Composer } from './panels/composer'
import { ContextPanel } from './panels/context-panel'
import { SessionsRail, type SessionSwitch } from './panels/sessions-rail'
import { StatusBar, SettingsModal } from './panels/status'
import { Palette, type PaletteAction } from './panels/palette'
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
  /** The agent process is not answering at all -- distinct from `welcome` with an error,
   * which means the agent answered and refused. Nothing the welcome screen offers can help
   * here, so this screen offers the two things that can: what the agent printed on its way
   * out, and a restart. */
  | { kind: 'unreachable'; reason: string; stderr: string[] }

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8080'
/** How long the first request may take before the agent counts as unreachable. Generous:
 * on a cold start Node has to load a 600 kB bundle and the process may be competing with
 * the model server for cores. */
const BOOT_TIMEOUT_MS = 12_000
const RAIL_DEFAULT = 232
/** Wide enough for all four tab names AND their badges at once. At 380 they did not fit,
 * and the bar fell back to icons for everything but the tab you were on. */
const CONTEXT_DEFAULT = 420

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

/**
 * The agent-unreachable screen: what went wrong, what the agent printed on its way out, and
 * a way back. This replaces the state the app was actually in the first time it was run for
 * real — "starting the agent…" forever, with no error, no diagnostics and no recovery.
 */
function AgentDown({
  phase, isDevBridge,
}: {
  phase: { kind: 'unreachable'; reason: string; stderr: string[] }
  isDevBridge: boolean
}): VNode {
  const [restarting, setRestarting] = useState(false)

  function restart(): void {
    setRestarting(true)
    // A fresh sidecar means a fresh SessionHost; reloading is the honest way to get this
    // window's own state back in step with it rather than patching around a half-live one.
    restartSidecar()
      .then(() => window.location.reload())
      .catch(() => setRestarting(false))
  }

  return (
    <div class="welcome">
      <div class="welcome-card">
        <div class="welcome-logo welcome-logo-bad" aria-hidden="true">{Icon.alert()}</div>
        <h1>The agent isn’t running</h1>
        <p class="welcome-sub">{phase.reason}.</p>

        {phase.stderr.length > 0
          ? (
            <>
              <div class="field-label">What it printed</div>
              <pre class="agent-stderr">{phase.stderr.slice(-40).join('\n')}</pre>
            </>
            )
          : (
            <p class="field-hint">
              It left no output, which usually means the process was killed rather than that
              it failed on its own.
            </p>
            )}

        {isDevBridge
          ? (
            <p class="field-hint">
              This window is running against the dev bridge. Restart it with
              {' '}<code>npm run host:dev</code> and reload.
            </p>
            )
          : (
            <button class="btn btn-primary welcome-connect" disabled={restarting} onClick={restart}>
              {restarting ? 'Restarting…' : 'Restart the agent'}
            </button>
            )}
      </div>
    </div>
  )
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
  /** What this workspace is called and how many folders it spans. Kept beside `phase`
   * rather than inside it because it survives a session switch unchanged. */
  const [workspaceLabel, setWorkspaceLabel] = useState<{ name: string; folders: number }>({ name: '', folders: 1 })
  const [paletteOpen, setPaletteOpen] = useState(false)
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

  // Widths persist, window sizes do not. What the user asked for and what fits right now
  // are different facts and only the first is stored: the previous version squeezed the
  // saved numbers themselves on every resize, so docking to a small screen once shrank the
  // layout you had set up on the big one -- permanently, because it was written to disk.
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    function onResize(): void { setWindowWidth(window.innerWidth) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const columns = fitColumns({ windowWidth, railOpen, contextOpen, railWidth, contextWidth })
  const railShown = columns.rail > 0
  const contextShown = columns.context > 0

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
      // `continueLast`: opening a workspace picks up where it was left, rather than
      // discarding the conversation you were in the middle of when you closed the window.
      // Starting clean is the New session button, one click away.
      const init = await c.call('init', { workspaceRoot: workspace, serverUrl, continueLast: true })
      setWorkspaceLabel({ name: init.workspaceName, folders: init.folderCount })
      dispatch({
        type: 'session-switched',
        sessionId: init.sessionId,
        mode: init.mode,
        contextLength: init.contextLength,
        title: init.title,
      })
      // AFTER session-switched, never before: that action resets the transcript, and the
      // host emits its `settings.problem` events while BUILDING the session -- i.e. before
      // the reply above resolves -- so anything appended earlier is wiped microseconds
      // later. The reducer dedupes on exact text, so the double delivery costs nothing.
      if (init.items.length > 0) dispatch({ type: 'transcript-restored', entries: init.items })
      for (const text of init.problems) dispatch({ type: 'settings-problem', text })
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

  // Boot: learn the saved config, then auto-connect or show the welcome screen. The
  // timeout is what makes "the agent died" a screen you can act on instead of a spinner
  // that never resolves -- see `withTimeout`'s comment for why every failure looks the same
  // from here.
  useEffect(() => {
    if (!client || bootStarted.current) return
    bootStarted.current = true
    withTimeout(
      client.call('config.get', {}),
      BOOT_TIMEOUT_MS,
      'the agent process did not answer within 12 seconds',
    )
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
        const reason = e instanceof Error ? e.message : String(e)
        void sidecarStderr().then((stderr) => setPhase({ kind: 'unreachable', reason, stderr }))
      })
  }, [client, connect])

  // The agent dying MID-SESSION is the same dead end as it dying at boot, and it is
  // reported by exactly one signal: the transport going 'closed'. (At boot that signal is
  // unreliable -- a Tauri event fired before the WebView registered its listener is lost --
  // which is what the boot timeout above is for.)
  useEffect(() => {
    if (connState !== 'closed') return
    setPhase((current) => (current.kind === 'unreachable' ? current : { kind: 'unreachable', reason: 'the agent process stopped', stderr: [] }))
    void sidecarStderr().then((stderr) => {
      if (stderr.length > 0) {
        setPhase((current) => (current.kind === 'unreachable' ? { ...current, stderr } : current))
      }
    })
  }, [connState])

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
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); setPaletteOpen((v) => !v) }
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
    if (info.items.length > 0) dispatch({ type: 'transcript-restored', entries: info.items })
    for (const text of info.problems) dispatch({ type: 'settings-problem', text })
    setPreviewPath(null)
  }

  // Stable by construction, and it has to be: `TranscriptRow` is memoised on its props, so
  // an inline arrow recreated on every render would make every row look changed on every
  // streamed token and defeat the memoisation entirely (see transcript.tsx's header).
  const openFileFromTranscript = useCallback((path: string) => {
    setPreviewPath(path)
    setContextOpen(true)
  }, [])

  /**
   * What a palette choice does. Every branch is something the window already does; the
   * palette is a second way in, not a second implementation.
   */
  function runPaletteAction(c: ProtocolClient, action: PaletteAction): void {
    switch (action.kind) {
      case 'session':
        c.call('sessions.resume', { id: action.id })
          .then((r) => onSessionSwitched({
            sessionId: r.sessionId, mode: r.mode, contextLength: r.contextLength,
            title: r.title, problems: r.problems, items: r.items,
          }))
          .catch((e: Error) => dispatch({ type: 'send-failed', message: e.message }))
        return
      case 'file':
        openFileFromTranscript(action.path)
        return
      case 'mode':
        dispatch({ type: 'mode-changed', mode: action.mode })
        c.call('setMode', { mode: action.mode })
          .catch((e: Error) => dispatch({ type: 'send-failed', message: e.message }))
        return
      case 'command':
        if (action.id === 'settings') { setSettingsOpen(true); return }
        c.call('sessions.new', {})
          .then((r) => onSessionSwitched({
            sessionId: r.sessionId, mode: r.mode, contextLength: r.contextLength,
            title: r.title, problems: r.problems, items: r.items,
          }))
          .catch((e: Error) => dispatch({ type: 'send-failed', message: e.message }))
    }
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
          // The NAME, not the folder: a multi-folder workspace whose titlebar showed only
          // its primary folder would be describing a fifth of what the agent can reach.
          <span
            class="titlebar-workspace"
            title={workspaceLabel.folders > 1
              ? `${workspaceLabel.folders} folders · main: ${workspaceRoot}`
              : workspaceRoot}
          >
            {workspaceLabel.name || baseName(workspaceRoot)}
            {workspaceLabel.folders > 1 && (
              <span class="titlebar-folders">+{workspaceLabel.folders - 1}</span>
            )}
          </span>
        )}
        {chatState.session?.title && (
          <span class="titlebar-session" title={chatState.session.title}>{chatState.session.title}</span>
        )}
        <span class="titlebar-spacer" data-tauri-drag-region />
        <span class={`conn-dot conn-${connState}`} title={`agent process: ${connState}`} />
        {/* Reflects what is SHOWN, and is disabled when the window has no room for the
            panel: a toggle that flips a preference nothing can act on reads as broken. */}
        <button
          class={`icon-button ${railShown ? 'icon-button-on' : ''}`}
          onClick={() => setRailOpen((v) => !v)}
          disabled={!railShown && railOpen}
          title={!railShown && railOpen ? 'The window is too narrow for the sessions rail' : 'Sessions (Ctrl+B)'}
        >
          {Icon.sidebar()}
        </button>
        <button
          class={`icon-button ${contextShown ? 'icon-button-on' : ''}`}
          onClick={() => setContextOpen((v) => !v)}
          disabled={!contextShown && contextOpen}
          title={!contextShown && contextOpen ? 'The window is too narrow for the workspace panel' : 'Workspace panel (Ctrl+J)'}
        >
          {Icon.panelRight()}
        </button>
      </header>

      {phase.kind === 'unreachable'
        ? <AgentDown phase={phase} isDevBridge={isDevBridge} />
        : ready && client
        ? (
          <div class="body">
            {railShown && (
              <>
                <aside class="column column-rail" style={{ width: `${columns.rail}px` }}>
                  <SessionsRail
                    client={client}
                    workspaceRoot={workspaceRoot}
                    activeSessionId={chatState.session?.sessionId ?? null}
                    onSessionSwitched={onSessionSwitched}
                    onOpenSettings={() => setSettingsOpen(true)}
                    reloadKey={sessionsKey}
                  />
                </aside>
                <Splitter side="left" min={MIN_RAIL} max={420} current={columns.rail} onResize={setRailWidth} />
              </>
            )}

            <main class="column column-chat">
              <Transcript
                client={client}
                state={chatState}
                dispatch={dispatch}
                onOpenFile={openFileFromTranscript}
              />
              {chatState.problems.length > 0 && (
                <div class="problem-strip">
                  <span class="problem-icon">{Icon.alert()}</span>
                  <div class="problem-list">
                    {chatState.problems.map((p) => <div key={p}>{p}</div>)}
                  </div>
                  <button
                    class="icon-button"
                    onClick={() => dispatch({ type: 'problems-dismissed' })}
                    title="Dismiss"
                  >
                    {Icon.x()}
                  </button>
                </div>
              )}
              <Composer client={client} state={chatState} dispatch={dispatch} modalOpen={settingsOpen} />
            </main>

            {contextShown && (
              <>
                <Splitter side="right" min={MIN_CONTEXT} max={720} current={columns.context} onResize={setContextWidth} />
                <aside class="column column-context" style={{ width: `${columns.context}px` }}>
                  <ContextPanel
                    client={client}
                    items={chatState.items}
                    openPath={previewPath}
                    onOpenFile={setPreviewPath}
                    hasSession={chatState.session !== null}
                    workspaceRoot={workspaceRoot}
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

      {client && ready && phase.kind === 'ready' && <StatusBar client={client} chatState={chatState} />}

      {paletteOpen && client && ready && (
        <Palette
          client={client}
          onClose={() => setPaletteOpen(false)}
          onPick={(action) => runPaletteAction(client, action)}
        />
      )}

      {settingsOpen && client && (
        <SettingsModal
          client={client}
          isDevBridge={isDevBridge}
          onClose={() => setSettingsOpen(false)}
          onSessionSwitched={(info) => {
            dispatch({ type: 'session-switched', ...info })
            if (info.items.length > 0) dispatch({ type: 'transcript-restored', entries: info.items })
            for (const text of info.problems) dispatch({ type: 'settings-problem', text })
            setPhase({ kind: 'ready', workspace: info.workspaceRoot })
            setWorkspaceLabel({ name: info.workspaceName, folders: info.folderCount })
            setPreviewPath(null)
            setSessionsKey((k) => k + 1)
            setSettingsOpen(false)
          }}
        />
      )}
    </div>
  )
}
