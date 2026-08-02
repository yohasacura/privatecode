import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeHandler = (body: any, req: IncomingMessage) => unknown | Promise<unknown>

/**
 * Minimal stand-in for llama-server. Returns whatever the handler returns, as JSON.
 *
 * The handler may return a promise, which is awaited: a promise that never settles is
 * how a server that accepts the connection and then goes silent is simulated (the
 * per-step deadline and mid-call abort both need exactly that). `close()` therefore
 * destroys open sockets, otherwise a hung request would keep the server alive forever.
 */
export async function startFakeServer(handler: FakeHandler) {
  const requests: any[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      const body = raw ? JSON.parse(raw) : {}
      requests.push({ url: req.url, body })
      void (async () => {
        let out: unknown
        try {
          out = await handler(body, req)
        } catch (e) {
          if (res.writableEnded) return
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: String(e) }))
          return
        }
        if (res.writableEnded) return
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out))
      })()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections()
      server.close(() => r())
    }),
  }
}
