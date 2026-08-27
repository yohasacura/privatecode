#!/usr/bin/env node
/**
 * A minimal MCP server over stdio, for testing the client against something real.
 *
 * Its behaviour is steered by argv so one fixture covers every case worth testing:
 *   (none)        a well-behaved server with three tools
 *   --paged       returns its tools across two pages, to exercise cursor following
 *   --crash       prints a stack trace to stderr and exits, the most common real failure
 *   --silent      accepts initialize and never answers, to exercise the timeout
 *   --ask         sends the client a request it does not serve, to prove it is answered
 *   --slow-call   takes 5 s to answer tools/call, to exercise cancellation
 *   --pid-file P  writes this process's pid to P, so a test can check it is really gone
 *   --survive     ignores stdin closing and holds a timer open, so only a real kill ends it
 */

const mode = process.argv.slice(2)
const has = (flag) => mode.includes(flag)

// Written before anything else can go wrong, so a test that asks whether this process
// survived a close has something to ask about.
const pidFileAt = mode.indexOf('--pid-file')
if (pidFileAt !== -1 && mode[pidFileAt + 1]) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(mode[pidFileAt + 1], String(process.pid), 'utf8')
}

if (has('--crash')) {
  process.stderr.write('Error: MCP_TOKEN is not set\n    at start (server.js:12:9)\n')
  process.exit(1)
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Returns what it is given.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'read_note',
    description: 'A read-only tool that says so.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'boom',
    description: 'Always fails.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

let buffer = ''
// A well-behaved server exits when its pipes close, which makes it useless for asking
// whether `close()` actually KILLS anything — the process would be gone either way.
// `--survive` is the badly-behaved one the tree kill exists for: it holds an interval
// open so nothing but a signal ends it.
if (has('--survive')) {
  setInterval(() => {}, 1_000)
  process.stdin.on('end', () => {})
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const nl = buffer.indexOf('\n')
    if (nl === -1) break
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line !== '') handle(JSON.parse(line))
  }
})

function handle(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '9.9.9' },
      },
    })
    if (has('--ask')) {
      // A server-initiated request for something this client does not implement.
      send({ jsonrpc: '2.0', id: 'srv-1', method: 'sampling/createMessage', params: {} })
    }
    return
  }
  if (method === 'notifications/initialized') return
  if (id === undefined) return // any other notification

  if (has('--silent')) return // accepted initialize, answers nothing else

  if (method === 'tools/list') {
    if (!has('--paged')) {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      return
    }
    if (params?.cursor === undefined) {
      send({ jsonrpc: '2.0', id, result: { tools: [TOOLS[0]], nextCursor: 'page2' } })
    } else {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS.slice(1) } })
    }
    return
  }

  if (method === 'tools/call') {
    const name = params?.name
    const answer = (result) => send({ jsonrpc: '2.0', id, result })
    if (has('--slow-call')) {
      setTimeout(() => answer({ content: [{ type: 'text', text: 'eventually' }] }), 5_000)
      return
    }
    if (name === 'boom') {
      answer({ content: [{ type: 'text', text: 'the database is on fire' }], isError: true })
      return
    }
    if (name === 'echo') {
      answer({
        content: [
          { type: 'text', text: `echo: ${params?.arguments?.text ?? ''}` },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'note://1', text: 'inline resource text' } },
        ],
      })
      return
    }
    if (name === 'read_note') {
      answer({ content: [], structuredContent: { note: 'structured' } })
      return
    }
    send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } })
    return
  }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } })
}
