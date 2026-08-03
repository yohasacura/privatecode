import { useEffect, useRef, useState } from 'preact/hooks'
import { createClient, wsUrlFromSearch, type ConnectionState, type ProtocolClient } from './lib/client'
import { useChatSession } from './lib/use-chat-session'
import { ChatPanel } from './panels/chat'
import { DiffsPanel } from './panels/diffs'
import { StatusBar } from './panels/status'
import { TreePanel } from './panels/tree'
import './App.css'

/**
 * The app shell and the FIRST-RUN FLOW.
 *
 * The original shell rendered three empty panels and waited for the user to discover
 * Settings -> Connect; the header asked `status` BEFORE any `init`, which by design
 * answers `serverUp: false` -- so a fresh launch permanently said "server unreachable"
 * next to a working server. That is the first thing the user saw, and it read as "the
 * app cannot connect to the model". The flow is now:
 *
 *   boot: config.get -> last-used workspace known?
 *     yes -> auto-init with it (+ saved server URL) -> ready
 *     no  -> WELCOME view (workspace picker + server URL + Connect), centered, instead
 *            of three dead panels
 *
 * `status` is only consulted AFTER init (when the host actually has a client to probe),
 * and the header shows the workspace + connection state instead of a stale probe result.
 *
 * Transport selection is unchanged (see lib/client.ts): `?ws=<url>` = dev bridge,
 * otherwise Tauri IPC. `isDevBridge` also picks the text-field workspace input over the
 * native folder dialog (no Tauri window exists behind the bridge).
 */

type Phase =
  | { kind: 'boot' }
  | { kind: 'welcome'; error: string | null }
  | { kind: 'initializing'; workspace: string }
  | { kind: 'ready'; workspace: string; model: string | null }

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8080'

/** Last path segment, for the header ("small-crm", not the whole absolute path). */
function workspaceName(root: string): string {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || root
}

function App() {
  const [client, setClient] = useState<ProtocolClient | null>(null)
  const [connState, setConnState] = useState<ConnectionState>('connecting')
  const [phase, setPhase] = useState<Phase>({ kind: 'boot' })
  const [workspaceInput, setWorkspaceInput] = useState('')
  const [serverInput, setServerInput] = useState(DEFAULT_SERVER_URL)
  const [recents, setRecents] = useState<string[]>([])
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [chatState, dispatch] = useChatSession(client)
  const isDevBridge = wsUrlFromSearch(window.location.search) !== undefined
  // The auto-init must run once per mounted client, not once per render.
  const bootStarted = useRef(false)

  useEffect(() => {
    const wsUrl = wsUrlFromSearch(window.location.search)
    const c: ProtocolClient = createClient(wsUrl)
    setClient(c)
    const unsubState = c.onStateChange(setConnState)

    // Debug convenience only (see the note in the original shell): reachable anyway
    // from any script in this WebView, so this grants nothing new.
    ;(window as unknown as { __pcClient?: ProtocolClient }).__pcClient = c

    return () => {
      unsubState()
      c.close()
    }
  }, [])

  // Boot: learn the saved config, then either auto-connect or show the welcome view.
  useEffect(() => {
    if (!client || bootStarted.current) return
    bootStarted.current = true
    client
      .call('config.get', {})
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
  }, [client])

  async function connect(c: ProtocolClient, workspace: string, serverUrl: string): Promise<void> {
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
      // Remember what worked -- next launch auto-connects with exactly this.
      c.call('config.set', { serverUrl, recentWorkspace: workspace }).catch(() => {})
      const status = await c.call('status', {}).catch(() => ({ serverUp: false as const }))
      setPhase({
        kind: 'ready',
        workspace,
        model: status.serverUp ? (status.model ?? null) : null,
      })
    } catch (e) {
      setPhase({
        kind: 'welcome',
        error: `Could not open the workspace: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }

  async function pickWorkspaceDialog(): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({ directory: true, multiple: false })
    if (typeof result === 'string') setWorkspaceInput(result)
  }

  const ready = phase.kind === 'ready'

  return (
    <div class="shell">
      <header class="shell-header">
        <span class="brand-mark" aria-hidden="true" />
        <h1>PrivateCode</h1>
        {ready && (
          <span class="header-workspace" title={phase.workspace}>
            {workspaceName(phase.workspace)}
          </span>
        )}
        <span class="header-right">
          {ready && phase.model && <span class="header-model">{phase.model}</span>}
          <span class={`conn-dot conn-${connState}`} title={`transport: ${connState}`} />
        </span>
      </header>

      {phase.kind === 'ready' && client
        ? (
          <div class="shell-body">
            <section class="panel panel-tree" aria-label="file tree">
              <div class="panel-title">Explorer</div>
              <TreePanel client={client} toolItems={chatState.items} onOpenFile={setPreviewPath} />
            </section>
            <section class="panel panel-chat" aria-label="chat">
              <ChatPanel client={client} state={chatState} dispatch={dispatch} />
            </section>
            <section class="panel panel-diffs" aria-label="changes">
              <div class="panel-title">Changes</div>
              <DiffsPanel
                client={client}
                toolItems={chatState.items}
                pendingApproval={chatState.pendingApproval}
                previewPath={previewPath}
              />
            </section>
          </div>
          )
        : (
          <div class="welcome">
            <div class="welcome-card">
              <div class="welcome-logo" aria-hidden="true" />
              <h2>PrivateCode</h2>
              <p class="welcome-sub">Private coding agent. Your code never leaves this network.</p>

              {phase.kind === 'boot' && <p class="welcome-wait">starting the agent…</p>}
              {phase.kind === 'initializing' && (
                <p class="welcome-wait">opening {workspaceName(phase.workspace)}…</p>
              )}

              {phase.kind === 'welcome' && client && (
                <>
                  {phase.error && <p class="welcome-error">{phase.error}</p>}
                  <label class="welcome-label" for="ws-input">Project folder</label>
                  <div class="welcome-row">
                    <input
                      id="ws-input"
                      class="welcome-input"
                      placeholder={isDevBridge ? 'D:\\Projects\\my-app' : 'pick a folder…'}
                      value={workspaceInput}
                      onInput={(e) => setWorkspaceInput((e.target as HTMLInputElement).value)}
                    />
                    {!isDevBridge && (
                      <button class="btn" onClick={() => void pickWorkspaceDialog()}>Browse…</button>
                    )}
                  </div>
                  {recents.length > 0 && (
                    <div class="welcome-recents">
                      {recents.slice(0, 4).map((r) => (
                        <button key={r} class="welcome-recent" title={r} onClick={() => setWorkspaceInput(r)}>
                          {workspaceName(r)}
                        </button>
                      ))}
                    </div>
                  )}
                  <label class="welcome-label" for="srv-input">Model server</label>
                  <input
                    id="srv-input"
                    class="welcome-input"
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

      {client && ready && (
        <StatusBar
          client={client}
          chatState={chatState}
          isDevBridge={isDevBridge}
          onSessionSwitched={(info) => dispatch({ type: 'session-switched', ...info })}
        />
      )}
    </div>
  )
}

export default App
