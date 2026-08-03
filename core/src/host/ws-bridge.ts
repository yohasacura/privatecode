import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'
import { WebSocketServer, type WebSocket } from 'ws'
import { SessionHost, type HostTransport } from './host.js'
import { encodeLine, LineDecoder, type HostOutbound, type HostRequest } from './protocol.js'

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
    const decoder = new LineDecoder()
    const transport: HostTransport = {
      send(msg: HostOutbound): void {
        if (ws.readyState === ws.OPEN) ws.send(encodeLine(msg))
      },
    }
    const host = new SessionHost({ transport })

    ws.on('message', (data, isBinary) => {
      const text = isBinary ? data.toString('utf8') : data.toString()
      let messages: unknown[]
      try {
        messages = decoder.push(text)
      } catch (e) {
        process.stderr.write(`ws-bridge: ${e instanceof Error ? e.message : String(e)}\n`)
        ws.close(1011, 'malformed frame')
        return
      }
      for (const msg of messages) {
        if (!isHostRequest(msg)) {
          process.stderr.write(`ws-bridge: ignoring a message that is not a request: ${JSON.stringify(msg)}\n`)
          continue
        }
        void host.handle(msg)
      }
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
