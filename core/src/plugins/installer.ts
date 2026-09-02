import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  describeSource, insidePlugin, inventory, readPluginManifest, validatePlugin,
  type MarketplaceEntry, type PluginInventory, type PluginManifest, type PluginSourceSpec,
} from './manifest.js'
import { ensureFetched, findEntry, readCatalog, type Catalog } from './marketplaces.js'
import { forgetPluginEnabled, loadPluginSettings, setPluginEnabled } from './settings.js'
import { cloneRepo, copyTree, fetchArchive, githubUrl, hashTree, headSha, isGitClone, removeTree, scratchDir, updateClone } from './sources.js'
import { splitPluginId, type InstalledPlugin, type PluginScope, type PluginStore } from './store.js'

/**
 * `/plugin install|uninstall|enable|disable|update|list` (docs/PLUGINS-2026-09.md §2–§4).
 *
 * An install is three things, in order: the plugin's files brought into
 * `cache/<marketplace>/<plugin>/<version>/`, a record in `installed_plugins.json`, and
 * `enabledPlugins["name@marketplace"]: true` in the settings file of the chosen scope. Enable
 * and disable touch only the third; uninstall undoes all three. The version is resolved as
 * Claude Code resolves it — the manifest's, else the catalog entry's, else the commit, else
 * a fingerprint of the files — so "update" means "that changed".
 */

export interface InstallOptions {
  scope?: PluginScope
  workspaceRoot?: string
  userPath?: string
  /** Re-fetch the marketplace before the lookup, as Claude Code does for `name@marketplace`. */
  refresh?: boolean
}

export interface InstallOutcome {
  id: string
  name: string
  marketplace: string
  version: string
  installPath: string
  scope: PluginScope
  enabled: boolean
  inventory: PluginInventory
  warnings: string[]
  /** Already installed at this version; only the scope (and enabled flag) changed. */
  alreadyInstalled: boolean
  renamedFrom?: string
}

/** Resolves a marketplace entry's files into `dest`. Returns what to call the version. */
async function materialize(
  store: PluginStore, catalog: Catalog, entry: MarketplaceEntry, dest: string,
): Promise<{ sha?: string; hash: string; manifest: PluginManifest | null; warnings: string[] }> {
  const source: PluginSourceSpec = entry.source
  const warnings: string[] = []
  let sha: string | undefined
  let stage: string | null = null
  let from: string
  if (typeof source === 'string') {
    if (catalog.dir === null) throw new Error(`"${entry.name}" points at a path inside its marketplace, but ${catalog.marketplace.name} was added from a hosted marketplace.json, which has no files. Add the repository instead.`)
    // `metadata.pluginRoot` is prepended to every relative source, `./x` included (Claude Code's rule).
    const root = catalog.manifest.metadata?.pluginRoot !== undefined
      ? insidePlugin(catalog.dir, catalog.manifest.metadata.pluginRoot)
      : catalog.dir
    if (root === null) throw new Error(`${catalog.marketplace.name}: metadata.pluginRoot leaves the marketplace`)
    const inside = insidePlugin(root, source)
    if (inside === null) throw new Error(`"${entry.name}": source ${source} leaves the marketplace`)
    if (!existsSync(inside)) throw new Error(`"${entry.name}": ${source} is not in the marketplace's copy (run /plugin marketplace update ${catalog.marketplace.name})`)
    from = inside
    if (catalog.marketplace.installLocation !== undefined && isGitClone(catalog.marketplace.installLocation)) {
      try { sha = await headSha(catalog.marketplace.installLocation) } catch { /* a clone git cannot read: no commit to name */ }
    }
  } else {
    stage = scratchDir(store.cacheDir)
    switch (source.source) {
      case 'github': {
        const cloned = await cloneRepo(githubUrl(source.repo), stage, { ...(source.ref !== undefined ? { ref: source.ref } : {}), ...(source.sha !== undefined ? { sha: source.sha } : {}) })
        sha = cloned.sha
        from = source.path !== undefined ? (insidePlugin(stage, source.path) ?? '') : stage
        break
      }
      case 'url': {
        const cloned = await cloneRepo(source.url, stage, { ...(source.ref !== undefined ? { ref: source.ref } : {}), ...(source.sha !== undefined ? { sha: source.sha } : {}) })
        sha = cloned.sha
        from = stage
        break
      }
      case 'git-subdir': {
        const cloned = await cloneRepo(source.url, stage, { ...(source.ref !== undefined ? { ref: source.ref } : {}), ...(source.sha !== undefined ? { sha: source.sha } : {}) })
        sha = cloned.sha
        from = insidePlugin(stage, source.path) ?? ''
        break
      }
      case 'archive':
        await fetchArchive(source.url, stage, source.sha256)
        from = stage
        break
      case 'npm':
      case 'command':
        throw new Error(`"${entry.name}" is distributed as ${describeSource(source)}; PrivateCode installs plugins from git, from a marketplace's own files and from archives, not from ${source.source} sources.`)
    }
    if (from === '' || !existsSync(from)) throw new Error(`"${entry.name}": the path inside its repository does not exist`)
  }
  try {
    const read = readPluginManifest(from)
    warnings.push(...read.problems)
    rmSync(dest, { recursive: true, force: true })
    copyTree(from, dest)
    return { ...(sha !== undefined ? { sha } : {}), hash: hashTree(dest), manifest: read.value, warnings }
  } finally {
    if (stage !== null) removeTree(stage)
  }
}

