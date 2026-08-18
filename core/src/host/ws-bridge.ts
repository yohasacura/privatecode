import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'
import { WebSocketServer, type WebSocket } from 'ws'
import { SessionHost, type HostTransport } from './host.js'
import { encodeLine, type HostOutbound, type HostRequest } from './protocol.js'

/**
 * DEV-ONLY WebSocket wrapper around `SessionHost`, exposing the exact same ndjson
 * protocol as `stdio-main.ts` -- one JSON envelope per text WebSocket message -- so a
 * plain browser (or a scripted ws client, for headless verification) can drive a real
 * `SessionHost` the same way the Tauri shell's stdio relay will. This file is never
 * reachable from the bundled sidecar: `scripts/bundle.mjs` gives esbuild only
 * `stdio-main.ts` as an entry point, which never imports this module, and the bundle's
 * own manifest check greps the built `agent.cjs` for "ws-bridge" to prove it stayed out.
 *
 * `NODE_ENV=production` throws immediately, as a second, independent guard against this
 * ever running outside a developer's own machine -- belt-and-suspenders with the "never
 * imported by the bundle" property above, not a substitute for it.
 *
 * Security posture (Global Constraint 7): binds `127.0.0.1` only (never `0.0.0.0`), and
 * every connection must present a random per-run token as `?token=` in the query string
 * or the upgrade is refused with 401 -- there is no other authentication, which is fine
 * precisely because nothing outside this machine can reach a loopback-only listener.
 * One client at a time: a second connection attempt while one is already active is
 * refused with 409, and the active `SessionHost` is torn down (`shutdown()`) the moment
 * its one client disconnects, exactly like a sidecar process exiting.
 */

if (process.env.NODE_ENV === 'production') {
  throw new Error('ws-bridge.ts is dev-only and must never run with NODE_ENV=production')
}

function isHostRequest(value: unknown): value is HostRequest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v['id'] === 'number' && typeof v['method'] === 'string'
}

const USAGE = 'usage: npm run host:dev -- --workspace <dir> [--port 0]'

async function main(): Promise<void> {
  let values: { workspace?: string; port?: string }
  try {
    ;({ values } = parseArgs({
      options: {
        workspace: { type: 'string' },
        port: { type: 'string', default: '0' },
      },
    }))
  } catch (e) {
    process.stderr.write(`ws-bridge: ${e instanceof Error ? e.message : String(e)}\n\n${USAGE}\n`)
    process.exitCode = 2
    return
  }

  // --workspace is accepted, validated, and printed at startup for the same reason
  // stdio-main.ts's own --workspace flag exists: command-line symmetry, and a fast,
  // legible failure for a typo'd directory. It is NOT used to synthesize an `init` call
  // on the client's behalf -- this bridge speaks the SAME protocol stdio-main.ts does,
  // and in that protocol `init` (workspaceRoot + serverUrl together) is something only
  // the connecting client sends. Auto-initializing here would special-case the
  // WebSocket transport with a capability the stdio transport does not have.
  if (values.workspace !== undefined) {
    if (!existsSync(values.workspace) || !statSync(values.workspace).isDirectory()) {
      process.stderr.write(`ws-bridge: workspace directory not found: ${values.workspace}\n`)
      process.exitCode = 2
      return
    }
  }

  const port = Number(values.port ?? '0')
  const token = randomBytes(16).toString('hex')

  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })

  /** At most one live SessionHost/connection at a time -- see the class-level doc comment. */
  let activeClient: WebSocket | undefined

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (activeClient !== undefined) {
      socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    activeClient = ws
    const transport: HostTransport = {
      send(msg: HostOutbound): void {
        if (ws.readyState === ws.OPEN) ws.send(encodeLine(msg))
      },
    }
    const host = new SessionHost({ transport })

    // NOT routed through `LineDecoder`, deliberately, unlike stdio-main.ts: a WebSocket
    // message already IS one complete application-level frame -- the `ws` library never
    // splits one `ws.send()` call across multiple 'message' events, or coalesces several
    // into one, the way a raw stdio byte stream can split or merge arbitrarily mid-line.
    // `LineDecoder` exists specifically to reassemble THAT kind of stream and requires a
    // trailing '\n' terminator to ever emit anything; the frontend's `WsTransport.send()`
    // (app/src/lib/client.ts) sends a bare `JSON.stringify(request)` with no trailing
    // newline at all (only the Tauri-IPC path's Rust side appends one, for its own stdin
    // pipe). Reusing `LineDecoder` here silently swallowed every incoming request into its
    // internal buffer, waiting forever for a '\n' that would never arrive -- caught while
    // verifying Task 4's dev-bridge round trip (a `status` call hung indefinitely; the
    // request was provably received, by console log, but never dispatched to `host.handle`
    // at all). Parsing each message directly is not just a workaround: it is the correct
    // rule for this transport, matching the reasoning `client.ts`'s own header comment
    // already states for the other end of this exact connection.
    ws.on('message', (data, isBinary) => {
      const text = isBinary ? data.toString('utf8') : data.toString()
      let msg: unknown
      try {
        msg = JSON.parse(text)
      } catch (e) {
        process.stderr.write(`ws-bridge: malformed JSON message (${e instanceof Error ? e.message : String(e)}): ${text}\n`)
        ws.close(1011, 'malformed message')
        return
      }
      if (!isHostRequest(msg)) {
        process.stderr.write(`ws-bridge: ignoring a message that is not a request: ${JSON.stringify(msg)}\n`)
        return
      }
      // Timed, to stderr, per request: the dev stand's page dies easily (reloads, pane
      // hijacks), and when it does, this log is the only witness to whether a method the
      // page fired ever finished host-side — a `workspace.set → init` that "loads forever"
      // is diagnosed from exactly these lines.
      const started = Date.now()
      void host.handle(msg).then(
        () => process.stderr.write(`ws-bridge: ${msg.method} #${msg.id} done in ${Date.now() - started}ms\n`),
        (e) => process.stderr.write(`ws-bridge: ${msg.method} #${msg.id} FAILED in ${Date.now() - started}ms: ${e instanceof Error ? e.message : String(e)}\n`),
      )
    })

    ws.on('close', () => {
      activeClient = undefined
      void host.shutdown()
    })
  })

  server.listen(port, '127.0.0.1', () => {
    const addr = server.address()
    const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port
    const url = `ws://127.0.0.1:${actualPort}/?token=${token}`
    // Printed to stdout, deliberately: this is the one piece of output a driver script
    // (or a developer's browser devtools) needs to connect.
    console.log(`ws-bridge: listening at ${url}`)
    if (values.workspace !== undefined) console.log(`ws-bridge: --workspace ${values.workspace}`)
  })

  // process.exitCode discipline applies here too, dev-only script or not (the libuv
  // lesson cli.ts's own comment records is about process.exit() specifically, not about
  // stdio-main.ts alone): closing the server and every open socket lets the event loop
  // drain and the process exit on its own, with no forced process.exit() call anywhere.
  function shutdown(): void {
    for (const client of wss.clients) client.close(1001, 'ws-bridge shutting down')
    wss.close()
    server.close()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
  process.exitCode = 1
})
