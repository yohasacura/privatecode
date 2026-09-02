import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { settingsText } from '../permissions/settings.js'
import { isRecord } from './manifest.js'

/**
 * `%APPDATA%\PrivateCode\plugins\` — Claude Code's `~/.claude/plugins/`, moved
 * (docs/PLUGINS-2026-09.md §2). Two JSON records and three directories:
 *
 *   known_marketplaces.json   which catalogs are registered and where their copy is
 *   installed_plugins.json    which plugins are installed, at which version, for which scopes
 *   marketplaces/<name>/      a clone, or a directory holding a fetched marketplace.json
 *   cache/<mkt>/<plugin>/<version>/   the plugin's files — ${CLAUDE_PLUGIN_ROOT}
 *   data/<plugin>@<mkt>/      what survives an update — ${CLAUDE_PLUGIN_DATA}
 *
 * The records are read tolerantly and written whole: a corrupt file is reported and treated
 * as empty rather than thrown on, because a broken record must never lock a person out of
 * the very command that would fix it.
 */

export type PluginScope = 'user' | 'project' | 'local'

/** How a marketplace was added — what `marketplace update` re-fetches from. */
export type MarketplaceSource =
  | { source: 'github'; repo: string; ref?: string }
  | { source: 'git'; url: string; ref?: string }
  /** A hosted marketplace.json, fetched over HTTP. */
  | { source: 'url'; url: string }
  /** A directory on this machine, read in place. */
  | { source: 'directory'; path: string }

export interface KnownMarketplace {
  name: string
  source: MarketplaceSource
  /** Where the copy lives: `marketplaces/<name>` (a clone or a fetched file), or the
   * directory itself for a local one. Absent until first fetched. */
  installLocation?: string
  lastUpdated?: string
  autoUpdate?: boolean
  /** Registered by PrivateCode itself on first run (docs §6), not by the person. */
  bundled?: boolean
}

export interface InstalledPlugin {
  /** `name@marketplace` */
  id: string
  name: string
  marketplace: string
  version: string
  installPath: string
  installedAt: string
  lastUpdated: string
  /** The commit the files came from, when a git source resolved one. */
  sha?: string
  /** Every scope it was installed for; a project or local scope names its workspace. */
  scopes: { scope: PluginScope; workspaceRoot?: string }[]
}

interface InstalledRecord { version: 2; plugins: Record<string, InstalledPlugin> }

export function pluginsDir(): string {
  const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'PrivateCode', 'plugins')
}

function readJson(path: string, problems: string[]): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(settingsText(readFileSync(path, 'utf8')))
    if (isRecord(parsed)) return parsed
    problems.push(`${path} is not a JSON object; treating it as empty`)
  } catch (e) {
    problems.push(`${path} is not valid JSON (${(e as Error).message}); treating it as empty`)
  }
  return null
}