function versionOf(manifest: PluginManifest | null, entry: MarketplaceEntry, sha: string | undefined, hash: string): string {
  return manifest?.version ?? entry.version ?? (sha !== undefined ? sha.slice(0, 12) : hash)
}

/** Which registered catalogs list a plugin of this name. */
async function locate(store: PluginStore, name: string): Promise<{ catalogs: Catalog[]; problems: string[] }> {
  const catalogs: Catalog[] = []
  const problems: string[] = []
  for (const m of store.knownMarketplaces()) {
    const c = await ensureFetched(store, m.name)
    if ('error' in c) { problems.push(c.error); continue }
    const hit = findEntry(c.manifest, name)
    if (!('error' in hit)) catalogs.push(c)
  }
  return { catalogs, problems }
}

export async function installPlugin(store: PluginStore, spec: string, opts: InstallOptions = {}): Promise<InstallOutcome | { error: string }> {
  store.ensure()
  const scope = opts.scope ?? 'user'
  if (scope !== 'user' && opts.workspaceRoot === undefined) return { error: `The ${scope} scope needs an open workspace.` }
  const { name, marketplace } = splitPluginId(spec.trim())
  if (name === '') return { error: 'Say which plugin: /plugin install name@marketplace' }

  let catalog: Catalog
  if (marketplace !== null) {
    const fetched = await ensureFetched(store, marketplace)
    if ('error' in fetched) return fetched
    catalog = fetched
    if (opts.refresh !== false) {
      const loc = fetched.marketplace.installLocation
      if (loc !== undefined && isGitClone(loc)) {
        try { await updateClone(loc, fetched.marketplace.source.source === 'github' || fetched.marketplace.source.source === 'git' ? (fetched.marketplace.source.ref !== undefined ? { ref: fetched.marketplace.source.ref } : {}) : {}) } catch { /* offline: the cached catalog */ }
        const again = readCatalog(store, marketplace)
        if (!('error' in again)) catalog = again
      }
    }
  } else {
    const found = await locate(store, name)
    if (found.catalogs.length === 0) {
      return { error: `Plugin "${name}" not found in any marketplace you have added.${found.problems.length > 0 ? ` (${found.problems.join('; ')})` : ''}` }
    }
    if (found.catalogs.length > 1) {
      return { error: `"${name}" is in more than one marketplace: ${found.catalogs.map((c) => `${name}@${c.marketplace.name}`).join(', ')}. Say which.` }
    }
    catalog = found.catalogs[0]!
  }

  const hit = findEntry(catalog.manifest, name)
  if ('error' in hit) return hit
  const entry = hit.entry
  const id = `${entry.name}@${catalog.marketplace.name}`
  const existing = store.installedPlugin(id)

  // The files: staged, then judged by their version before they are kept.
  const stagePath = store.cachePath(catalog.marketplace.name, entry.name, '.installing')
  let staged
  try {
    staged = await materialize(store, catalog, entry, stagePath)
  } catch (e) {
    rmSync(stagePath, { recursive: true, force: true })
    return { error: e instanceof Error ? e.message : String(e) }
  }
  const version = versionOf(staged.manifest, entry, staged.sha, staged.hash)
  const installPath = store.cachePath(catalog.marketplace.name, entry.name, version)
  const alreadyInstalled = existing !== undefined && existing.version === version && existsSync(existing.installPath)
  if (alreadyInstalled) {
    rmSync(stagePath, { recursive: true, force: true })
  } else {
    rmSync(installPath, { recursive: true, force: true })
    copyTree(stagePath, installPath)
    rmSync(stagePath, { recursive: true, force: true })
  }

  const validation = validatePlugin(installPath, entry.name)
  if (!validation.ok) {
    if (!alreadyInstalled) rmSync(installPath, { recursive: true, force: true })
    return { error: `"${id}" failed validation: ${validation.errors.join('; ')}` }
  }
  const warnings = [...new Set([...staged.warnings, ...validation.warnings])]

  const now = new Date().toISOString()
  const scopes = existing?.scopes.filter((s) => !(s.scope === scope && (s.workspaceRoot ?? '') === (scope === 'user' ? '' : opts.workspaceRoot ?? ''))) ?? []
  scopes.push({ scope, ...(scope !== 'user' && opts.workspaceRoot !== undefined ? { workspaceRoot: opts.workspaceRoot } : {}) })
  const record: InstalledPlugin = {
    id, name: entry.name, marketplace: catalog.marketplace.name, version, installPath,
    installedAt: existing?.installedAt ?? now, lastUpdated: now,
    ...(staged.sha !== undefined ? { sha: staged.sha } : {}),
    scopes,
  }
  if (existing !== undefined && !alreadyInstalled && existing.installPath !== installPath) {
    rmSync(existing.installPath, { recursive: true, force: true })
  }
  store.putInstalled(record)
  const enabled = entry.defaultEnabled ?? staged.manifest?.defaultEnabled ?? true
  setPluginEnabled(scope, opts.workspaceRoot, id, enabled, opts.userPath)

  return {
    id, name: entry.name, marketplace: catalog.marketplace.name, version, installPath, scope, enabled,
    inventory: validation.inventory, warnings, alreadyInstalled,
    ...(hit.renamedFrom !== undefined ? { renamedFrom: hit.renamedFrom } : {}),
  }
}

