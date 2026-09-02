import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addMarketplace, adoptDeclaredMarketplaces, effectivePlugins, ensureDefaultMarketplaces, gitAvailable, installPlugin,
  parseMarketplaceSource, PluginStore, readCatalog, removeMarketplace, setEnabled, splitPluginId, uninstallPlugin,
  updateMarketplace, updatePlugin,
} from '../src/plugins/index.js'
import { gitCommit, gitInit, writeMarketplace } from './plugins-fixture.js'

const hasGit = await gitAvailable()

let tmp: string
let userPath: string
let ws: string
let savedClaudeDir: string | undefined
const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pc-plugins-'))
  userPath = join(tmp, 'user', 'settings.json')
  ws = join(tmp, 'ws')
  mkdirSync(ws, { recursive: true })
  savedClaudeDir = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = join(tmp, 'claude')
})
afterAll(() => {
  if (savedClaudeDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = savedClaudeDir
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* a handle still open on Windows */ }
})

describe('parseMarketplaceSource', () => {
  it('reads what /plugin marketplace add accepts', () => {
    expect(parseMarketplaceSource('anthropics/claude-code')).toEqual({ source: { source: 'github', repo: 'anthropics/claude-code' } })
    expect(parseMarketplaceSource('owner/repo@v1.2')).toEqual({ source: { source: 'github', repo: 'owner/repo', ref: 'v1.2' } })
    expect(parseMarketplaceSource('https://github.com/a/b')).toEqual({ source: { source: 'github', repo: 'a/b' } })
    expect(parseMarketplaceSource('https://github.com/a/b/tree/dev')).toEqual({ source: { source: 'github', repo: 'a/b', ref: 'dev' } })
    expect(parseMarketplaceSource('https://github.com/a/b.git#x')).toEqual({ source: { source: 'git', url: 'https://github.com/a/b.git', ref: 'x' } })
    expect(parseMarketplaceSource('https://gitlab.com/g/p')).toEqual({ source: { source: 'git', url: 'https://gitlab.com/g/p' } })
    expect(parseMarketplaceSource('https://example.com/x/marketplace.json')).toEqual({ source: { source: 'url', url: 'https://example.com/x/marketplace.json' } })
    expect(parseMarketplaceSource('git@github.com:a/b.git')).toEqual({ source: { source: 'git', url: 'git@github.com:a/b.git' } })
    expect(parseMarketplaceSource('example.com/foo')).toMatchObject({ error: expect.stringContaining('https://') })
    expect(parseMarketplaceSource('https://example.com/foo')).toMatchObject({ error: expect.stringContaining('.git') })
    expect(parseMarketplaceSource('')).toMatchObject({ error: expect.any(String) })
  })

  it('takes a folder, or its marketplace.json', () => {
    const dir = join(tmp, 'src-mkt')
    writeMarketplace(dir, 'src-mkt')
    expect(parseMarketplaceSource(dir)).toEqual({ source: { source: 'directory', path: dir } })
    expect(parseMarketplaceSource(join(dir, '.claude-plugin', 'marketplace.json'))).toEqual({ source: { source: 'directory', path: dir } })
    expect(parseMarketplaceSource('./src-mkt', tmp)).toEqual({ source: { source: 'directory', path: join(tmp, 'src-mkt') } })
    expect(parseMarketplaceSource('./nope', tmp)).toMatchObject({ error: expect.stringContaining('does not exist') })
  })
})

describe('PluginStore', () => {
  it('round-trips its records and survives a corrupt file', () => {
    const store = new PluginStore(join(tmp, 'store-basic'))
    store.ensure()
    expect(store.knownMarketplaces()).toEqual([])
    store.putMarketplace({ name: 'b', source: { source: 'github', repo: 'x/y' } })
    store.putMarketplace({ name: 'a', source: { source: 'directory', path: 'C:\\m' }, installLocation: 'C:\\m', bundled: true })
    expect(store.knownMarketplaces().map((m) => m.name)).toEqual(['a', 'b'])
    expect(store.marketplace('a')?.bundled).toBe(true)
    store.dropMarketplace('b')
    expect(store.knownMarketplaces().map((m) => m.name)).toEqual(['a'])
    store.putInstalled({ id: 'p@a', name: 'p', marketplace: 'a', version: '1', installPath: 'C:\\x', installedAt: 't', lastUpdated: 't', scopes: [{ scope: 'user' }] })
    expect(store.installedPlugin('p@a')?.scopes).toEqual([{ scope: 'user' }])
    store.dropInstalled('p@a')
    expect(store.installed()).toEqual([])
    writeFileSync(store.installedFile, '{ broken')
    expect(store.installed()).toEqual([])
    expect(store.problems[0]).toContain('not valid JSON')
    expect(store.cachePath('m', 'p', '1.0/../x')).toBe(join(store.cacheDir, 'm', 'p', '1.0_.._x'))
  })

  it('splits name@marketplace', () => {
    expect(splitPluginId('a@b')).toEqual({ name: 'a', marketplace: 'b' })
    expect(splitPluginId('a')).toEqual({ name: 'a', marketplace: null })
    expect(splitPluginId('@scoped')).toEqual({ name: '@scoped', marketplace: null })
  })
})

