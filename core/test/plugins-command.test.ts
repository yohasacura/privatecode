import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parsePluginCommand, PluginStore, runPluginCommand, type CommandContext } from '../src/plugins/index.js'
import { writeMarketplace, writePlugin } from './plugins-fixture.js'

describe('parsePluginCommand', () => {
  it("reads Claude Code's grammar, shortcuts included", () => {
    expect(parsePluginCommand('/plugin')).toEqual({ kind: 'open' })
    expect(parsePluginCommand('/plugins help')).toEqual({ kind: 'help' })
    expect(parsePluginCommand('/plugin marketplace add anthropics/claude-code')).toEqual({ kind: 'marketplace-add', source: 'anthropics/claude-code' })
    expect(parsePluginCommand('/plugin market add ./mkt --scope project')).toEqual({ kind: 'marketplace-add', source: './mkt', scope: 'project' })
    expect(parsePluginCommand('/plugin marketplace list')).toEqual({ kind: 'marketplace-list' })
    expect(parsePluginCommand('/plugin marketplace')).toEqual({ kind: 'marketplace-list' })
    expect(parsePluginCommand('/plugin marketplace rm x')).toEqual({ kind: 'marketplace-remove', name: 'x' })
    expect(parsePluginCommand('/plugin marketplace update')).toEqual({ kind: 'marketplace-update' })
    expect(parsePluginCommand('/plugin marketplace update x')).toEqual({ kind: 'marketplace-update', name: 'x' })
    expect(parsePluginCommand('/plugin install a@b -s local')).toEqual({ kind: 'install', spec: 'a@b', scope: 'local' })
    expect(parsePluginCommand('/plugin i a --scope=user')).toEqual({ kind: 'install', spec: 'a', scope: 'user' })
    expect(parsePluginCommand('/plugin uninstall a')).toEqual({ kind: 'uninstall', spec: 'a' })
    expect(parsePluginCommand('/plugin rm a')).toEqual({ kind: 'uninstall', spec: 'a' })
    expect(parsePluginCommand('/plugin enable a')).toEqual({ kind: 'enable', spec: 'a' })
    expect(parsePluginCommand('/plugin disable a')).toEqual({ kind: 'disable', spec: 'a' })
    expect(parsePluginCommand('/plugin update a')).toEqual({ kind: 'update', spec: 'a' })
    expect(parsePluginCommand('/plugin list')).toEqual({ kind: 'list' })
    expect(parsePluginCommand('/plugin list --disabled')).toEqual({ kind: 'list', filter: 'disabled' })
    expect(parsePluginCommand('/plugin details a@b')).toEqual({ kind: 'details', spec: 'a@b' })
    expect(parsePluginCommand('/plugin validate C:\\my plugins\\x')).toEqual({ kind: 'validate', path: 'C:\\my plugins\\x' })
    expect(parsePluginCommand('/reload-plugins --force')).toEqual({ kind: 'reload', force: true })
    expect(parsePluginCommand('/plugin install')).toMatchObject({ kind: 'error' })
    expect(parsePluginCommand('/plugin install a --scope global')).toMatchObject({ kind: 'error', message: expect.stringContaining('--scope') })
    expect(parsePluginCommand('/plugin frobnicate')).toMatchObject({ kind: 'error' })
    expect(parsePluginCommand('/help')).toBeNull()
    expect(parsePluginCommand('install this plugin please')).toBeNull()
  })
})

describe('runPluginCommand', () => {
  let tmp: string
  let ctx: CommandContext
  let saved: string | undefined
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pc-plugins-cmd-'))
    saved = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = join(tmp, 'claude')
    writeMarketplace(join(tmp, 'mkt'), 'fixture-market')
    const ws = join(tmp, 'ws')
    mkdirSync(ws, { recursive: true })
    ctx = { store: new PluginStore(join(tmp, 'store')), workspaceRoot: ws, cwd: tmp, userPath: join(tmp, 'user-settings.json') }
  })
  afterAll(() => {
    if (saved === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = saved
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* a handle still open on Windows */ }
  })
  const run = (line: string) => {
    const cmd = parsePluginCommand(line)
    if (cmd === null) throw new Error(`not a plugin command: ${line}`)
    return runPluginCommand(cmd, ctx)
  }

  it('walks a plugin through its life', async () => {
    let r = await run('/plugin marketplace list')
    expect(r.text).toContain('No marketplaces added')

    r = await run('/plugin marketplace add ./mkt')
    expect(r.ok).toBe(true)
    expect(r.text).toContain('Added marketplace fixture-market (3 plugins)')

    r = await run('/plugin marketplace list')
    expect(r.text).toContain('fixture-market')
    expect(r.text).toContain('Worth adding')

    r = await run('/plugin install alpha@fixture-market')
    expect(r.ok).toBe(true)
    expect(r.changed).toBe(true)
    expect(r.text).toContain('Installed alpha@fixture-market 1.0.0 (user scope)')
    expect(r.text).toContain('Adds 1 skill, 2 commands, 1 agent, 1 hook, 1 MCP server.')
    expect(r.text).toContain('runs code on your machine: hooks on PreToolUse; MCP servers memory')

    r = await run('/plugin list')
    expect(r.text).toContain('● alpha@fixture-market')

    r = await run('/plugin details alpha')
    expect(r.text).toContain('/alpha:greet')
    expect(r.text).toContain('/alpha:review:security')
    expect(r.text).toContain('alpha:reviewer')

    r = await run('/plugin disable alpha')
    expect(r.text).toContain('Disabled alpha@fixture-market (user scope')
    r = await run('/plugin list --enabled')
    expect(r.text).toContain('No enabled plugins')
    r = await run('/plugin list --disabled')
    expect(r.text).toContain('○ alpha@fixture-market')

    r = await run('/plugin enable alpha --scope project')
    expect(r.text).toContain('(project scope')
    expect(existsSync(join(ctx.workspaceRoot ?? '', '.privatecode', 'settings.json'))).toBe(true)

    r = await run('/plugin install beta@fixture-market --scope project')
    expect(r.text).toContain('Installed beta@fixture-market 0.1.0 (project scope)')

    r = await run('/plugin uninstall alpha')
    expect(r.ok).toBe(true)
    expect(r.text).toContain('Uninstalled alpha@fixture-market (user scope)')

    r = await run('/plugin marketplace remove fixture-market')
    expect(r.ok).toBe(true)
    expect(r.text).toContain('Removed marketplace fixture-market')
    expect(r.text).toContain('uninstalled beta@fixture-market')
    expect(ctx.store.installed()).toEqual([])
    expect(ctx.store.knownMarketplaces()).toEqual([])

    r = await run('/plugin install alpha@fixture-market')
    expect(r.ok).toBe(false)
    expect(r.text).toContain('not found')
  })

  it('validates a folder like claude plugin validate', async () => {
    const good = join(tmp, 'good-plugin')
    writePlugin(good, 'good', '1.0.0')
    let r = await run(`/plugin validate ${good}`)
    expect(r.ok).toBe(true)
    expect(r.text).toContain('Validation passed')
    r = await run('/plugin validate ./does-not-exist')
    expect(r.ok).toBe(false)
    expect(r.text).toContain('does not exist')
  })

  it('routes open, reload, help and mistakes', async () => {
    expect(await run('/plugin')).toMatchObject({ open: true })
    expect(await run('/reload-plugins --force')).toMatchObject({ reload: { force: true } })
    expect((await run('/plugin help')).text).toContain('/plugin marketplace add')
    const bad = await run('/plugin install')
    expect(bad.ok).toBe(false)
    expect(bad.text).toMatch(/^✗/)
  })
})
