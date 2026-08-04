import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { McpClient } from '../src/mcp/client.js'
import type { StdioServerSpec } from '../src/mcp/transport.js'

/**
 * The MCP client, against a real server process and a real HTTP endpoint.
 *
 * `test/fixtures/mcp-server.mjs` is a genuine stdio MCP server whose behaviour is steered
 * by argv, so the awkward cases — a crash on startup, a server that never answers, a
 * server-initiated request — are exercised as they actually happen rather than simulated
 * through a mock transport that would only prove the mock works.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))

const open: { close(): Promise<void> }[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => {})
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
})

async function stdio(...flags: string[]): Promise<McpClient> {
  const spec: StdioServerSpec = { kind: 'stdio', command: process.execPath, args: [FIXTURE, ...flags] }
  // Short timeouts so proving the timeout works costs a second rather than twenty. The
  // option is not a test hatch: a slow server is a real thing a user may need to configure
  // around, the same way `LlamaClient` takes a `requestTimeoutMs`.
  const client = await McpClient.connect(spec, { name: 'fixture', timeouts: { listMs: 1_000 } })
  open.push(client)
  return client
}

describe('stdio', () => {
  test('initialises, lists tools, and keeps their schemas', async () => {
    const client = await stdio()
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['echo', 'read_note', 'boom'])
    // The schema is passed to llama.cpp verbatim to build the constraint grammar, so it
    // must survive the trip unchanged.
    expect(tools[0]?.inputSchema).toEqual({
      type: 'object', properties: { text: { type: 'string' } }, required: ['text'],
    })
    expect(tools[1]?.annotations?.readOnlyHint).toBe(true)
  })

  test('follows nextCursor to the end', async () => {
    const client = await stdio('--paged')
    expect((await client.listTools()).map((t) => t.name)).toEqual(['echo', 'read_note', 'boom'])
  })

  test('flattens mixed content, and says what it could not read', async () => {
    const client = await stdio()
    const result = await client.callTool('echo', { text: 'hi' })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('echo: hi')
    // Named, not dropped: otherwise the model concludes nothing came back and calls again.
    expect(result.text).toContain('this model cannot read images')
    expect(result.text).toContain('inline resource text')
  })

  test('structuredContent comes through when there are no content blocks', async () => {
    const client = await stdio()
    const result = await client.callTool('read_note', {})
    expect(result.text).toContain('"note": "structured"')
  })

  test('isError is a failed tool call, not a thrown exception', async () => {
    // The model has to be able to read what went wrong and adjust, exactly as it does for
    // a non-zero exit code.
    const client = await stdio()
    const result = await client.callTool('boom', {})
    expect(result.ok).toBe(false)
    expect(result.text).toContain('the database is on fire')
  })

  test('a protocol error rejects with the server\'s message', async () => {
    const client = await stdio()
    await expect(client.callTool('nope', {})).rejects.toThrow(/unknown tool nope/)
  })

  test('a server that crashes on startup reports its own stderr', async () => {
    // The single most common real failure. Without the stderr the user gets "the connection
    // closed" and no way to know a token was missing.
    const spec: StdioServerSpec = { kind: 'stdio', command: process.execPath, args: [FIXTURE, '--crash'] }
    await expect(McpClient.connect(spec, { name: 'broken' }))
      .rejects.toThrow(/MCP_TOKEN is not set/)
  })

  test('a command that does not exist fails with the name in it', async () => {
    const spec: StdioServerSpec = { kind: 'stdio', command: 'definitely-not-a-real-binary-xyz' }
    await expect(McpClient.connect(spec, { name: 'ghost' })).rejects.toThrow(/ghost/)
  })

  test('a server that stops answering times out rather than hanging', async () => {
    const client = await stdio('--silent')
    await expect(client.listTools()).rejects.toThrow(/did not answer/)
  })

  test('a server-initiated request is answered, not ignored', async () => {
    // A server blocked waiting for a reply is a hang inside our own tool call.
    const client = await stdio('--ask')
    // If the fixture's request had gone unanswered the client would still work, so the
    // proof is that everything after it keeps working and nothing is left pending.
    expect((await client.listTools()).length).toBe(3)
    const result = await client.callTool('echo', { text: 'still here' })
    expect(result.text).toContain('still here')
  })

  test('an aborted turn cancels a call in flight', async () => {
    const client = await stdio('--slow-call')
    const controller = new AbortController()
    const call = client.callTool('echo', {}, controller.signal)
    setTimeout(() => controller.abort(), 50)
    await expect(call).rejects.toThrow(/cancelled/)
  })

  test('closing rejects everything still outstanding', async () => {
    const client = await stdio('--slow-call')
    // The assertion is attached BEFORE the close that rejects it: otherwise the rejection
    // lands in a microtask with no handler and Node reports an unhandled rejection, which
    // vitest surfaces as an error even though the test passes.
    const settled = expect(client.callTool('echo', {})).rejects.toThrow(/closed/)
    await client.close()
    await settled
  })

  test('closing leaves no server process behind', async () => {
    // `shell: true` is required on Windows for npx/uvx `.cmd` shims, which means the direct
    // child is cmd.exe and `child.kill()` kills the shim while the server keeps running with
    // our pipes open. Measured before the tree kill: still alive five seconds later.
    const client = await stdio('--slow-call')
    const started = Date.now()
    await client.close()
    expect(Date.now() - started).toBeLessThan(4_000)
  })
})

describe('streamable http', () => {
  interface HttpFixture { url: string; sessionIds: string[]; sse: boolean }

  async function serve(sse: boolean): Promise<HttpFixture> {
    const fixture: HttpFixture = { url: '', sessionIds: [], sse }
    const server = createServer((req, res) => {
      if (req.method === 'DELETE') { res.writeHead(200).end(); return }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const message = JSON.parse(body)
        const sid = req.headers['mcp-session-id']
        if (typeof sid === 'string') fixture.sessionIds.push(sid)

        if (message.method === 'notifications/initialized') {
          res.writeHead(202).end()
          return
        }
        const result = message.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'http-fixture' } }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] }
            : { content: [{ type: 'text', text: `pong ${req.headers['authorization'] ?? 'anon'}` }] }
        const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })

        if (sse) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          // Deliberately split across two writes with the blank-line separator last: a
          // frame that arrives in pieces is the normal case on a real network.
          res.write(`event: message\ndata: ${payload}`)
          setTimeout(() => res.end('\n\n'), 10)
          return
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          ...(message.method === 'initialize' ? { 'mcp-session-id': 'SESSION-42' } : {}),
        })
        res.end(payload)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    servers.push(server)
    const address = server.address()
    fixture.url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/mcp`
    return fixture
  }

  test('talks JSON, carries the session id, and sends configured headers', async () => {
    const fixture = await serve(false)
    const client = await McpClient.connect(
      { kind: 'http', url: fixture.url, headers: { authorization: 'Bearer T0KEN' } },
      { name: 'remote' },
    )
    open.push(client)
    expect((await client.listTools()).map((t) => t.name)).toEqual(['ping'])
    const result = await client.callTool('ping', {})
    expect(result.text).toBe('pong Bearer T0KEN')
    // The id the server handed out on initialize comes back on every later request.
    expect(fixture.sessionIds).toContain('SESSION-42')
  })

  test('reads an answer delivered as an event stream', async () => {
    const fixture = await serve(true)
    const client = await McpClient.connect({ kind: 'http', url: fixture.url }, { name: 'remote' })
    open.push(client)
    expect((await client.listTools()).map((t) => t.name)).toEqual(['ping'])
  })

  test('an auth failure names the headers it sent and never their values', async () => {
    const server = createServer((_req, res) => { res.writeHead(401, 'Unauthorized').end() })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    servers.push(server)
    const address = server.address()
    const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/mcp`

    const attempt = McpClient.connect(
      { kind: 'http', url, headers: { authorization: 'Bearer SUPERSECRET' } },
      { name: 'remote' },
    )
    await expect(attempt).rejects.toThrow(/401/)
    // The message ends up in a problem the UI displays; the token must not.
    await attempt.catch((e: Error) => {
      expect(e.message).toContain('authorization')
      expect(e.message).not.toContain('SUPERSECRET')
    })
  })

  test('an unreachable endpoint fails with the URL, not a bare fetch error', async () => {
    await expect(McpClient.connect({ kind: 'http', url: 'http://127.0.0.1:1/mcp' }, { name: 'dead' }))
      .rejects.toThrow(/127\.0\.0\.1:1/)
  })
})