export interface ScopeOptions { scope?: PluginScope; workspaceRoot?: string; userPath?: string }

/** The scope a bare `enable`/`disable`/`uninstall` means: the most specific one the plugin is installed for. */
function pickScope(plugin: InstalledPlugin, opts: ScopeOptions): PluginScope {
  if (opts.scope !== undefined) return opts.scope
  const here = plugin.scopes.filter((s) => s.scope === 'user' || s.workspaceRoot === opts.workspaceRoot)
  if (here.some((s) => s.scope === 'local')) return 'local'
  if (here.some((s) => s.scope === 'project')) return 'project'
  return 'user'
}

/** `name@marketplace`, or a bare name when exactly one installed plugin has it. */
export function resolveInstalledId(store: PluginStore, spec: string): InstalledPlugin | { error: string } {
  const { name, marketplace } = splitPluginId(spec.trim())
  const all = store.installed()
  if (marketplace !== null) {
    const found = all.find((p) => p.id === `${name}@${marketplace}`)
    return found ?? { error: `"${spec}" is not installed.` }
  }
  const matches = all.filter((p) => p.name === name)
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) return { error: `"${name}" is not installed.` }
  return { error: `"${name}" is installed from ${matches.length} marketplaces: ${matches.map((m) => m.id).join(', ')}. Say which.` }
}

export function uninstallPlugin(store: PluginStore, spec: string, opts: ScopeOptions & { keepData?: boolean } = {}): { id: string; scope: PluginScope; removedFiles: boolean } | { error: string } {
  const plugin = resolveInstalledId(store, spec)
  if ('error' in plugin) return plugin
  const scope = pickScope(plugin, opts)
  if (scope !== 'user' && opts.workspaceRoot === undefined) return { error: `The ${scope} scope needs an open workspace.` }
  const remaining = plugin.scopes.filter((s) => !(s.scope === scope && (s.scope === 'user' || s.workspaceRoot === opts.workspaceRoot)))
  try { forgetPluginEnabled(scope, opts.workspaceRoot, plugin.id, opts.userPath) } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
  let removedFiles = false
  if (remaining.length === 0) {
    rmSync(plugin.installPath, { recursive: true, force: true })
    if (opts.keepData !== true) rmSync(store.dataPath(plugin.id), { recursive: true, force: true })
    store.dropInstalled(plugin.id)
    removedFiles = true
  } else {
    store.putInstalled({ ...plugin, scopes: remaining })
  }
  return { id: plugin.id, scope, removedFiles }
}

