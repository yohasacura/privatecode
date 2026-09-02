import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  impersonatesOfficial, KEBAB, marketplaceManifestPath, parseMarketplaceManifest, readMarketplaceManifest, resemblesOfficial,
  type MarketplaceEntry, type MarketplaceManifest,
} from './manifest.js'
import { addKnownMarketplaceSetting, forgetKnownMarketplaceSetting, loadPluginSettings } from './settings.js'
import {
  cloneRepo, describeMarketplaceSource, fetchText, githubUrl, isGitClone, parseMarketplaceSource, removeTree, scratchDir, updateClone,
} from './sources.js'
import type { KnownMarketplace, MarketplaceSource, PluginScope, PluginStore } from './store.js'
import { settingsText } from '../permissions/settings.js'
import { isRecord } from './manifest.js'

/**
 * The marketplace registry: `/plugin marketplace add|list|remove|update`, and the catalogs
 * PrivateCode registers on its own (docs/PLUGINS-2026-09.md §3, §6).
 *
 * A marketplace is fetched into `marketplaces/<name>/` — a clone for a repository, a lone
 * `marketplace.json` for a hosted file, nothing at all for a local directory, which is read
 * where it is. Its name is whatever its manifest says, which is why a fetch lands in a
 * scratch directory first: the name is not known until the file is read.
 */

/** Registered the first time the store exists (§6). Fetched lazily, on first use. */
export const DEFAULT_MARKETPLACES: readonly { name: string; source: MarketplaceSource; why: string }[] = [
  { name: 'claude-plugins-official', source: { source: 'github', repo: 'anthropics/claude-plugins-official' }, why: "Anthropic's curated catalog; every entry pinned to a commit" },
  { name: 'claude-community', source: { source: 'github', repo: 'anthropics/claude-plugins-community' }, why: "Anthropic's community catalog; screened, every entry pinned to a commit" },
  { name: 'claude-code-plugins', source: { source: 'github', repo: 'anthropics/claude-code' }, why: "Anthropic's example plugins: commit-commands, code-review, feature-dev, security-guidance" },
  { name: 'anthropic-agent-skills', source: { source: 'github', repo: 'anthropics/skills' }, why: "Anthropic's document skills (docx, pptx, xlsx, pdf) and examples" },
]

/** Offered with one click, never registered unasked: third-party code, however popular (§6). */
export const SUGGESTED_MARKETPLACES: readonly { name: string; source: MarketplaceSource; why: string }[] = [
  { name: 'superpowers-marketplace', source: { source: 'github', repo: 'obra/superpowers-marketplace' }, why: "Jesse Vincent's curated set: superpowers, episodic memory, Chrome, session driver" },
  { name: 'claude-code-workflows', source: { source: 'github', repo: 'wshobson/agents' }, why: '92 workflow plugins with 200 agents and 180 skills, all in one repository, MIT/Apache' },
]

/** Whether a source is one of Anthropic's own repositories — the only place a reserved name may come from. */
function anthropicSource(source: MarketplaceSource): boolean {
  if (source.source === 'github') return /^anthropics\//i.test(source.repo)
  if (source.source === 'git') return /^https:\/\/github\.com\/anthropics\//i.test(source.url)
  if (source.source === 'url') return /^https:\/\/(raw\.githubusercontent\.com|github\.com)\/anthropics\//i.test(source.url)
  return false
}

export function sameSource(a: MarketplaceSource, b: MarketplaceSource): boolean {
  if (a.source !== b.source) return false
  switch (a.source) {
    case 'github': return a.repo.toLowerCase() === (b as typeof a).repo.toLowerCase() && a.ref === (b as typeof a).ref
    case 'git': return a.url === (b as typeof a).url && a.ref === (b as typeof a).ref
    case 'url': return a.url === (b as typeof a).url
    case 'directory': return resolve(a.path).toLowerCase() === resolve((b as typeof a).path).toLowerCase()
  }
}

export interface Catalog {
  marketplace: KnownMarketplace
  manifest: MarketplaceManifest
  /** The directory relative plugin sources resolve against; null for a hosted file. */
  dir: string | null
  problems: string[]
}

