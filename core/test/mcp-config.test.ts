import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadServers } from '../src/mcp/config.js'
import { McpManager, MAX_MCP_TOOLS, sanitizeSegment, toolNameFor, usableSchema } from '../src/mcp/manager.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { parseRule } from '../src/permissions/rules.js'
import { Workspace } from '../src/workspace.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))

let root: string
let appData: string
let savedAppData: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-mcp-'))
  appData = mkdtempSync(join(tmpdir(), 'pc-mcp-appdata-'))
  savedAppData = process.env['APPDATA']
  // userSettingsPath() reads APPDATA; pointing it at a temp dir keeps the test off the
  // developer's real settings file in both directions.
  process.env['APPDATA'] = appData
  mkdirSync(join(root, '.privatecode'), { recursive: true })
})

afterEach(() => {
  if (savedAppData === undefined) delete process.env['APPDATA']
  else process.env['APPDATA'] = savedAppData
  rmSync(root, { recursive: true, force: true })
  rmSync(appData, { recursive: true, force: true })
})

const writeProject = (doc: unknown): void =>
  writeFileSync(join(root, '.privatecode', 'settings.json'), JSON.stringify(doc), 'utf8')
const writeLocal = (doc: unknown): void =>
  writeFileSync(join(root, '.privatecode', 'settings.local.json'), JSON.stringify(doc), 'utf8')
const writeUser = (doc: unknown): void => {
  mkdirSync(join(appData, 'PrivateCode'), { recursive: true })
  writeFileSync(join(appData, 'PrivateCode', 'settings.json'), JSON.stringify(doc), 'utf8')
}

