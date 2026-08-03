import { useEffect, useState } from 'preact/hooks'
import { createClient, wsUrlFromSearch, type ConnectionState, type ProtocolClient } from './lib/client'
import './App.css'

/**
 * The app shell: header (title + connection dot) and three empty panel slots -- file tree,
 * chat, diffs -- filled in by Tasks 5-7. The status bar (Task 8) is a fourth, bottom-docked
 * slot, also still empty here.
 *
 * Transport selection happens once, at mount, from the URL: `?ws=<url>` picks the dev
 * WebSocket bridge (so the controller can drive this same frontend from a plain browser
 * tab with no Tauri window at all); its absence means real Tauri IPC, the only transport a
 * release build's window ever has a URL for. See `lib/client.ts`'s header comment for the
 * full transport design.
 */
function App() {
  const [state, setState] = useState<ConnectionState>('connecting')
  const [statusText, setStatusText] = useState('checking...')

  useEffect(() => {
    const wsUrl = wsUrlFromSearch(window.location.search)
    const client: ProtocolClient = createClient(wsUrl)
    const unsubState = client.onStateChange(setState)

    // Debug convenience only, harmless in every build: lets a scripted verification
    // driver (or a developer's own devtools console) call further protocol methods
    // (`init`, `send`, ...) against this exact live client from outside React/Preact's
    // render cycle. This grants no capability a script running in this WebView did not
    // already have -- `invoke`/the WebSocket are both reachable directly regardless.
    ;(window as unknown as { __pcClient?: ProtocolClient }).__pcClient = client

    // `status` needs no prior `init` call (see host.ts's own status(): it degrades to
    // `{serverUp: false}` before init rather than throwing) -- so it doubles here as a
    // zero-side-effect round-trip proving the transport itself works end to end, without
    // requiring a workspace or server URL yet.
    client
      .call('status', {})
      .then((result) => {
        setStatusText(result.serverUp ? `server up (${result.model ?? 'unknown model'})` : 'server unreachable')
      })
      .catch((e: unknown) => {
        setStatusText(`round-trip failed: ${e instanceof Error ? e.message : String(e)}`)
      })

    return () => {
      unsubState()
      client.close()
    }
  }, [])

  return (
    <div class="shell">
      <header class="shell-header">
        <h1>PrivateCode</h1>
        <span class={`conn-dot conn-${state}`} title={state} />
        <span class="conn-label">{state}</span>
        <span class="status-text">{statusText}</span>
      </header>
      <div class="shell-body">
        <section class="panel panel-tree" aria-label="file tree">
          <div class="panel-placeholder">file tree (Task 7)</div>
        </section>
        <section class="panel panel-chat" aria-label="chat">
          <div class="panel-placeholder">chat (Task 5-6)</div>
        </section>
        <section class="panel panel-diffs" aria-label="diffs">
          <div class="panel-placeholder">diffs (Task 7)</div>
        </section>
      </div>
      <footer class="shell-status" aria-label="status bar">
        <div class="panel-placeholder">status bar (Task 8)</div>
      </footer>
    </div>
  )
}

export default App