/** Registers the defaults that are not yet known. Returns the names it added. */
export function ensureDefaultMarketplaces(store: PluginStore): string[] {
  store.ensure()
  const known = new Set(store.knownMarketplaces().map((m) => m.name))
  const added: string[] = []
  for (const d of DEFAULT_MARKETPLACES) {
    if (known.has(d.name)) continue
    store.putMarketplace({ name: d.name, source: d.source, autoUpdate: true, bundled: true })
    added.push(d.name)
  }
  return added
}

/** The catalog file of a registered marketplace, wherever its copy lives. */
export function catalogPath(m: KnownMarketplace): string | null {
  if (m.source.source === 'directory') return marketplaceManifestPath(m.source.path)
  if (m.installLocation === undefined) return null
  if (m.source.source === 'url') return join(m.installLocation, 'marketplace.json')
  return marketplaceManifestPath(m.installLocation)
}

/** Reads a registered marketplace's catalog from its local copy. Null when never fetched. */
export function readCatalog(store: PluginStore, name: string): Catalog | { error: string } {
  const m = store.marketplace(name)
  if (m === undefined) return { error: `Marketplace "${name}" not found. Add it with /plugin marketplace add <source>.` }
  const file = catalogPath(m)
  if (file === null || !existsSync(file)) return { error: `Marketplace "${name}" has not been fetched yet. Run /plugin marketplace update ${name}.` }
  const read = readMarketplaceManifest(file)
  if (read.value === null) return { error: `Marketplace "${name}" could not be read: ${read.problems.join('; ')}` }
  const dir = m.source.source === 'url' ? null : (m.source.source === 'directory' ? m.source.path : m.installLocation ?? null)
  return { marketplace: m, manifest: read.value, dir, problems: read.problems }
}

/** The entry for `pluginName`, following the catalog's renames. */
export function findEntry(manifest: MarketplaceManifest, pluginName: string): { entry: MarketplaceEntry; renamedFrom?: string } | { error: string } {
  const direct = manifest.plugins.find((p) => p.name === pluginName)
  if (direct !== undefined) return { entry: direct }
  const renamed = manifest.renames?.[pluginName]
  if (renamed === null) return { error: `"${pluginName}" was removed from ${manifest.name}.` }
  if (renamed !== undefined) {
    const target = manifest.plugins.find((p) => p.name === renamed)
    if (target !== undefined) return { entry: target, renamedFrom: pluginName }
  }
  return { error: `Plugin "${pluginName}" not found in marketplace "${manifest.name}".` }
}

async function fetchInto(source: MarketplaceSource, scratch: string): Promise<{ manifestFile: string; sha?: string }> {
  switch (source.source) {
    case 'github': {
      const { sha } = await cloneRepo(githubUrl(source.repo), scratch, source.ref !== undefined ? { ref: source.ref } : {})
      return { manifestFile: marketplaceManifestPath(scratch), sha }
    }
    case 'git': {
      const { sha } = await cloneRepo(source.url, scratch, source.ref !== undefined ? { ref: source.ref } : {})
      return { manifestFile: marketplaceManifestPath(scratch), sha }
    }
    case 'url': {
      const text = await fetchText(source.url)
      let parsed: unknown
      try { parsed = JSON.parse(settingsText(text)) } catch (e) { throw new Error(`${source.url} is not valid JSON: ${(e as Error).message}`) }
      if (!isRecord(parsed)) throw new Error(`${source.url} is not a JSON object`)
      mkdirSync(scratch, { recursive: true })
      const file = join(scratch, 'marketplace.json')
      writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
      return { manifestFile: file }
    }
    case 'directory':
      return { manifestFile: marketplaceManifestPath(source.path) }
  }
}

export interface AddOptions {
  scope?: PluginScope
  workspaceRoot?: string
  /** Where a relative path is resolved from. */
  cwd?: string
  userPath?: string
  /** A name PrivateCode registers itself may be reserved; a person's may not. */
  bundled?: boolean
}

