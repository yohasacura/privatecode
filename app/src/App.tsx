import { useEffect, useState } from 'preact/hooks'
import { createClient, wsUrlFromSearch, type ConnectionState, type ProtocolClient } from './lib/client'
import { useChatSession } from './lib/use-chat-session'
import { ChatPanel } from './panels/chat'
import { DiffsPanel } from './panels/diffs'
import { TreePanel } from './panels/tree'
import './App.css'

/**
 * The app shell: header (title + connection dot), the ONE shared `ProtocolClient` (created
 * once here and handed down to every panel -- there is exactly one sidecar/session per
 * running app, so there must be exactly one client), the ONE shared chat/tool-call session
 * state (`useChatSession`, Task 7 -- tree and diffs both read the same tool.call/
 * tool.result history the chat transcript tracks), and three panel slots -- file tree,
 * chat, diffs, all real as of Task 7. The status bar (Task 8) is still a placeholder.
 *
 * `previewPath` is the one other piece of state shared across panel boundaries: clicking a
 * file in the tree sets it, and the diffs panel is what actually calls `fs.read` and
 * renders the result -- the tree panel itself never reads file contents.
 *
 * Transport selection happens once, at mount, from the URL: `?ws=<url>` picks the dev
 * WebSocket bridge (so the controller can drive this same frontend from a plain browser
 * tab with no Tauri window at all); its absence means real Tauri IPC, the only transport a
 * release build's window ever has a URL for. See `lib/client.ts`'s header comment for the
 * full transport design.
 */
function App() {
  const [client, setClient] = useState<ProtocolClient | null>(null)
  const [connState, setConnState] = useState<ConnectionState>('connecting')
  const [statusText, setStatusText] = useState('checking...')
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [chatState, dispatch] = useChatSession(client)

  useEffect(() => {
    const wsUrl = wsUrlFromSearch(window.location.search)
    const c: ProtocolClient = createClient(wsUrl)
    setClient(c)
    const unsubState = c.onStateChange(setConnState)

    // Debug convenience only, harmless in every build: lets a scripted verification
    // driver (or a developer's own devtools console) call further protocol methods
    // (`init`, `send`, ...) against this exact live client from outside React/Preact's
    // render cycle. This grants no capability a script running in this WebView did not
    // already have -- `invoke`/the WebSocket are both reachable directly regardless.
    ;(window as unknown as { __pcClient?: ProtocolClient }).__pcClient = c

    // `status` needs no prior `init` call (see host.ts's own status(): it degrades to
    // `{serverUp: false}` before init rather than throwing) -- so it doubles here as a
    // zero-side-effect round-trip proving the transport itself works end to end, without
    // requiring a workspace or server URL yet.
    c
      .call('status', {})
      .then((result) => {
        setStatusText(result.serverUp ? `server up (${result.model ?? 'unknown model'})` : 'server unreachable')
      })
      .catch((e: unknown) => {
        setStatusText(`round-trip failed: ${e instanceof Error ? e.message : String(e)}`)
      })

    return () => {
      unsubState()
      c.close()
    }
  }, [])

  return (
    <div class="shell">
      <header class="shell-header">
        <h1>PrivateCode</h1>
        <span class={`conn-dot conn-${connState}`} title={connState} />
        <span class="conn-label">{connState}</span>
        <span class="status-text">{statusText}</span>
      </header>
      <div class="shell-body">
        <section class="panel panel-tree" aria-label="file tree">
          {client
            ? <TreePanel client={client} toolItems={chatState.items} onOpenFile={setPreviewPath} />
            : <div class="panel-placeholder">connecting…</div>}
        </section>
        <section class="panel panel-chat" aria-label="chat">
          {client
            ? <ChatPanel client={client} state={chatState} dispatch={dispatch} />
            : <div class="panel-placeholder">connecting…</div>}
        </section>
        <section class="panel panel-diffs" aria-label="diffs">
          {client
            ? (
              <DiffsPanel
                client={client}
                toolItems={chatState.items}
                pendingApproval={chatState.pendingApproval}
                previewPath={previewPath}
              />
              )
            : <div class="panel-placeholder">connecting…</div>}
        </section>
      </div>
      <footer class="shell-status" aria-label="status bar">
        <div class="panel-placeholder">status bar (Task 8)</div>
      </footer>
    </div>
  )
}

export default App
