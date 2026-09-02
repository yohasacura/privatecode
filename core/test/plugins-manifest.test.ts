import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  impersonatesOfficial, insidePlugin, inventory, parseMarketplaceManifest, readMarketplaceManifest, readPluginManifest, readSource,
  resemblesOfficial, validatePlugin,
} from '../src/plugins/index.js'
import { writeMarketplace, writePlugin } from './plugins-fixture.js'

let tmp: string
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'pc-plugins-manifest-')) })
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* a handle still open on Windows */ } })

describe('marketplace.json', () => {
  it('reads a manifest and reports what is off in it', () => {
    const r = parseMarketplaceManifest({
      name: 'x', owner: { name: 'o' },
      plugins: [{ name: 'a', source: './a' }, { name: 'Bad Name', source: './b' }, { name: 'a', source: './dup' }, { source: './noname' }, 'junk'],
    }, 'm.json')
    expect(r.value?.name).toBe('x')
    expect(r.value?.plugins.map((p) => p.name)).toEqual(['a', 'Bad Name'])
    expect(r.problems).toEqual(expect.arrayContaining([
      expect.stringContaining('"Bad Name": a plugin name is kebab-case'),
      expect.stringContaining('listed twice'),
      expect.stringContaining('plugins[3] has no name'),
      expect.stringContaining('plugins[4] must be an object'),
    ]))
  })

  it('refuses a manifest without a name or a plugins array', () => {
    expect(parseMarketplaceManifest({ owner: { name: 'o' }, plugins: [] }, 'm').value).toBeNull()
    expect(parseMarketplaceManifest({ name: 'x', plugins: 'nope' }, 'm').value).toBeNull()
  })

  it('keeps metadata and renames', () => {
    const r = parseMarketplaceManifest({ name: 'x', owner: 'me', metadata: { pluginRoot: './plugins' }, plugins: [], renames: { old: 'new', gone: null, bad: 3 } }, 'm')
    expect(r.value?.owner).toEqual({ name: 'me' })
    expect(r.value?.metadata?.pluginRoot).toBe('./plugins')
    expect(r.value?.renames).toEqual({ old: 'new', gone: null })
    expect(r.problems).toEqual([expect.stringContaining('renames.bad')])
  })

  it('reads every source kind Claude Code defines', () => {
    const problems: string[] = []
    expect(readSource('./x', 'p', problems)).toBe('./x')
    expect(readSource({ source: 'github', repo: 'a/b', ref: 'v1', sha: 'abc', path: 'plugins/x' }, 'p', problems)).toEqual({ source: 'github', repo: 'a/b', ref: 'v1', sha: 'abc', path: 'plugins/x' })
    expect(readSource({ source: 'url', url: 'https://x/y.git' }, 'p', problems)).toEqual({ source: 'url', url: 'https://x/y.git' })
    expect(readSource({ source: 'git-subdir', url: 'https://x/y.git', path: 'p' }, 'p', problems)).toEqual({ source: 'git-subdir', url: 'https://x/y.git', path: 'p' })
    expect(readSource({ source: 'archive', url: 'https://x/y.zip', sha256: 'ff' }, 'p', problems)).toEqual({ source: 'archive', url: 'https://x/y.zip', sha256: 'ff' })
    expect(readSource({ source: 'npm', package: 'pkg' }, 'p', problems)).toEqual({ source: 'npm', package: 'pkg' })
    expect(readSource({ source: 'command', command: 'do it' }, 'p', problems)).toEqual({ source: 'command', command: 'do it' })
    expect(problems).toEqual([])
    expect(readSource({ source: 'github', repo: 'not-a-repo' }, 'p', problems)).toBeNull()
    expect(readSource({ source: 'ftp', url: 'x' }, 'p', problems)).toBeNull()
    expect(readSource({ source: 'git-subdir', url: 'x' }, 'p', problems)).toBeNull()
    expect(problems).toHaveLength(3)
  })

  it('finds the file inside .claude-plugin, or takes the file itself', () => {
    const dir = join(tmp, 'mkt')
    writeMarketplace(dir, 'fixture')
    expect(readMarketplaceManifest(dir).value?.name).toBe('fixture')
    expect(readMarketplaceManifest(join(dir, '.claude-plugin', 'marketplace.json')).value?.plugins).toHaveLength(3)
    expect(readMarketplaceManifest(join(tmp, 'nowhere')).problems[0]).toContain('not found')
  })
})