describe('loadServers', () => {
  test('reads both transport shapes', () => {
    writeProject({
      mcpServers: {
        sqlite: { command: 'uvx', args: ['mcp-server-sqlite', '--db-path', './app.db'] },
        issues: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
      },
    })
    const { servers, problems } = loadServers(root)
    expect(problems).toEqual([])
    expect(servers.map((s) => s.name).sort()).toEqual(['issues', 'sqlite'])
    const sqlite = servers.find((s) => s.name === 'sqlite')!
    expect(sqlite.spec).toEqual({
      kind: 'stdio', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', './app.db'],
    })
    const issues = servers.find((s) => s.name === 'issues')!
    expect(issues.spec).toMatchObject({ kind: 'http', url: 'https://example.com/mcp' })
  })

  test('a later layer overrides an earlier one by name', () => {
    writeProject({ mcpServers: { db: { command: 'shared' } } })
    writeLocal({ mcpServers: { db: { command: 'mine' } } })
    const { servers } = loadServers(root)
    expect(servers).toHaveLength(1)
    expect(servers[0]!.spec).toMatchObject({ command: 'mine' })
    expect(servers[0]!.source).toBe('local settings')
  })

  test('a later layer can turn off a server an earlier one defined', () => {
    // The case that is easy to get wrong: `enabled: false` in the local file has to beat
    // the project file's definition, not merely be absent from its own layer.
    writeProject({ mcpServers: { db: { command: 'shared' } } })
    writeLocal({ mcpServers: { db: { enabled: false } } })
    expect(loadServers(root).servers).toEqual([])
  })

  test('user settings are the base layer', () => {
    writeUser({ mcpServers: { personal: { command: 'mine' } } })
    writeProject({ mcpServers: { shared: { command: 'ours' } } })
    expect(loadServers(root).servers.map((s) => s.name).sort()).toEqual(['personal', 'shared'])
  })

  test('${VAR} in a header comes from the environment', () => {
    // So the secret lives in the environment and the file names it -- the file may well be
    // committed.
    process.env['PC_TEST_TOKEN'] = 's3cret'
    try {
      writeProject({
        mcpServers: { r: { url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer ${PC_TEST_TOKEN}' } } },
      })
      const { servers, problems } = loadServers(root)
      expect(problems).toEqual([])
      expect((servers[0]!.spec as { headers: Record<string, string> }).headers['Authorization'])
        .toBe('Bearer s3cret')
    } finally {
      delete process.env['PC_TEST_TOKEN']
    }
  })

  test('an unset ${VAR} is reported rather than sent literally', () => {
    // Sending the literal `${GH_TOKEN}` as a bearer token produces a 401 that explains
    // nothing about what is actually wrong.
    writeProject({ mcpServers: { r: { url: 'https://x.dev/mcp', headers: { Authorization: '${PC_MISSING}' } } } })
    const { problems } = loadServers(root)
    expect(problems.join(' ')).toContain('PC_MISSING')
  })

  test('malformed entries are problems, and cost only themselves', () => {
    writeProject({
      mcpServers: {
        good: { command: 'ok' },
        neither: { description: 'no command, no url' },
        badUrl: { url: 'not a url' },
        wrongScheme: { url: 'ftp://files.example.com' },
        notAnObject: 'nonsense',
      },
    })
    const { servers, problems } = loadServers(root)
    expect(servers.map((s) => s.name)).toEqual(['good'])
    expect(problems).toHaveLength(4)
  })

  test('a settings file that is not JSON does not throw, and is not reported twice', () => {
    // The permission loader already reports this file as unparseable.
    writeFileSync(join(root, '.privatecode', 'settings.json'), '{ this is not json', 'utf8')
    expect(loadServers(root)).toEqual({ servers: [], problems: [] })
  })

  test('trustReadOnlyHints is off unless asked for', () => {
    writeProject({ mcpServers: { a: { command: 'x' }, b: { command: 'y', trustReadOnlyHints: true } } })
    const { servers } = loadServers(root)
    expect(servers.find((s) => s.name === 'a')!.trustReadOnlyHints).toBe(false)
    expect(servers.find((s) => s.name === 'b')!.trustReadOnlyHints).toBe(true)
  })
})

describe('names', () => {
  test('are sanitised into something a permission rule can spell', () => {
    // TOOL_NAME_RE is what makes a rule expressible at all; a name it rejects is a tool
    // nobody can allow OR deny.
    const name = toolNameFor('github-issues', 'create.issue')
    expect(name).toBe('mcp__github_issues__create_issue')
    expect(parseRule(name)).not.toBeNull()
    expect(parseRule('mcp__github_issues')).not.toBeNull()
  })

  test('an empty segment still produces a spellable name', () => {
    expect(sanitizeSegment('!!!')).toBe('___')
    expect(parseRule(toolNameFor('!!!', '???'))).not.toBeNull()
  })

  test('a very long name is cut to something the rule parser accepts', () => {
    const name = toolNameFor('a'.repeat(80), 'b'.repeat(80))
    expect(name.length).toBeLessThanOrEqual(64)
    expect(parseRule(name)).not.toBeNull()
  })
})

describe('usableSchema', () => {
  test('passes a real object schema through untouched', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
    expect(usableSchema(schema)).toEqual({ schema, replaced: false })
  })

  test('replaces anything llama.cpp could not build a grammar from', () => {
    // One bad schema breaks EVERY call in the session, not just this tool's: the server
    // compiles one grammar from all of them.
    for (const bad of [undefined, null, 'string', [], { type: 'array' }, {}]) {
      expect(usableSchema(bad).replaced).toBe(true)
      expect(usableSchema(bad).schema).toEqual({ type: 'object', properties: {} })
    }
  })
})

describe('McpManager', () => {
  const configFor = (name: string, flags: string[] = [], extra: Partial<{ trustReadOnlyHints: boolean }> = {}) => ({
    name,
    spec: { kind: 'stdio' as const, command: process.execPath, args: [FIXTURE, ...flags] },
    source: 'project settings',
    trustReadOnlyHints: extra.trustReadOnlyHints ?? false,
  })

  test('registers a server\'s tools under mcp__<server>__<tool>', async () => {
    const manager = new McpManager()
    const registry = new ToolRegistry()
    const problems = await manager.connectAll([configFor('fixture')], registry)
    try {
      expect(problems).toEqual([])
      expect(registry.get('mcp__fixture__echo')).toBeDefined()
      expect(registry.get('mcp__fixture__read_note')).toBeDefined()
      expect(manager.servers()).toEqual([{ name: 'fixture', state: 'connected', toolCount: 3 }])
    } finally {
      await manager.closeAll()
    }
  })

  test('a registered tool actually calls the server', async () => {
    const manager = new McpManager()
    const registry = new ToolRegistry()
    await manager.connectAll([configFor('fixture')], registry)
    try {
      const result = await registry.run('mcp__fixture__echo', '{"text":"through the registry"}',
        { workspace: new Workspace(root) })
      expect(result.ok).toBe(true)
      expect(result.content).toContain('echo: through the registry')
    } finally {
      await manager.closeAll()
    }
  })

  test('a server\'s isError comes back as a failed tool call', async () => {
    const manager = new McpManager()
    const registry = new ToolRegistry()
    await manager.connectAll([configFor('fixture')], registry)
    try {
      const result = await registry.run('mcp__fixture__boom', '{}', { workspace: new Workspace(root) })
      expect(result.ok).toBe(false)
      expect(result.content).toContain('the database is on fire')
    } finally {
      await manager.closeAll()
    }
  })

  test('readOnlyHint is ignored unless the user opted in', async () => {
    // `readOnly` is what admits a tool to plan mode, which is a promise made to the USER.
    // Taking a third party's word for it is the wrong direction of trust.
    const guarded = new McpManager()
    const guardedRegistry = new ToolRegistry()
    await guarded.connectAll([configFor('a')], guardedRegistry)
    const trusting = new McpManager()
    const trustingRegistry = new ToolRegistry()
    await trusting.connectAll([configFor('b', [], { trustReadOnlyHints: true })], trustingRegistry)
    try {
      expect(guardedRegistry.readOnlyNames()).toEqual([])
      expect(trustingRegistry.readOnlyNames()).toEqual(['mcp__b__read_note'])
    } finally {
      await guarded.closeAll()
      await trusting.closeAll()
    }
  })

  test('a failing server is a problem, and the others still work', async () => {
    const manager = new McpManager()
    const registry = new ToolRegistry()
    const problems = await manager.connectAll(
      [configFor('broken', ['--crash']), configFor('working')], registry)
    try {
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('MCP_TOKEN is not set')
      expect(registry.get('mcp__working__echo')).toBeDefined()
      const states = Object.fromEntries(manager.servers().map((s) => [s.name, s.state]))
      expect(states).toEqual({ broken: 'failed', working: 'connected' })
    } finally {
      await manager.closeAll()
    }
  })

  test('two servers whose names collide after sanitising both stay reachable', async () => {
    const manager = new McpManager()
    const registry = new ToolRegistry()
    await manager.connectAll([configFor('my-server'), configFor('my_server')], registry)
    try {
      expect(registry.get('mcp__my_server__echo')).toBeDefined()
      expect(registry.get('mcp__my_server__echo_2')).toBeDefined()
    } finally {
      await manager.closeAll()
    }
  })

  test('the tool budget is enforced and said out loud', async () => {
    // A cap nobody is told about reads as "everything is here".
    const manager = new McpManager()
    const registry = new ToolRegistry()
    const many = Array.from({ length: MAX_MCP_TOOLS }, (_, i) => configFor(`s${i}`))
    const problems = await manager.connectAll(many, registry)
    try {
      expect(registry.schemas().length).toBe(MAX_MCP_TOOLS)
      expect(problems.some((p) => p.includes('were not registered'))).toBe(true)
    } finally {
      await manager.closeAll()
    }
  }, 60_000)

  test('a call after the server is gone fails with a message, not a crash', async () => {
    const manager = new McpManager()
    const registry = new ToolRegistry()
    await manager.connectAll([configFor('fixture')], registry)
    await manager.closeAll()
    const result = await registry.run('mcp__fixture__echo', '{"text":"x"}',
      { workspace: new Workspace(root) })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('not connected')
  })
})
