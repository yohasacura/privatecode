import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeHandler = (body: any, req: IncomingMessage) => unknown | Promise<unknown>

/**
 * A response written to the wire verbatim, instead of being JSON-encoded.
 *
 * Needed because the failure being pinned is a body that is *not* JSON arriving under a
 * 2xx status — which is what llama.cpp does when it answers `{"error": ...}` or an HTML
 * error page with 200, and which no JSON-encoding handler can produce.
 */
export class RawResponse {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly contentType = 'text/plain',
  ) {}
}

/**
 * Minimal stand-in for llama-server. Returns whatever the handler returns, as JSON, or
 * verbatim when the handler returns a RawResponse.
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
        if (out instanceof RawResponse) {
          res.writeHead(out.status, { 'content-type': out.contentType })
          res.end(out.body)
          return
        }
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