describe('plugin.json and the inventory', () => {
  it('reads a full plugin: skills, nested commands, agents, hooks, MCP servers', () => {
    const dir = join(tmp, 'alpha')
    writePlugin(dir, 'alpha', '1.0.0')
    const m = readPluginManifest(dir)
    expect(m.value?.name).toBe('alpha')
    expect(m.value?.version).toBe('1.0.0')
    const inv = inventory(dir, m.value)
    expect(inv.skills).toEqual(['greet'])
    expect(inv.commands).toEqual(['hello', 'review:security'])
    expect(inv.agents).toEqual(['reviewer'])
    expect(inv.hooks).toEqual([{ event: 'PreToolUse', count: 1 }])
    expect(inv.mcpServers).toEqual(['memory'])
    expect(inv.problems).toEqual([])
  })

  it('a plugin without a manifest is still a plugin; a root SKILL.md is one skill named after it', () => {
    const dir = join(tmp, 'beta')
    writePlugin(dir, 'beta', null, { single: true })
    expect(readPluginManifest(dir)).toEqual({ value: null, problems: [] })
    expect(inventory(dir, null).skills).toEqual(['beta'])
  })

  it('a broken manifest is one problem, not a throw', () => {
    const dir = join(tmp, 'broken')
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{ not json')
    expect(readPluginManifest(dir).problems[0]).toContain('not valid JSON')
    expect(validatePlugin(dir).ok).toBe(false)
  })

  it('names what it declares but PrivateCode ignores', () => {
    const dir = join(tmp, 'lsp')
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'lsp', lspServers: {}, outputStyles: './styles', skills: './skills' }))
    expect(readPluginManifest(dir).value?.unsupported).toEqual(['lspServers', 'outputStyles'])
    const v = validatePlugin(dir)
    expect(v.ok).toBe(true)
    expect(v.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('declares lspServers, outputStyles'),
      expect.stringContaining('contributes no'),
    ]))
  })

  it('keeps every path inside the plugin', () => {
    expect(insidePlugin('C:\\p', '../x')).toBeNull()
    expect(insidePlugin('C:\\p', 'C:\\elsewhere')).toBeNull()
    expect(insidePlugin('C:\\p', 'a/../../x')).toBeNull()
    expect(insidePlugin('C:\\p', './skills')).toBe(join('C:\\p', 'skills'))
  })
})

describe('validatePlugin', () => {
  it('rejects components inside .claude-plugin/ and paths that leave the plugin', () => {
    const dir = join(tmp, 'misplaced')
    mkdirSync(join(dir, '.claude-plugin', 'commands'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'misplaced', agents: '../../agents' }))
    const v = validatePlugin(dir)
    expect(v.ok).toBe(false)
    expect(v.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('commands/ sits inside .claude-plugin/'),
      expect.stringContaining('leaves the plugin'),
    ]))
  })

  it('warns about a skill without frontmatter', () => {
    const dir = join(tmp, 'nofm')
    mkdirSync(join(dir, 'skills', 'raw'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'raw', 'SKILL.md'), '# Raw\nJust prose.\n')
    const v = validatePlugin(dir)
    expect(v.ok).toBe(true)
    expect(v.warnings).toEqual([expect.stringContaining('skills/raw/SKILL.md has no frontmatter')])
  })

  it('fails a path that is not a directory', () => {
    expect(validatePlugin(join(tmp, 'missing')).ok).toBe(false)
  })
})

describe('reserved marketplace names', () => {
  it('reserves exactly the official list, and notes look-alikes', () => {
    expect(impersonatesOfficial('claude-plugins-official')).toBe(true)
    expect(impersonatesOfficial('anthropic-agent-skills')).toBe(true)
    expect(impersonatesOfficial('claude-code-workflows')).toBe(false)
    expect(impersonatesOfficial('superpowers-marketplace')).toBe(false)
    expect(resemblesOfficial('my-anthropic-tools')).toBe(true)
    expect(resemblesOfficial('official-stuff')).toBe(true)
    expect(resemblesOfficial('claude-code-workflows')).toBe(false)
  })
})
