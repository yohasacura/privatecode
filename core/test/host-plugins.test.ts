import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { SessionHost } from '../src/host/host.js'
import {
  isHostEvent, type CommandsListResult, type HostOutbound, type HostReply, type PluginsCatalogResult, type PluginsCommandResult,
  type PluginsListResult, type SkillsListResult,
} from '../src/host/protocol.js'
import { RawResponse, startFakeServer } from './fake-server.js'
import { writeMarketplace } from './plugins-fixture.js'

/**
 * The host's plugin RPCs (docs/PLUGINS-2026-09.md, phase D): a `/plugin …` line run
 * through `plugins.command` changes the store AND the running workspace — the next
 * `commands.list` and `skills.list` already show the plugin, and `plugins.list` says so.
 */

let tmp: string
let workspace: string
let mkt: string
let savedAppData: string | undefined
let savedClaudeDir: string | undefined
let stop: (() => Promise<void>) | undefined

interface Transport { messages: HostOutbound[]; send(msg: HostOutbound): void }

function resultOf<T>(transport: Transport, id: number): T {
  const found = transport.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
  if (!found) throw new Error(`no reply to request ${id}`)
  if ('error' in found) throw new Error(`request ${id} failed: ${found.error.message}`)
  return found.result as T
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pc-host-plugins-'))
  savedAppData = process.env['APPDATA']
  savedClaudeDir = process.env['CLAUDE_CONFIG_DIR']
  // The store lives under %APPDATA%: pointed at a temp folder so the machine's own plugins are untouched.
  process.env['APPDATA'] = join(tmp, 'appdata')
  process.env['CLAUDE_CONFIG_DIR'] = join(tmp, 'claude')
  workspace = join(tmp, 'ws')
  mkdirSync(workspace, { recursive: true })
  mkt = join(tmp, 'mkt')
  writeMarketplace(mkt, 'fixture-market')
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 1000 } }
    if (req.url === '/health') return { status: 'ok' }
    return new RawResponse(501, '{}', 'application/json')
  })
  stop = fake.close
  serverUrl = fake.url
})
afterAll(async () => {
  await stop?.()
  if (savedAppData === undefined) delete process.env['APPDATA']; else process.env['APPDATA'] = savedAppData
  if (savedClaudeDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = savedClaudeDir
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* a handle still open on Windows */ }
})
let serverUrl = ''

test('a plugin installed through the host is live in the workspace at once', async () => {
  const transport: Transport = { messages: [], send(msg) { this.messages.push(msg) } }
  const host = new SessionHost({ transport, prewarm: false })
  await host.handle({ id: 1, method: 'init', params: { workspaceRoot: workspace, serverUrl } })
  let id = 1
  const call = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    id++
    await host.handle({ id, method, params })
    return resultOf<T>(transport, id)
  }

  // The four Anthropic catalogs are registered (not fetched) on first run.
  const before = await call<PluginsListResult>('plugins.list')
  expect(before.marketplaces.map((m) => `${m.name}:${m.fetched}`)).toEqual([
    'anthropic-agent-skills:false', 'claude-code-plugins:false', 'claude-community:false', 'claude-plugins-official:false',
  ])
  expect(before.suggested.map((s) => s.name)).toEqual(['superpowers-marketplace', 'claude-code-workflows'])
  expect(before.plugins).toEqual([])

  const open = await call<PluginsCommandResult>('plugins.command', { line: '/plugin' })
  expect(open).toMatchObject({ ok: true, open: true })

  const added = await call<PluginsCommandResult>('plugins.command', { line: `/plugin marketplace add ${mkt}` })
  expect(added.ok).toBe(true)
  expect(added.text).toContain('Added marketplace fixture-market (3 plugins)')

  const catalog = await call<PluginsCatalogResult>('plugins.catalog', { marketplace: 'fixture-market' })
  expect(catalog.entries.map((e) => `${e.id}:${e.installed}`)).toEqual(['alpha@fixture-market:false', 'beta@fixture-market:false', 'gamma@fixture-market:false'])

  const installed = await call<PluginsCommandResult>('plugins.command', { line: '/plugin install alpha@fixture-market --scope project' })
  expect(installed.ok).toBe(true)
  expect(installed.changed).toBe(true)
  expect(installed.text).toContain('Installed alpha@fixture-market 1.0.0 (project scope)')
  expect(installed.text).toContain('Plugins active in this workspace: alpha@fixture-market.')
  expect(installed.text).not.toContain('/reload-plugins')
  expect(installed.reloaded?.plugins).toEqual(['alpha@fixture-market'])

  // Live, without a restart: the commands and the agents are there now.
  const commands = await call<CommandsListResult>('commands.list')
  expect(commands.commands.map((c) => c.name)).toEqual(expect.arrayContaining(['alpha:greet', 'alpha:hello', 'alpha:review:security']))
  const skills = await call<SkillsListResult>('skills.list')
  expect(skills.skills.find((s) => s.name === 'alpha:greet')).toMatchObject({ scope: 'plugin', plugin: 'alpha' })

  const list = await call<PluginsListResult>('plugins.list')
  expect(list.plugins).toHaveLength(1)
  expect(list.plugins[0]).toMatchObject({ id: 'alpha@fixture-market', enabled: true, scopes: ['project'], skills: ['greet'], agents: ['reviewer'], mcpServers: ['memory'] })
  expect(list.plugins[0]?.decidedBy).toBe(join(workspace, '.privatecode', 'settings.json'))

  const disabled = await call<PluginsCommandResult>('plugins.command', { line: '/plugin disable alpha' })
  expect(disabled.ok).toBe(true)
  expect(disabled.text).toContain('Plugins active in this workspace: none.')
  expect((await call<CommandsListResult>('commands.list')).commands.some((c) => c.name.startsWith('alpha:'))).toBe(false)

  const reloaded = await call<PluginsCommandResult>('plugins.command', { line: '/reload-plugins' })
  expect(reloaded.ok).toBe(true)
  expect(reloaded.text).toContain('Plugins active in this workspace: none.')

  const nonsense = await call<PluginsCommandResult>('plugins.command', { line: '/plugin frobnicate' })
  expect(nonsense.ok).toBe(false)

  await host.shutdown()
})
