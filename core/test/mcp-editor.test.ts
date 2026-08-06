import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { SessionHost } from '../src/host/host.js'
import { isHostEvent, type HostOutbound, type HostReply } from '../src/host/protocol.js'
import { PRIVATE_DIR } from '../src/private-dir.js'
import { projectSettingsPath } from '../src/permissions/settings.js'
import { startFakeServer } from './fake-server.js'

/**
 * Editing MCP servers from the window.
 *
 * The MCP status block was read-only and hidden entirely when no servers were configured —
 * so for anyone who had not already hand-written the JSON, the feature did not visibly
 * exist. The editor writes the PROJECT settings file's `mcpServers` key, and the property
 * these tests defend is the merge: a hand-tuned entry (env, headers, cwd, trust flags) must
 * survive being edited in a form that never saw those fields.
 */

let stop: (() => Promise<void>) | undefined
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-mcped-'))
  mkdirSync(join(root, PRIVATE_DIR), { recursive: true })
})
afterEach(async () => {
  await stop?.()
  stop = undefined
  rmSync(root, { recursive: true, force: true })
})

interface Captured { messages: HostOutbound[]; send(m: HostOutbound): void }
const replyOf = (t: Captured, id: number): any => {
  const found = t.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
  if (found && 'error' in found) throw new Error(`request ${id} failed: ${found.error.message}`)
  return found?.result
}
const errorOf = (t: Captured, id: number): string | undefined => {
  const found = t.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
  return found && 'error' in found ? found.error.message : undefined
}

async function host(): Promise<{ host: SessionHost; transport: Captured }> {
  const fake = await startFakeServer((_b, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    return { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }
  })
  stop = fake.close
  const messages: HostOutbound[] = []
  const transport: Captured = { messages, send: (m) => { messages.push(m) } }
  const h = new SessionHost({ transport })
  await h.handle({ id: 1, method: 'init', params: { workspaceRoot: root, serverUrl: fake.url } })
  return { host: h, transport }
}

describe('mcp.save', () => {
  test('an upsert keeps every field the form does not model', () => {
    // The hand-written entry carries env and a trust flag. Renaming its command through the
    // editor must not cost either — the same discipline editRules applies to permissions.
    return host().then(async ({ host: h, transport }) => {
      writeFileSync(projectSettingsPath(root), JSON.stringify({
        verify: 'npm test',
        mcpServers: {
          docs: {
            command: 'node', args: ['old.js'],
            env: { DOCS_TOKEN: 'secret' }, trustReadOnlyHints: true,
          },
        },
      }, null, 2), 'utf8')
      await h.handle({
        id: 2, method: 'mcp.save',
        params: { upsert: [{ name: 'docs', command: 'node', args: ['new.js'] }] },
      })
      expect(replyOf(transport, 2)).toEqual({})

      const doc = JSON.parse(readFileSync(projectSettingsPath(root), 'utf8'))
      expect(doc.mcpServers.docs).toEqual({
        command: 'node', args: ['new.js'],
        env: { DOCS_TOKEN: 'secret' }, trustReadOnlyHints: true,
      })
      // And the rest of the file is untouched.
      expect(doc.verify).toBe('npm test')
      await h.shutdown()
    })
  })

  test('switching a server from command to url drops the stdio fields, keeps the rest', async () => {
    const { host: h } = await host()
    writeFileSync(projectSettingsPath(root), JSON.stringify({
      mcpServers: { search: { command: 'node', args: ['s.js'], trustReadOnlyHints: true } },
    }), 'utf8')
    await h.handle({
      id: 2, method: 'mcp.save',
      params: { upsert: [{ name: 'search', url: 'https://mcp.example.com/sse' }] },
    })
    const doc = JSON.parse(readFileSync(projectSettingsPath(root), 'utf8'))
    expect(doc.mcpServers.search).toEqual({ url: 'https://mcp.example.com/sse', trustReadOnlyHints: true })
    await h.shutdown()
  })

  test('remove deletes only the named entry', async () => {
    // Written AFTER init: init CONNECTS configured servers, and a bare `node` is a REPL
    // that hangs the handshake. mcp.save reads the disk fresh, so the order is free.
    const { host: h } = await host()
    writeFileSync(projectSettingsPath(root), JSON.stringify({
      mcpServers: { a: { command: 'node' }, b: { url: 'https://x.example/sse' } },
    }), 'utf8')
    await h.handle({ id: 2, method: 'mcp.save', params: { remove: ['a'] } })
    const doc = JSON.parse(readFileSync(projectSettingsPath(root), 'utf8'))
    expect(Object.keys(doc.mcpServers)).toEqual(['b'])
    await h.shutdown()
  })

  test('a server with both command and url, or neither, is refused before the file changes', async () => {
    const { host: h, transport } = await host()
    await h.handle({
      id: 2, method: 'mcp.save',
      params: { upsert: [{ name: 'x', command: 'node', url: 'https://x.example/sse' }] },
    })
    expect(errorOf(transport, 2)).toMatch(/not both/)
    await h.handle({ id: 3, method: 'mcp.save', params: { upsert: [{ name: 'y' }] } })
    expect(errorOf(transport, 3)).toMatch(/neither/)
    await h.shutdown()
  })

  test('mcp.read reports what the editor will edit, with its source', async () => {
    const { host: h, transport } = await host()
    writeFileSync(projectSettingsPath(root), JSON.stringify({
      mcpServers: { docs: { command: 'node', args: ['d.js'] } },
    }), 'utf8')
    await h.handle({ id: 2, method: 'mcp.read', params: {} })
    const { servers } = replyOf(transport, 2)
    expect(servers).toEqual([
      { name: 'docs', kind: 'stdio', command: 'node', args: ['d.js'], source: 'project settings' },
    ])
    await h.shutdown()
  })

  test('permissions.add writes the file and refuses a malformed rule without writing', async () => {
    const { host: h, transport } = await host()
    await h.handle({
      id: 2, method: 'permissions.add',
      params: { scope: 'project', list: 'deny', rule: 'run_command(npm publish:*)' },
    })
    expect(replyOf(transport, 2)).toEqual({ problem: null })
    const doc = JSON.parse(readFileSync(projectSettingsPath(root), 'utf8'))
    expect(doc.permissions.deny).toEqual(['run_command(npm publish:*)'])

    await h.handle({
      id: 3, method: 'permissions.add',
      params: { scope: 'project', list: 'deny', rule: '!!bad!!' },
    })
    expect(replyOf(transport, 3).problem).toMatch(/not a valid rule/)
    const after = JSON.parse(readFileSync(projectSettingsPath(root), 'utf8'))
    expect(after.permissions.deny).toEqual(['run_command(npm publish:*)'])
    await h.shutdown()
  })
})
