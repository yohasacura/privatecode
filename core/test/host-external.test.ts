import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { SessionHost } from '../src/host/host.js'
import { isHostEvent, type HostEvent, type HostOutbound, type HostReply, type StatusResult } from '../src/host/protocol.js'
import { startFakeServer } from './fake-server.js'

/**
 * The host's ownership of the two external things: MCP servers and the browser.
 *
 * The property under test throughout is LIFETIME. Both belong to the workspace, not to the
 * session — restarting a set of server processes because someone clicked Resume would be
 * slow, visible, and would drop whatever those servers were holding — and both must be gone
 * when the host shuts down, because an orphaned server process or Edge window outliving the
 * app is exactly the defect the polish review already caught once as an orphaned dev server.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))

let stop: (() => Promise<void>) | undefined
let root: string
let appData: string
let savedAppData: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-host-ext-'))
  appData = mkdtempSync(join(tmpdir(), 'pc-host-ext-appdata-'))
  savedAppData = process.env['APPDATA']
  process.env['APPDATA'] = appData
  mkdirSync(join(root, '.privatecode'), { recursive: true })
})

afterEach(async () => {
  await stop?.()
  stop = undefined
  if (savedAppData === undefined) delete process.env['APPDATA']
  else process.env['APPDATA'] = savedAppData
  rmSync(root, { recursive: true, force: true })
  rmSync(appData, { recursive: true, force: true })
})

function settings(doc: unknown): void {
  writeFileSync(join(root, '.privatecode', 'settings.json'), JSON.stringify(doc), 'utf8')
}

function mcpServers(entries: Record<string, string[]>): void {
  settings({
    mcpServers: Object.fromEntries(Object.entries(entries).map(([name, flags]) => [
      name, { command: process.execPath, args: [FIXTURE, ...flags] },
    ])),
  })
}

interface Captured { messages: HostOutbound[]; send(m: HostOutbound): void }

function makeTransport(): Captured {
  const messages: HostOutbound[] = []
  return { messages, send: (m) => { messages.push(m) } }
}

const problems = (t: Captured): string[] =>
  t.messages.filter(isHostEvent)
    .filter((e: HostEvent) => e.event === 'settings.problem')
    .map((e) => (e.data as { text: string }).text)

const replyOf = (t: Captured, id: number): any => {
  const found = t.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
  // A reply is either a result or an error; a test asking for the result of a request that
  // errored should say so rather than read `undefined` and assert something vacuous.
  if (found && 'error' in found) throw new Error(`request ${id} failed: ${found.error.message}`)
  return found?.result
}

async function newHost(): Promise<{ host: SessionHost; transport: Captured }> {
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    return {}
  })
  stop = fake.close
  const transport = makeTransport()
  const host = new SessionHost({ transport })
  await host.handle({ id: 1, method: 'init', params: { workspaceRoot: root, serverUrl: fake.url } })
  return { host, transport }
}

test('a configured MCP server contributes tools and shows up in status', async () => {
  mcpServers({ notes: [] })
  const { host, transport } = await newHost()
  try {
    await host.handle({ id: 2, method: 'status', params: {} })
    const status = replyOf(transport, 2) as StatusResult
    expect(status.mcpServers).toEqual([{ name: 'notes', state: 'connected', toolCount: 3 }])
    // Nothing is open yet, and constructing the manager must not have started anything.
    expect(status.browser).toEqual({ running: false })
  } finally {
    await host.shutdown()
  }
})

test('a server that fails to start is a problem, not a broken session', async () => {
  mcpServers({ broken: ['--crash'], fine: [] })
  const { host, transport } = await newHost()
  try {
    // The session initialised; the user can work.
    expect(replyOf(transport, 1).sessionId).toBeTruthy()
    expect(problems(transport).join(' ')).toContain('MCP_TOKEN is not set')
    await host.handle({ id: 2, method: 'status', params: {} })
    const states = Object.fromEntries(
      ((replyOf(transport, 2) as StatusResult).mcpServers ?? []).map((s) => [s.name, s.state]))
    expect(states).toEqual({ broken: 'failed', fine: 'connected' })
  } finally {
    await host.shutdown()
  }
})

test('switching sessions does not restart the servers, and keeps reporting their problems',
  async () => {
    mcpServers({ broken: ['--crash'] })
    const { host, transport } = await newHost()
    try {
      const before = problems(transport).length
      await host.handle({ id: 2, method: 'sessions.new', params: {} })
      // The notice is repeated for the new session rather than lost: a user who switches
      // sessions must not silently stop being told a server failed.
      expect(problems(transport).length).toBeGreaterThan(before)
      // And the working ones were not torn down and rebuilt.
      await host.handle({ id: 3, method: 'status', params: {} })
      expect((replyOf(transport, 3) as StatusResult).mcpServers).toHaveLength(1)
    } finally {
      await host.shutdown()
    }
  })

test('a second init tears the old workspace\'s servers down', async () => {
  mcpServers({ first: [] })
  const { host, transport } = await newHost()
  try {
    const other = mkdtempSync(join(tmpdir(), 'pc-host-ext-2-'))
    try {
      const fake = await startFakeServer((_body, req) => {
        if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
        if (req.url === '/health') return { status: 'ok' }
        return {}
      })
      try {
        await host.handle({ id: 9, method: 'init', params: { workspaceRoot: other, serverUrl: fake.url } })
        await host.handle({ id: 10, method: 'status', params: {} })
        // The new workspace configures nothing, so the old workspace's server must be gone
        // rather than lingering under a workspace that never asked for it. Absent, not an
        // empty list: "none configured" and "all of them failed" are different facts.
        expect((replyOf(transport, 10) as StatusResult).mcpServers).toBeUndefined()
      } finally {
        await fake.close()
      }
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  } finally {
    await host.shutdown()
  }
})

test('shutdown is idempotent and survives a manager that throws', async () => {
  mcpServers({ notes: [] })
  const { host } = await newHost()
  // Teardown runs on paths that are already failing; one manager throwing must not leave
  // the others running.
  ;(host as unknown as { mcp: { closeAll(): Promise<void> } }).mcp = {
    closeAll: () => Promise.reject(new Error('nope')),
  }
  await expect(host.shutdown()).resolves.toBeUndefined()
  await expect(host.shutdown()).resolves.toBeUndefined()
})

test('with nothing configured, status says so instead of failing', async () => {
  const { host, transport } = await newHost()
  try {
    await host.handle({ id: 2, method: 'status', params: {} })
    const status = replyOf(transport, 2) as StatusResult
    // No servers configured means no manager at all, which is absent, not an empty list —
    // the app can tell "none configured" from "all of them failed".
    expect(status.mcpServers).toBeUndefined()
    // One notice, and it is about the absent verify command rather than about MCP: a
    // workspace with no servers is ordinary and says nothing, while a workspace with no
    // check has a feature silently switched off and now says so.
    expect(problems(transport).filter((p) => !p.includes('No check is configured'))).toEqual([])
  } finally {
    await host.shutdown()
  }
})

test('browser settings are read from the same files, and bad values are reported', async () => {
  settings({ browser: { headless: 'yes please' } })
  const { host, transport } = await newHost()
  try {
    expect(problems(transport).join(' ')).toContain('browser.headless')
  } finally {
    await host.shutdown()
  }
})