/** Written to a sibling and renamed over, so a crash mid-write leaves the old record whole. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export class PluginStore {
  readonly root: string
  readonly problems: string[] = []

  constructor(root: string = pluginsDir()) {
    this.root = root
  }

  get marketplacesDir(): string { return join(this.root, 'marketplaces') }
  get cacheDir(): string { return join(this.root, 'cache') }
  get dataDir(): string { return join(this.root, 'data') }
  get knownFile(): string { return join(this.root, 'known_marketplaces.json') }
  get installedFile(): string { return join(this.root, 'installed_plugins.json') }

  ensure(): void {
    for (const d of [this.root, this.marketplacesDir, this.cacheDir, this.dataDir]) mkdirSync(d, { recursive: true })
  }

  // ---- marketplaces ----------------------------------------------------------------------------

  knownMarketplaces(): KnownMarketplace[] {
    const raw = readJson(this.knownFile, this.problems)
    if (raw === null) return []
    const out: KnownMarketplace[] = []
    for (const [name, entry] of Object.entries(raw)) {
      if (!isRecord(entry) || !isRecord(entry['source'])) { this.problems.push(`known_marketplaces.json: "${name}" is malformed; ignored`); continue }
      const s = entry['source']
      let source: MarketplaceSource | null = null
      if (s['source'] === 'github' && typeof s['repo'] === 'string') source = { source: 'github', repo: s['repo'], ...(typeof s['ref'] === 'string' ? { ref: s['ref'] } : {}) }
      else if (s['source'] === 'git' && typeof s['url'] === 'string') source = { source: 'git', url: s['url'], ...(typeof s['ref'] === 'string' ? { ref: s['ref'] } : {}) }
      else if (s['source'] === 'url' && typeof s['url'] === 'string') source = { source: 'url', url: s['url'] }
      else if (s['source'] === 'directory' && typeof s['path'] === 'string') source = { source: 'directory', path: s['path'] }
      if (source === null) { this.problems.push(`known_marketplaces.json: "${name}" has a source PrivateCode cannot read; ignored`); continue }
      const known: KnownMarketplace = { name, source }
      if (typeof entry['installLocation'] === 'string') known.installLocation = entry['installLocation']
      if (typeof entry['lastUpdated'] === 'string') known.lastUpdated = entry['lastUpdated']
      if (typeof entry['autoUpdate'] === 'boolean') known.autoUpdate = entry['autoUpdate']
      if (entry['bundled'] === true) known.bundled = true
      out.push(known)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  saveMarketplaces(list: readonly KnownMarketplace[]): void {
    const record: Record<string, unknown> = {}
    for (const m of list) {
      const { name, ...rest } = m
      record[name] = rest
    }
    writeJson(this.knownFile, record)
  }

  marketplace(name: string): KnownMarketplace | undefined {
    return this.knownMarketplaces().find((m) => m.name === name)
  }

  putMarketplace(entry: KnownMarketplace): void {
    const list = this.knownMarketplaces().filter((m) => m.name !== entry.name)
    this.saveMarketplaces([...list, entry])
  }

  dropMarketplace(name: string): void {
    this.saveMarketplaces(this.knownMarketplaces().filter((m) => m.name !== name))
  }

  /** `marketplaces/<name>` — where a fetched catalog lives. */
  marketplaceDir(name: string): string {
    return join(this.marketplacesDir, name)
  }

  // ---- installed plugins -------------------------------------------------------------------------

  installed(): InstalledPlugin[] {
    const raw = readJson(this.installedFile, this.problems)
    if (raw === null) return []
    const plugins = isRecord(raw['plugins']) ? raw['plugins'] : {}
    const out: InstalledPlugin[] = []
    for (const [id, entry] of Object.entries(plugins)) {
      if (!isRecord(entry) || typeof entry['installPath'] !== 'string' || typeof entry['version'] !== 'string') {
        this.problems.push(`installed_plugins.json: "${id}" is malformed; ignored`)
        continue
      }
      const at = id.lastIndexOf('@')
      const scopesRaw = Array.isArray(entry['scopes']) ? entry['scopes'] : []
      const scopes = scopesRaw
        .filter((s): s is Record<string, unknown> => isRecord(s) && (s['scope'] === 'user' || s['scope'] === 'project' || s['scope'] === 'local'))
        .map((s) => ({ scope: s['scope'] as PluginScope, ...(typeof s['workspaceRoot'] === 'string' ? { workspaceRoot: s['workspaceRoot'] } : {}) }))
      out.push({
        id,
        name: at === -1 ? id : id.slice(0, at),
        marketplace: at === -1 ? '' : id.slice(at + 1),
        version: entry['version'],
        installPath: entry['installPath'],
        installedAt: typeof entry['installedAt'] === 'string' ? entry['installedAt'] : '',
        lastUpdated: typeof entry['lastUpdated'] === 'string' ? entry['lastUpdated'] : '',
        ...(typeof entry['sha'] === 'string' ? { sha: entry['sha'] } : {}),
        scopes,
      })
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  saveInstalled(list: readonly InstalledPlugin[]): void {
    const record: InstalledRecord = { version: 2, plugins: {} }
    for (const p of list) {
      const { id, name: _n, marketplace: _m, ...rest } = p
      record.plugins[id] = { id, name: _n, marketplace: _m, ...rest }
    }
    writeJson(this.installedFile, record)
  }

  installedPlugin(id: string): InstalledPlugin | undefined {
    return this.installed().find((p) => p.id === id)
  }

  putInstalled(plugin: InstalledPlugin): void {
    this.saveInstalled([...this.installed().filter((p) => p.id !== plugin.id), plugin])
  }

  dropInstalled(id: string): void {
    this.saveInstalled(this.installed().filter((p) => p.id !== id))
  }

  /** `cache/<marketplace>/<plugin>/<version>` */
  cachePath(marketplace: string, plugin: string, version: string): string {
    return join(this.cacheDir, safeSegment(marketplace), safeSegment(plugin), safeSegment(version))
  }

  /** `data/<plugin>@<marketplace>` — ${CLAUDE_PLUGIN_DATA}. */
  dataPath(id: string): string {
    return join(this.dataDir, safeSegment(id))
  }
}

/** A name reduced to what can be a directory on every filesystem. */
export function safeSegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._@+-]/g, '_')
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned
}

/** `name@marketplace` → its two halves; a bare name has no marketplace. */
export function splitPluginId(id: string): { name: string; marketplace: string | null } {
  const at = id.lastIndexOf('@')
  if (at <= 0) return { name: id, marketplace: null }
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) }
}