export interface AddOutcome {
  marketplace: KnownMarketplace
  manifest: MarketplaceManifest
  problems: string[]
  /** It was already registered from the same place; the copy was refreshed. */
  refreshed: boolean
}

/**
 * `/plugin marketplace add <source>`: fetch, read the name, refuse an impersonation, keep the
 * copy under its name, record it — and, for the project and local scopes, write it into the
 * settings file so a teammate's window registers it too.
 */
export async function addMarketplace(store: PluginStore, text: string | MarketplaceSource, opts: AddOptions = {}): Promise<AddOutcome | { error: string }> {
  store.ensure()
  const parsed = typeof text === 'string' ? parseMarketplaceSource(text, opts.cwd ?? process.cwd()) : { source: text }
  if ('error' in parsed) return parsed
  const source = parsed.source
  const scratch = source.source === 'directory' ? null : scratchDir(store.marketplacesDir)
  try {
    const fetched = await fetchInto(source, scratch ?? '')
    const read = readMarketplaceManifest(fetched.manifestFile)
    if (read.value === null) return { error: `${describeMarketplaceSource(source)} has no readable marketplace: ${read.problems.join('; ')}` }
    const manifest = read.value
    const name = manifest.name
    if (!KEBAB.test(name)) return { error: `The marketplace calls itself "${name}", which is not a kebab-case name.` }
    if (!opts.bundled && !anthropicSource(source) && impersonatesOfficial(name)) {
      return { error: `"${name}" is a name reserved for Anthropic's own marketplaces; this one comes from ${describeMarketplaceSource(source)}.` }
    }
    const problems = [...read.problems]
    if (!opts.bundled && !anthropicSource(source) && resemblesOfficial(name)) {
      problems.push(`the name "${name}" resembles an official Anthropic marketplace, but this catalog comes from ${describeMarketplaceSource(source)}`)
    }
    const existing = store.marketplace(name)
    let refreshed = false
    if (existing !== undefined) {
      if (!sameSource(existing.source, source)) {
        return { error: `A marketplace named "${name}" is already registered from ${describeMarketplaceSource(existing.source)}. Remove it first: /plugin marketplace remove ${name}` }
      }
      refreshed = true
    }
    const dest = store.marketplaceDir(name)
    if (scratch !== null) {
      removeTree(dest)
      renameSync(scratch, dest)
    }
    const record: KnownMarketplace = {
      name, source,
      installLocation: source.source === 'directory' ? source.path : dest,
      lastUpdated: new Date().toISOString(),
      autoUpdate: existing?.autoUpdate ?? (opts.bundled === true),
      ...(opts.bundled === true || existing?.bundled === true ? { bundled: true } : {}),
    }
    store.putMarketplace(record)
    const scope = opts.scope ?? 'user'
    if (scope !== 'user') addKnownMarketplaceSetting(scope, opts.workspaceRoot, name, source, opts.userPath)
    return { marketplace: record, manifest, problems, refreshed }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  } finally {
    if (scratch !== null) removeTree(scratch)
  }
}

/** Fetches a registered marketplace that has never been fetched (a bundled default). */
export async function ensureFetched(store: PluginStore, name: string): Promise<Catalog | { error: string }> {
  const m = store.marketplace(name)
  if (m === undefined) return { error: `Marketplace "${name}" not found. Add it with /plugin marketplace add <source>.` }
  const file = catalogPath(m)
  if (file !== null && existsSync(file)) return readCatalog(store, name)
  const added = await addMarketplace(store, m.source, { bundled: m.bundled === true })
  if ('error' in added) return { error: `Marketplace "${name}" could not be fetched: ${added.error}` }
  return readCatalog(store, name)
}

export interface UpdateOutcome { name: string; changed: boolean; plugins: number; problems: string[] }

