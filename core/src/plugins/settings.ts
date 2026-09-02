import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { localSettingsPath, projectSettingsPath, settingsText, userSettingsPath } from '../permissions/settings.js'
import { isRecord } from './manifest.js'
import type { MarketplaceSource, PluginScope } from './store.js'

/**
 * The two settings keys of Claude Code's plugin system, `enabledPlugins` and
 * `extraKnownMarketplaces`, read from every settings file that may carry them and written
 * to PrivateCode's own (docs/PLUGINS-2026-09.md §2).
 *
 * Read from six files, in precedence order: PrivateCode's user, project and local files, and
 * their Claude Code twins (`~/.claude/settings.json`, `.claude/settings.json`,
 * `.claude/settings.local.json`) — so a README that says "add this to `.claude/settings.json`"
 * works. Written only to PrivateCode's three: this tool does not edit another tool's files.
 *
 * Other keys in a file are preserved byte-for-byte in meaning (the file is re-serialised,
 * pretty-printed, with the same top-level keys) — the permissions lists, hooks and MCP servers
 * that live beside these keys are not this module's to touch.
 */

export interface PluginSettingsLayer {
  scope: PluginScope
  /** `privatecode` for our own files, `claude` for Claude Code's. */
  owner: 'privatecode' | 'claude'
  path: string
  enabledPlugins: Record<string, boolean>
  extraKnownMarketplaces: Record<string, { source: MarketplaceSource; autoUpdate?: boolean }>
}

/** `~/.claude` (or `CLAUDE_CONFIG_DIR`), where Claude Code keeps its user files. */
export function claudeConfigDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? join(process.env['USERPROFILE'] ?? homedir(), '.claude')
}

export function settingsFileFor(scope: PluginScope, workspaceRoot: string | undefined, userPath = userSettingsPath()): string {
  if (scope === 'user') return userPath
  if (workspaceRoot === undefined) throw new Error(`the ${scope} scope needs an open workspace`)
  return scope === 'project' ? projectSettingsPath(workspaceRoot) : localSettingsPath(workspaceRoot)
}

/** The Claude Code file that mirrors ours for a scope. */
export function claudeSettingsFileFor(scope: PluginScope, workspaceRoot: string | undefined): string | null {
  if (scope === 'user') return join(claudeConfigDir(), 'settings.json')
  if (workspaceRoot === undefined) return null
  return join(workspaceRoot, '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json')
}

function readObject(path: string, problems: string[]): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(settingsText(readFileSync(path, 'utf8')))
    return isRecord(parsed) ? parsed : null
  } catch (e) {
    problems.push(`${path} is not valid JSON: ${(e as Error).message}`)
    return null
  }
}