export function setEnabled(store: PluginStore, spec: string, enabled: boolean, opts: ScopeOptions = {}): { id: string; scope: PluginScope; path: string } | { error: string } {
  const plugin = resolveInstalledId(store, spec)
  if ('error' in plugin) return plugin
  const scope = pickScope(plugin, opts)
  if (scope !== 'user' && opts.workspaceRoot === undefined) return { error: `The ${scope} scope needs an open workspace.` }
  try {
    const path = setPluginEnabled(scope, opts.workspaceRoot, plugin.id, enabled, opts.userPath)
    return { id: plugin.id, scope, path }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function updatePlugin(store: PluginStore, spec: string, opts: ScopeOptions = {}): Promise<{ id: string; from: string; to: string; changed: boolean; warnings: string[] } | { error: string }> {
  const plugin = resolveInstalledId(store, spec)
  if ('error' in plugin) return plugin
  const scope = pickScope(plugin, opts)
  const before = plugin.version
  const result = await installPlugin(store, plugin.id, { scope, ...(opts.workspaceRoot !== undefined ? { workspaceRoot: opts.workspaceRoot } : {}), ...(opts.userPath !== undefined ? { userPath: opts.userPath } : {}), refresh: true })
  if ('error' in result) return result
  return { id: plugin.id, from: before, to: result.version, changed: result.version !== before, warnings: result.warnings }
}

// ---- what is on, for a workspace --------------------------------------------------------------------

export interface EffectivePlugin extends InstalledPlugin {
  enabled: boolean
  /** Where the enabling (or disabling) setting came from. */
  decidedBy: string | null
  manifest: PluginManifest | null
  inventory: PluginInventory
  problems: string[]
}

export interface EffectivePlugins {
  plugins: EffectivePlugin[]
  /** Enabled in a settings file but not installed — the install command to run. */
  declared: { id: string; from: string }[]
  problems: string[]
}

export function effectivePlugins(store: PluginStore, workspaceRoot: string | undefined, userPath?: string): EffectivePlugins {
  const settings = loadPluginSettings(workspaceRoot, userPath)
  const installed = store.installed()
  const decidedBy = new Map<string, string>()
  for (const layer of settings.layers) for (const id of Object.keys(layer.enabledPlugins)) decidedBy.set(id, layer.path)
  const plugins: EffectivePlugin[] = installed
    .filter((p) => p.scopes.some((s) => s.scope === 'user' || s.workspaceRoot === workspaceRoot))
    .map((p) => {
      const manifest = existsSync(p.installPath) ? readPluginManifest(p.installPath) : { value: null, problems: [`${p.installPath} is missing — reinstall with /plugin install ${p.id}`] }
      const inv = existsSync(p.installPath) ? inventory(p.installPath, manifest.value, p.name) : { skills: [], commands: [], agents: [], hooks: [], mcpServers: [], unsupported: [], problems: [] }
      const setting = settings.enabledPlugins[p.id]
      return {
        ...p,
        enabled: setting ?? false,
        decidedBy: decidedBy.get(p.id) ?? null,
        manifest: manifest.value,
        inventory: inv,
        problems: [...manifest.problems, ...inv.problems],
      }
    })
  const known = new Set(installed.map((p) => p.id))
  const declared = settings.layers.flatMap((layer) =>
    Object.entries(layer.enabledPlugins).filter(([id, on]) => on && !known.has(id)).map(([id]) => ({ id, from: layer.path })))
  return { plugins, declared: dedupe(declared), problems: [...settings.problems, ...store.problems] }
}

function dedupe(list: { id: string; from: string }[]): { id: string; from: string }[] {
  const seen = new Set<string>()
  return list.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)))
}

/** `${CLAUDE_PLUGIN_ROOT}` for an installed plugin, and its data directory. */
export function pluginPaths(store: PluginStore, plugin: InstalledPlugin): { root: string; data: string } {
  return { root: resolve(plugin.installPath), data: join(store.dataPath(plugin.id)) }
}