describe('a marketplace read from a folder', () => {
  let store: PluginStore
  let mkt: string
  beforeAll(() => {
    store = new PluginStore(join(tmp, 'store-dir'))
    mkt = join(tmp, 'dir-mkt')
    writeMarketplace(mkt, 'fixture-market')
  })

  it('adds it in place, without copying', async () => {
    const r = await addMarketplace(store, mkt, { userPath })
    if ('error' in r) throw new Error(r.error)
    expect(r.manifest.name).toBe('fixture-market')
    expect(r.marketplace.installLocation).toBe(mkt)
    expect(r.problems).toEqual([])
    expect(existsSync(store.marketplaceDir('fixture-market'))).toBe(false)
    const catalog = readCatalog(store, 'fixture-market')
    if ('error' in catalog) throw new Error(catalog.error)
    expect(catalog.manifest.plugins.map((p) => p.name)).toEqual(['alpha', 'beta', 'gamma'])
    expect(catalog.dir).toBe(mkt)
  })

  it('refuses the same name from elsewhere, refreshes the same source', async () => {
    const other = join(tmp, 'dir-mkt-2')
    writeMarketplace(other, 'fixture-market')
    expect(await addMarketplace(store, other, { userPath })).toMatchObject({ error: expect.stringContaining('already registered') })
    expect(await addMarketplace(store, mkt, { userPath })).toMatchObject({ refreshed: true })
  })

  it('installs a plugin: files, record, setting', async () => {
    const r = await installPlugin(store, 'alpha@fixture-market', { userPath })
    if ('error' in r) throw new Error(r.error)
    expect(r.version).toBe('1.0.0')
    expect(r.installPath).toBe(store.cachePath('fixture-market', 'alpha', '1.0.0'))
    expect(existsSync(join(r.installPath, 'skills', 'greet', 'SKILL.md'))).toBe(true)
    expect(r.inventory.commands).toEqual(['hello', 'review:security'])
    expect(r.enabled).toBe(true)
    expect(r.warnings).toEqual([])
    expect(store.installedPlugin('alpha@fixture-market')?.scopes).toEqual([{ scope: 'user' }])
    expect(readJson(userPath)['enabledPlugins']).toEqual({ 'alpha@fixture-market': true })
  })

  it('honours pluginRoot, a bare name, a catalog version and defaultEnabled', async () => {
    const beta = await installPlugin(store, 'beta', { userPath })
    if ('error' in beta) throw new Error(beta.error)
    expect(beta.id).toBe('beta@fixture-market')
    expect(beta.version).toBe('0.1.0')
    expect(beta.inventory.skills).toEqual(['beta'])
    const gamma = await installPlugin(store, 'gamma@fixture-market', { userPath })
    if ('error' in gamma) throw new Error(gamma.error)
    expect(gamma.enabled).toBe(false)
    expect(readJson(userPath)['enabledPlugins']).toMatchObject({ 'gamma@fixture-market': false })
  })

  it('follows renames and reports removals', async () => {
    const r = await installPlugin(store, 'old-alpha@fixture-market', { userPath })
    if ('error' in r) throw new Error(r.error)
    expect(r.id).toBe('alpha@fixture-market')
    expect(r.renamedFrom).toBe('old-alpha')
    expect(r.alreadyInstalled).toBe(true)
    expect(await installPlugin(store, 'gone@fixture-market', { userPath })).toMatchObject({ error: expect.stringContaining('was removed') })
    expect(await installPlugin(store, 'nothing@fixture-market', { userPath })).toMatchObject({ error: expect.stringContaining('not found') })
    expect(await installPlugin(store, 'alpha@nowhere', { userPath })).toMatchObject({ error: expect.stringContaining('not found') })
  })

  it('installs for a project, and the project decides', async () => {
    const r = await installPlugin(store, 'beta@fixture-market', { scope: 'project', workspaceRoot: ws, userPath })
    if ('error' in r) throw new Error(r.error)
    const projectFile = join(ws, '.privatecode', 'settings.json')
    expect(readJson(projectFile)['enabledPlugins']).toEqual({ 'beta@fixture-market': true })
    expect(store.installedPlugin('beta@fixture-market')?.scopes).toEqual([{ scope: 'user' }, { scope: 'project', workspaceRoot: ws }])
    const off = setEnabled(store, 'beta', false, { workspaceRoot: ws, userPath })
    if ('error' in off) throw new Error(off.error)
    expect(off.scope).toBe('project')
    expect(readJson(projectFile)['enabledPlugins']).toEqual({ 'beta@fixture-market': false })
    const eff = effectivePlugins(store, ws, userPath)
    const beta = eff.plugins.find((p) => p.id === 'beta@fixture-market')
    expect(beta?.enabled).toBe(false)
    expect(beta?.decidedBy).toBe(projectFile)
    expect(effectivePlugins(store, undefined, userPath).plugins.find((p) => p.id === 'beta@fixture-market')?.enabled).toBe(true)
  })

  it("reads Claude Code's settings files too, in the same precedence order", () => {
    mkdirSync(join(tmp, 'claude'), { recursive: true })
    writeFileSync(join(tmp, 'claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'foo@bar': true, 'alpha@fixture-market': false } }))
    mkdirSync(join(ws, '.claude'), { recursive: true })
    writeFileSync(join(ws, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'gamma@fixture-market': true } }))
    const eff = effectivePlugins(store, ws, userPath)
    expect(eff.declared).toEqual([{ id: 'foo@bar', from: join(tmp, 'claude', 'settings.json') }])
    // Our user file (true) is read after Claude Code's user file (false).
    expect(eff.plugins.find((p) => p.id === 'alpha@fixture-market')?.enabled).toBe(true)
    // The project's .claude/settings.json (true) outranks our user file (false).
    expect(eff.plugins.find((p) => p.id === 'gamma@fixture-market')?.enabled).toBe(true)
  })

  it('uninstalls one scope at a time, then the files', () => {
    const p1 = uninstallPlugin(store, 'beta@fixture-market', { workspaceRoot: ws, userPath })
    if ('error' in p1) throw new Error(p1.error)
    expect(p1).toMatchObject({ scope: 'project', removedFiles: false })
    expect(readJson(join(ws, '.privatecode', 'settings.json'))['enabledPlugins']).toBeUndefined()
    const p2 = uninstallPlugin(store, 'beta', { userPath })
    if ('error' in p2) throw new Error(p2.error)
    expect(p2).toMatchObject({ scope: 'user', removedFiles: true })
    expect(store.installedPlugin('beta@fixture-market')).toBeUndefined()
    expect(existsSync(store.cachePath('fixture-market', 'beta', '0.1.0'))).toBe(false)
    expect(readJson(userPath)['enabledPlugins']).not.toHaveProperty('beta@fixture-market')
    expect(uninstallPlugin(store, 'beta', { userPath })).toMatchObject({ error: expect.stringContaining('not installed') })
  })

  it('forgets the marketplace without touching the folder', () => {
    const r = removeMarketplace(store, 'fixture-market', { workspaceRoot: ws, userPath })
    if ('error' in r) throw new Error(r.error)
    expect(r.removedCopy).toBe(false)
    expect(existsSync(join(mkt, '.claude-plugin', 'marketplace.json'))).toBe(true)
    expect(store.marketplace('fixture-market')).toBeUndefined()
  })
})