/** `/plugin marketplace update <name>`: bring the copy up to date. */
export async function updateMarketplace(store: PluginStore, name: string): Promise<UpdateOutcome | { error: string }> {
  const m = store.marketplace(name)
  if (m === undefined) return { error: `Marketplace "${name}" not found.` }
  const file = catalogPath(m)
  if (file === null || !existsSync(file)) {
    const fetched = await ensureFetched(store, name)
    if ('error' in fetched) return fetched
    return { name, changed: true, plugins: fetched.manifest.plugins.length, problems: fetched.problems }
  }
  try {
    let changed = false
    if ((m.source.source === 'github' || m.source.source === 'git') && m.installLocation !== undefined && isGitClone(m.installLocation)) {
      const result = await updateClone(m.installLocation, m.source.ref !== undefined ? { ref: m.source.ref } : {})
      changed = result.changed
    } else if (m.source.source === 'url' && m.installLocation !== undefined) {
      const before = existsSync(file) ? readMarketplaceManifest(file) : null
      const text = await fetchText(m.source.url)
      const parsed: unknown = JSON.parse(settingsText(text))
      if (!isRecord(parsed)) return { error: `${m.source.url} is not a JSON object` }
      const check = parseMarketplaceManifest(parsed, m.source.url)
      if (check.value === null) return { error: check.problems.join('; ') }
      writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
      changed = JSON.stringify(before?.value) !== JSON.stringify(check.value)
    }
    store.putMarketplace({ ...m, lastUpdated: new Date().toISOString() })
    const catalog = readCatalog(store, name)
    if ('error' in catalog) return catalog
    return { name, changed, plugins: catalog.manifest.plugins.length, problems: catalog.problems }
  } catch (e) {
    return { error: `Marketplace "${name}" could not be updated: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * `/plugin marketplace remove <name>`. The caller uninstalls the plugins that came from it
 * first — Claude Code's rule, stated in its warning — then the copy and the record go.
 */
export function removeMarketplace(store: PluginStore, name: string, opts: { workspaceRoot?: string; userPath?: string } = {}): { removedCopy: boolean } | { error: string } {
  const m = store.marketplace(name)
  if (m === undefined) return { error: `Marketplace "${name}" not found.` }
  let removedCopy = false
  const inStore = m.installLocation !== undefined && resolve(m.installLocation).toLowerCase().startsWith(resolve(store.marketplacesDir).toLowerCase())
  if (inStore && m.installLocation !== undefined) {
    removeTree(m.installLocation)
    removedCopy = true
  }
  store.dropMarketplace(name)
  for (const scope of ['user', 'project', 'local'] as const) {
    try { forgetKnownMarketplaceSetting(scope, opts.workspaceRoot, name, opts.userPath) } catch { /* no workspace for that scope */ }
  }
  return { removedCopy }
}

/**
 * Marketplaces a settings file declares (`extraKnownMarketplaces`) that the store does not
 * know yet — registered as records so `install` can fetch them, exactly as Claude Code adds
 * a team's marketplaces once the folder is trusted.
 */
export function adoptDeclaredMarketplaces(store: PluginStore, workspaceRoot: string | undefined, userPath?: string): { added: string[]; problems: string[] } {
  const settings = loadPluginSettings(workspaceRoot, userPath)
  const known = new Map(store.knownMarketplaces().map((m) => [m.name, m]))
  const added: string[] = []
  for (const [name, entry] of Object.entries(settings.extraKnownMarketplaces)) {
    if (known.has(name)) continue
    if (!KEBAB.test(name)) { settings.problems.push(`${entry.from}: marketplace name "${name}" is not kebab-case; ignored`); continue }
    if (!anthropicSource(entry.source) && impersonatesOfficial(name)) { settings.problems.push(`${entry.from}: "${name}" is a reserved marketplace name; ignored`); continue }
    store.putMarketplace({ name, source: entry.source, ...(entry.autoUpdate !== undefined ? { autoUpdate: entry.autoUpdate } : {}) })
    added.push(name)
  }
  return { added, problems: settings.problems }
}

/** Whether the marketplace's catalog is on this machine. */
export function isFetched(m: KnownMarketplace): boolean {
  const file = catalogPath(m)
  return file !== null && existsSync(file)
}

export function marketplaceLabel(m: KnownMarketplace): string {
  return `${m.name}  ${describeMarketplaceSource(m.source)}${m.bundled === true ? '  (bundled)' : ''}${isFetched(m) ? '' : '  (not fetched yet)'}`
}