export function readMarketplaceSource(raw: unknown): MarketplaceSource | null {
  if (!isRecord(raw)) return null
  const s = raw['source']
  if (s === 'github' && typeof raw['repo'] === 'string') return { source: 'github', repo: raw['repo'], ...(typeof raw['ref'] === 'string' ? { ref: raw['ref'] } : {}) }
  if ((s === 'git' || s === 'url') && typeof raw['url'] === 'string') {
    const url = raw['url']
    // Claude Code's `url` entry means "a git URL"; a bare marketplace.json URL is the `url`
    // form of OUR record. The file name decides.
    if (/marketplace\.json(?:[#?].*)?$/i.test(url)) return { source: 'url', url }
    return { source: 'git', url, ...(typeof raw['ref'] === 'string' ? { ref: raw['ref'] } : {}) }
  }
  if ((s === 'directory' || s === 'local' || s === 'file') && typeof raw['path'] === 'string') return { source: 'directory', path: raw['path'] }
  return null
}

function readLayer(scope: PluginScope, owner: PluginSettingsLayer['owner'], path: string, problems: string[]): PluginSettingsLayer {
  const layer: PluginSettingsLayer = { scope, owner, path, enabledPlugins: {}, extraKnownMarketplaces: {} }
  const obj = readObject(path, problems)
  if (obj === null) return layer
  const enabled = obj['enabledPlugins']
  if (enabled !== undefined) {
    if (isRecord(enabled)) {
      for (const [id, on] of Object.entries(enabled)) {
        if (typeof on === 'boolean') layer.enabledPlugins[id] = on
        else problems.push(`${path}: enabledPlugins["${id}"] must be true or false; ignored`)
      }
    } else {
      problems.push(`${path}: "enabledPlugins" must be an object; ignored`)
    }
  }
  const extra = obj['extraKnownMarketplaces']
  if (extra !== undefined) {
    if (isRecord(extra)) {
      for (const [name, entry] of Object.entries(extra)) {
        if (!isRecord(entry)) { problems.push(`${path}: extraKnownMarketplaces["${name}"] must be an object; ignored`); continue }
        const source = readMarketplaceSource(entry['source'])
        if (source === null) { problems.push(`${path}: extraKnownMarketplaces["${name}"].source is not a source PrivateCode can read; ignored`); continue }
        layer.extraKnownMarketplaces[name] = { source, ...(typeof entry['autoUpdate'] === 'boolean' ? { autoUpdate: entry['autoUpdate'] } : {}) }
      }
    } else {
      problems.push(`${path}: "extraKnownMarketplaces" must be an object; ignored`)
    }
  }
  return layer
}

export interface PluginSettings {
  layers: PluginSettingsLayer[]
  problems: string[]
  /** The merged view: later layers override earlier ones, exactly as permissions do. */
  enabledPlugins: Record<string, boolean>
  extraKnownMarketplaces: Record<string, { source: MarketplaceSource; autoUpdate?: boolean; from: string }>
}

/**
 * Every layer, lowest precedence first: user, then project, then local; within a scope
 * Claude Code's file first, then ours, so ours wins when both name the same plugin.
 */
export function loadPluginSettings(workspaceRoot: string | undefined, userPath = userSettingsPath()): PluginSettings {
  const problems: string[] = []
  const layers: PluginSettingsLayer[] = []
  const push = (scope: PluginScope): void => {
    const claude = claudeSettingsFileFor(scope, workspaceRoot)
    if (claude !== null) layers.push(readLayer(scope, 'claude', claude, problems))
    try {
      layers.push(readLayer(scope, 'privatecode', settingsFileFor(scope, workspaceRoot, userPath), problems))
    } catch { /* no workspace: no project or local layer */ }
  }
  push('user')
  if (workspaceRoot !== undefined) { push('project'); push('local') }
  const enabledPlugins: Record<string, boolean> = {}
  const extraKnownMarketplaces: PluginSettings['extraKnownMarketplaces'] = {}
  for (const layer of layers) {
    Object.assign(enabledPlugins, layer.enabledPlugins)
    for (const [name, entry] of Object.entries(layer.extraKnownMarketplaces)) extraKnownMarketplaces[name] = { ...entry, from: layer.path }
  }
  return { layers, problems, enabledPlugins, extraKnownMarketplaces }
}

/** Rewrites one of OUR settings files with `mutate` applied to its parsed object. */
function patchSettings(path: string, mutate: (obj: Record<string, unknown>) => void): void {
  const problems: string[] = []
  const obj = readObject(path, problems) ?? {}
  if (problems.length > 0) throw new Error(`${problems[0]} — fix the file before changing plugin settings in it`)
  mutate(obj)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
}

export function setPluginEnabled(scope: PluginScope, workspaceRoot: string | undefined, id: string, enabled: boolean, userPath = userSettingsPath()): string {
  const path = settingsFileFor(scope, workspaceRoot, userPath)
  patchSettings(path, (obj) => {
    const map = isRecord(obj['enabledPlugins']) ? obj['enabledPlugins'] : {}
    map[id] = enabled
    obj['enabledPlugins'] = map
  })
  return path
}

export function forgetPluginEnabled(scope: PluginScope, workspaceRoot: string | undefined, id: string, userPath = userSettingsPath()): string {
  const path = settingsFileFor(scope, workspaceRoot, userPath)
  if (!existsSync(path)) return path
  patchSettings(path, (obj) => {
    if (!isRecord(obj['enabledPlugins'])) return
    delete obj['enabledPlugins'][id]
    if (Object.keys(obj['enabledPlugins']).length === 0) delete obj['enabledPlugins']
  })
  return path
}

export function addKnownMarketplaceSetting(scope: PluginScope, workspaceRoot: string | undefined, name: string, source: MarketplaceSource, userPath = userSettingsPath()): string {
  const path = settingsFileFor(scope, workspaceRoot, userPath)
  patchSettings(path, (obj) => {
    const map = isRecord(obj['extraKnownMarketplaces']) ? obj['extraKnownMarketplaces'] : {}
    map[name] = { source }
    obj['extraKnownMarketplaces'] = map
  })
  return path
}

export function forgetKnownMarketplaceSetting(scope: PluginScope, workspaceRoot: string | undefined, name: string, userPath = userSettingsPath()): string {
  const path = settingsFileFor(scope, workspaceRoot, userPath)
  if (!existsSync(path)) return path
  patchSettings(path, (obj) => {
    if (!isRecord(obj['extraKnownMarketplaces'])) return
    delete obj['extraKnownMarketplaces'][name]
    if (Object.keys(obj['extraKnownMarketplaces']).length === 0) delete obj['extraKnownMarketplaces']
  })
  return path
}
