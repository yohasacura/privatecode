import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vitest'
import { SessionHost } from '../src/host/host.js'
import { isHostEvent, type HostOutbound, type HostReply, type ServerProbeResult } from '../src/host/protocol.js'
import { startFakeServer } from './fake-server.js'

/**
 * `server.probe`: the welcome screen's question, asked before `init`, answered in the words
 * a person can act on. Each way a server can be wrong gets its own sentence, and none of
 * them is an error — an unreachable server is an ordinary answer here.
 */

let stop: (() => Promise<void>) | undefined
afterEach(async () => { await stop?.(); stop = undefined })

async function probe(serverUrl: string): Promise<ServerProbeResult> {
  const messages: HostOutbound[] = []
  const host = new SessionHost({ transport: { send: (m) => { messages.push(m) } } })
  try {
    await host.handle({ id: 1, method: 'server.probe', params: { serverUrl } })
  } finally {
    await host.shutdown()
  }
  const reply = messages.find((m): m is HostReply => !isHostEvent(m) && m.id === 1)
  if (reply === undefined || 'error' in reply) throw new Error(`no reply: ${JSON.stringify(reply)}`)
  return reply.result as ServerProbeResult
}

test('a llama.cpp server is reachable, with what it serves', async () => {
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 196_608 }, model_path: '/models/KAT-Coder-V2.5-Dev.gguf' }
    return {}
  })
  stop = fake.close
  const r = await probe(fake.url)
  expect(r).toEqual({ reachable: true, model: 'KAT-Coder-V2.5-Dev', contextLength: 196_608 })
})

test('nothing listening is said as such, with the address', async () => {
  // A port that was open a moment ago and is closed now.
  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((r) => server.close(() => r()))
  const r = await probe(`http://127.0.0.1:${port}`)
  expect(r.reachable).toBe(false)
  expect(r.reason).toBe(`nothing is listening at 127.0.0.1:${port}`)
})

test('a web server that is not llama.cpp is told apart from one that is down', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<html>not found</html>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  stop = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) })
  const r = await probe(`http://127.0.0.1:${port}`)
  expect(r.reachable).toBe(false)
  expect(r.reason).toContain('not a llama.cpp server')
})

test('a server with no model loaded is reachable but not usable, and a non-URL is refused in words', async () => {
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    return {}
  })
  stop = fake.close
  const r = await probe(fake.url)
  expect(r.reachable).toBe(false)
  expect(r.reason).toContain('no model loaded')
  const bad = await probe('localhost:8080 please')
  expect(bad.reachable).toBe(false)
  expect(bad.reason).toContain('not a URL')
})