describe.skipIf(!hasGit)('a marketplace cloned from git', () => {
  let store: PluginStore
  let repo: string
  let repoUrl: string
  let firstSha: string
  beforeAll(async () => {
    store = new PluginStore(join(tmp, 'store-git'))
    repo = join(tmp, 'git-mkt')
    repoUrl = repo.replace(/\\/g, '/')
    writeMarketplace(repo, 'fixture-git')
    firstSha = await gitInit(repo)
  })

  it('clones into marketplaces/<name> and records the source', async () => {
    const r = await addMarketplace(store, { source: 'git', url: repoUrl }, { userPath })
    if ('error' in r) throw new Error(r.error)
    expect(r.marketplace.installLocation).toBe(store.marketplaceDir('fixture-git'))
    expect(existsSync(join(store.marketplaceDir('fixture-git'), '.claude-plugin', 'marketplace.json'))).toBe(true)
    expect(store.marketplace('fixture-git')?.source).toEqual({ source: 'git', url: repoUrl })
  })

  it('installs from the clone and remembers the commit', async () => {
    const r = await installPlugin(store, 'alpha@fixture-git', { userPath })
    if ('error' in r) throw new Error(r.error)
    expect(r.version).toBe('1.0.0')
    expect(store.installedPlugin('alpha@fixture-git')?.sha).toBe(firstSha)
    expect(existsSync(join(r.installPath, '.git'))).toBe(false)
  })

  it('updates the marketplace and the plugin after a new commit', async () => {
    writeMarketplace(repo, 'fixture-git', { alphaVersion: '1.1.0', remote: { url: repoUrl, path: 'plugins/alpha', sha: firstSha } })
    await gitCommit(repo, 'alpha 1.1.0, remote entry')
    const m = await updateMarketplace(store, 'fixture-git')
    if ('error' in m) throw new Error(m.error)
    expect(m.changed).toBe(true)
    expect(m.plugins).toBe(4)
    const u = await updatePlugin(store, 'alpha@fixture-git', { userPath })
    if ('error' in u) throw new Error(u.error)
    expect(u).toMatchObject({ from: '1.0.0', to: '1.1.0', changed: true })
    expect(existsSync(store.cachePath('fixture-git', 'alpha', '1.0.0'))).toBe(false)
    expect(existsSync(store.cachePath('fixture-git', 'alpha', '1.1.0'))).toBe(true)
    expect(await updatePlugin(store, 'alpha@fixture-git', { userPath })).toMatchObject({ changed: false })
  })

  it('honours a pinned commit in a git-subdir source', async () => {
    const r = await installPlugin(store, 'remote@fixture-git', { userPath })
    if ('error' in r) throw new Error(r.error)
    expect(r.version).toBe('1.0.0')
    expect(store.installedPlugin('remote@fixture-git')?.sha).toBe(firstSha)
    expect(r.inventory.skills).toEqual(['greet'])
  })

  it('refuses npm and command sources', async () => {
    const dir = join(tmp, 'unsafe-mkt')
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'unsafe', owner: { name: 't' },
      plugins: [{ name: 'run', source: { source: 'command', command: 'echo pwned' } }, { name: 'pkg', source: { source: 'npm', package: 'x' } }],
    }))
    const added = await addMarketplace(store, dir, { userPath })
    if ('error' in added) throw new Error(added.error)
    expect(await installPlugin(store, 'run@unsafe', { userPath })).toMatchObject({ error: expect.stringContaining('command') })
    expect(await installPlugin(store, 'pkg@unsafe', { userPath })).toMatchObject({ error: expect.stringContaining('npm') })
  })

  it('removes the clone with the marketplace', () => {
    const r = removeMarketplace(store, 'fixture-git', { userPath })
    if ('error' in r) throw new Error(r.error)
    expect(r.removedCopy).toBe(true)
    expect(existsSync(store.marketplaceDir('fixture-git'))).toBe(false)
  })
})

