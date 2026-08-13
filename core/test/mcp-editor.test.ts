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
 * Editing MCP servers from the window — the JSON document itself, VS Code's way.
 *
 * A name-plus-command form came first and was replaced at the user's request: it modelled a
 * subset, so env blocks, headers, cwd and trust flags all ended in "edit the file by hand
 * anyway". The property these tests defend moved with it. It is no longer the per-entry
 * merge (nothing is merged now — what you saved is what is there); it is that the editor
 * can express EVERYTHING the loader can read, and that a typo costs nothing: the text is
 * checked before the file is opened for writing, and every other key of the settings file
 * survives the write.
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

describe('mcp.rawRead', () => {
  test('gives back the mcpServers object verbatim, and the file it lives in', async () => {
    // Verbatim is the whole design: an env block and a trust flag are just text here, so
    // there is no field the screen "does not model" and therefore none it can lose.
    const { host: h, transport } = await host()
    writeFileSync(projectSettingsPath(root), JSON.stringify({
      verify: 'npm test',
      mcpServers: {
        docs: { command: 'node', args: ['d.js'], env: { DOCS_TOKEN: 'secret' }, trustReadOnlyHints: true },
      },
    }, null, 2), 'utf8')
    await h.handle({ id: 2, method: 'mcp.rawRead', params: {} })
    const { json, path } = replyOf(transport, 2)
    expect(JSON.parse(json)).toEqual({
      docs: { command: 'node', args: ['d.js'], env: { DOCS_TOKEN: 'secret' }, trustReadOnlyHints: true },
    })
    expect(path).toBe(projectSettingsPath(root))
    await h.shutdown()
  })

  test('an absent file, and an unparseable one, both open the editor at {}', async () => {
    // The editor must open on a workspace that has never configured a server, and must not
    // refuse to open on a file someone broke by hand — that file is exactly what needs
    // editing. loadLayers reports the parse failure through the problems list instead.
    const { host: h, transport } = await host()
    await h.handle({ id: 2, method: 'mcp.rawRead', params: {} })
    expect(replyOf(transport, 2).json).toBe('{}')

    writeFileSync(projectSettingsPath(root), '{ this is not json', 'utf8')
    await h.handle({ id: 3, method: 'mcp.rawRead', params: {} })
    expect(replyOf(transport, 3).json).toBe('{}')
    await h.shutdown()
  })
})

describe('mcp.rawSave', () => {
  test('replaces mcpServers and leaves every other key of the file alone', async () => {
    const { host: h, transport } = await host()
    writeFileSync(projectSettingsPath(root), JSON.stringify({
      verify: 'npm test',
      permissions: { deny: ['run_command(npm publish:*)'] },
      mcpServers: { old: { command: 'node' } },
    }, null, 2), 'utf8')
    await h.handle({
      id: 2, method: 'mcp.rawSave',
      params: { json: '{ "docs": { "url": "https://mcp.example.com/sse", "headers": { "X-Key": "k" } } }' },
    })
    expect(replyOf(transport, 2)).toEqual({})

    const doc = JSON.parse(readFileSync(projectSettingsPath(root), 'utf8'))
    // A replacement, not a merge: `old` is gone because the saved document does not name it.
    expect(doc.mcpServers).toEqual({ docs: { url: 'https://mcp.example.com/sse', headers: { 'X-Key': 'k' } } })
    expect(doc.verify).toBe('npm test')
    expect(doc.permissions).toEqual({ deny: ['run_command(npm publish:*)'] })
    await h.shutdown()
  })

  test('a typo is refused before the file is touched', async () => {
    const { host: h, transport } = await host()
    const before = JSON.stringify({ mcpServers: { docs: { command: 'node' } } }, null, 2)
    writeFileSync(projectSettingsPath(root), before, 'utf8')

    await h.handle({ id: 2, method: 'mcp.rawSave', params: { json: '{ "docs": { "command": "node" ' } })
    expect(errorOf(transport, 2)).toMatch(/not valid JSON/)
    // An array parses, and is still not the one shape loadServers can read.
    await h.handle({ id: 3, method: 'mcp.rawSave', params: { json: '["docs"]' } })
    expect(errorOf(transport, 3)).toMatch(/must be an object/)
    // A named entry that is not an object says WHICH one, because the document may be long.
    await h.handle({ id: 4, method: 'mcp.rawSave', params: { json: '{ "docs": "node d.js" }' } })
    expect(errorOf(transport, 4)).toMatch(/"docs" must be an object/)

    expect(readFileSync(projectSettingsPath(root), 'utf8')).toBe(before)
    await h.shutdown()
  })

  test('a half-written entry saves — the connect that follows is what judges it', async () => {
    // Deliberate: direct editing means you may leave a server mid-thought and come back.
    // Depth is judged by loadServers at connect, through the problems list the window
    // already shows above this editor — not by a gate that refuses to save your work.
    const { host: h, transport } = await host()
    await h.handle({ id: 2, method: 'mcp.rawSave', params: { json: '{ "docs": { "args": ["d.js"] } }' } })
    expect(replyOf(transport, 2)).toEqual({})
    const doc = JSON.parse(readFileSync(projectSettingsPath(root), 'utf8'))
    expect(doc.mcpServers).toEqual({ docs: { args: ['d.js'] } })
    await h.shutdown()
  })

  test('an unparseable settings file is refused, not overwritten', async () => {
    // The same read-validate-refuse discipline editRules applies: whatever else is in that
    // file, a save must not be the thing that destroys it.
    const { host: h, transport } = await host()
    writeFileSync(projectSettingsPath(root), '{ "verify": "npm test",', 'utf8')
    await h.handle({ id: 2, method: 'mcp.rawSave', params: { json: '{ "docs": { "command": "node" } }' } })
    expect(errorOf(transport, 2)).toBeDefined()
    expect(readFileSync(projectSettingsPath(root), 'utf8')).toBe('{ "verify": "npm test",')
    await h.shutdown()
  })

  test('what rawSave writes is what rawRead gives back', async () => {
    const { host: h, transport } = await host()
    const json = '{ "docs": { "command": "node", "args": ["d.js"], "env": { "T": "1" } } }'
    await h.handle({ id: 2, method: 'mcp.rawSave', params: { json } })
    await h.handle({ id: 3, method: 'mcp.rawRead', params: {} })
    expect(JSON.parse(replyOf(transport, 3).json)).toEqual(JSON.parse(json))
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
