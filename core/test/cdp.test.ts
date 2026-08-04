import { afterEach, describe, expect, test } from 'vitest'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import { CdpConnection } from '../src/browser/cdp.js'

/**
 * The CDP client, driven against a real WebSocket server.
 *
 * `ws` is already a devDependency (the dev bridge uses it), so a real server costs nothing
 * and tests the thing that actually matters: the client talks to a socket, not to a mock of
 * one. The browser itself is out of scope here — see `browser-live.integration.test.ts`.
 */

interface Harness {
  url: string
  server: WebSocketServer
  /** Every frame the client sent, parsed. */
  received: any[]
  /** Replaced per test to script the server's answers. */
  onFrame: (frame: any, socket: WsSocket) => void
  sockets: WsSocket[]
}

const harnesses: Harness[] = []

async function serve(): Promise<Harness> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const h: Harness = {
    url: `ws://127.0.0.1:${port}/devtools/browser/test`,
    server,
    received: [],
    onFrame: () => {},
    sockets: [],
  }
  server.on('connection', (socket) => {
    h.sockets.push(socket)
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data))
      h.received.push(frame)
      h.onFrame(frame, socket)
    })
  })
  harnesses.push(h)
  return h
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    for (const s of h.sockets) s.terminate()
    await new Promise<void>((resolve) => h.server.close(() => resolve()))
  }
})

describe('CdpConnection', () => {
  test('pairs an answer with its request and returns the result', async () => {
    const h = await serve()
    h.onFrame = (frame, socket) => {
      socket.send(JSON.stringify({ id: frame.id, result: { targetId: 'T1', echo: frame.method } }))
    }
    const conn = await CdpConnection.connect(h.url)
    const result = await conn.send('Target.createTarget', { url: 'about:blank' })
    expect(result).toEqual({ targetId: 'T1', echo: 'Target.createTarget' })
    expect(h.received[0]).toMatchObject({ method: 'Target.createTarget', params: { url: 'about:blank' } })
    conn.close()
  })

  test('answers arriving out of order still reach the right caller', async () => {
    const h = await serve()
    const held: any[] = []
    h.onFrame = (frame, socket) => {
      held.push(frame)
      if (held.length < 2) return
      // Answer the SECOND call first. Without id-keyed pairing this is the bug that shows
      // up as one tool call receiving another's result.
      for (const f of [held[1], held[0]]) {
        socket.send(JSON.stringify({ id: f.id, result: { for: f.method } }))
      }
    }
    const conn = await CdpConnection.connect(h.url)
    const [a, b] = await Promise.all([conn.send('First'), conn.send('Second')])
    expect(a).toEqual({ for: 'First' })
    expect(b).toEqual({ for: 'Second' })
    conn.close()
  })

  test('threads sessionId in both directions', async () => {
    const h = await serve()
    h.onFrame = (frame, socket) => {
      socket.send(JSON.stringify({ id: frame.id, sessionId: frame.sessionId, result: {} }))
      socket.send(JSON.stringify({ method: 'Page.loadEventFired', params: {}, sessionId: 'S9' }))
      socket.send(JSON.stringify({ method: 'Page.loadEventFired', params: {}, sessionId: 'OTHER' }))
    }
    const conn = await CdpConnection.connect(h.url)
    const seen: (string | undefined)[] = []
    conn.on('Page.loadEventFired', (_p, sessionId) => { seen.push(sessionId) })
    await conn.send('Page.navigate', { url: 'x' }, 'S9')
    expect(h.received[0]?.sessionId).toBe('S9')
    await new Promise((r) => setTimeout(r, 20))
    // Both are delivered; filtering by session is the Page's job, and it has to be able to.
    expect(seen).toEqual(['S9', 'OTHER'])
    conn.close()
  })

  test('a protocol error rejects with the browser\'s own message', async () => {
    const h = await serve()
    h.onFrame = (frame, socket) => {
      socket.send(JSON.stringify({ id: frame.id, error: { code: -32000, message: 'No node found' } }))
    }
    const conn = await CdpConnection.connect(h.url)
    await expect(conn.send('DOM.focus')).rejects.toThrow(/DOM\.focus: No node found/)
    conn.close()
  })

  test('a call that is never answered rejects on its own timeout', async () => {
    const h = await serve()
    h.onFrame = () => { /* silence */ }
    const conn = await CdpConnection.connect(h.url)
    await expect(conn.send('Page.navigate', {}, undefined, 60)).rejects.toThrow(/did not answer/)
    conn.close()
  })

  test('a socket that closes rejects everything still outstanding', async () => {
    const h = await serve()
    h.onFrame = (_frame, socket) => { socket.close() }
    const conn = await CdpConnection.connect(h.url)
    // The alternative is a tool call awaiting a browser that is gone, forever.
    await expect(conn.send('Page.navigate')).rejects.toThrow(/connection closed|connection failed/)
    conn.close()
  })

  test('closing locally resolves `closed` without inventing an error', async () => {
    const h = await serve()
    const conn = await CdpConnection.connect(h.url)
    conn.close()
    expect(await conn.closed).toBeNull()
  })

  test('an unsubscribed listener stops receiving, and one listener\'s throw is contained', async () => {
    const h = await serve()
    h.onFrame = (frame, socket) => {
      socket.send(JSON.stringify({ id: frame.id, result: {} }))
      socket.send(JSON.stringify({ method: 'Log.entryAdded', params: { n: 1 } }))
    }
    const conn = await CdpConnection.connect(h.url)
    const seen: number[] = []
    conn.on('Log.entryAdded', () => { throw new Error('listener blew up') })
    const off = conn.on('Log.entryAdded', (p) => { seen.push(p.n) })
    await conn.send('ping')
    await new Promise((r) => setTimeout(r, 20))
    off()
    await conn.send('ping')
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual([1])
    conn.close()
  })

  test('connecting to nothing rejects rather than hanging', async () => {
    await expect(CdpConnection.connect('ws://127.0.0.1:1/devtools/browser/x', { timeoutMs: 2_000 }))
      .rejects.toThrow()
  })
})