describe('bundled marketplaces and names', () => {
  it('registers the four Anthropic catalogs once, unfetched', () => {
    const store = new PluginStore(join(tmp, 'store-defaults'))
    expect(ensureDefaultMarketplaces(store)).toEqual(['claude-plugins-official', 'claude-community', 'claude-code-plugins', 'anthropic-agent-skills'])
    expect(ensureDefaultMarketplaces(store)).toEqual([])
    expect(store.knownMarketplaces().every((m) => m.bundled === true && m.installLocation === undefined)).toBe(true)
    expect(readCatalog(store, 'claude-code-plugins')).toMatchObject({ error: expect.stringContaining('not been fetched') })
  })

  it('refuses a reserved name from a stranger, notes a look-alike, lets a bundled one through', async () => {
    const store = new PluginStore(join(tmp, 'store-names'))
    const fake = join(tmp, 'fake-official')
    writeMarketplace(fake, 'claude-plugins-official')
    expect(await addMarketplace(store, fake, { userPath })).toMatchObject({ error: expect.stringContaining('reserved') })
    expect(await addMarketplace(store, fake, { userPath, bundled: true })).toMatchObject({ manifest: { name: 'claude-plugins-official' } })
    const lookalike = join(tmp, 'lookalike')
    writeMarketplace(lookalike, 'anthropic-extras')
    const r = await addMarketplace(store, lookalike, { userPath })
    if ('error' in r) throw new Error(r.error)
    expect(r.problems).toEqual([expect.stringContaining('resembles')])
  })

  it('adopts marketplaces a settings file declares', () => {
    const store = new PluginStore(join(tmp, 'store-adopt'))
    const ws2 = join(tmp, 'ws-adopt')
    mkdirSync(join(ws2, '.claude'), { recursive: true })
    writeFileSync(join(ws2, '.claude', 'settings.json'), JSON.stringify({ extraKnownMarketplaces: {
      'team-tools': { source: { source: 'github', repo: 'acme/tools' } },
      'claude-plugins-official': { source: { source: 'github', repo: 'evil/x' } },
    } }))
    const r = adoptDeclaredMarketplaces(store, ws2, userPath)
    expect(r.added).toEqual(['team-tools'])
    expect(r.problems).toEqual([expect.stringContaining('reserved')])
    expect(store.marketplace('team-tools')?.source).toEqual({ source: 'github', repo: 'acme/tools' })
  })
})
