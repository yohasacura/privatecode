import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { settingsText } from '../permissions/settings.js'

/**
 * The two manifests of Claude Code's plugin system, read as Claude Code reads them
 * (docs/PLUGINS-2026-09.md §1, §4): `.claude-plugin/plugin.json` inside a plugin and
 * `.claude-plugin/marketplace.json` inside a marketplace. Nothing here fetches anything —
 * these are readers over a directory that already exists, and validators that say what is
 * wrong with it in the words `claude plugin validate` would use.
 *
 * Tolerant in the way every settings reader in this codebase is: a field of the wrong type
 * is a problem string and a safe default, never a throw. The one exception is a manifest
 * that is not JSON at all, which is reported as the single problem it is.
 */

// ---- shapes ---------------------------------------------------------------------------------

export interface PersonRef { name: string; email?: string; url?: string }

/** Where a plugin entry's files come from. The string form is a path inside the marketplace. */
export type PluginSourceSpec =
  | string
  | { source: 'github'; repo: string; ref?: string; sha?: string; path?: string }
  | { source: 'url'; url: string; ref?: string; sha?: string }
  | { source: 'git-subdir'; url: string; path: string; ref?: string; sha?: string }
  | { source: 'archive'; url: string; sha256?: string }
  | { source: 'npm'; package: string; version?: string; registry?: string }
  | { source: 'command'; command: string; timeout?: number; mode?: string }

/** The component paths a manifest or a marketplace entry may point at. */
export interface ComponentPaths {
  skills?: string | string[]
  commands?: string | string[]
  agents?: string | string[]
  hooks?: string | string[] | Record<string, unknown>
  mcpServers?: string | string[] | Record<string, unknown>
  lspServers?: string | string[] | Record<string, unknown>
}

export interface MarketplaceEntry extends ComponentPaths {
  name: string
  source: PluginSourceSpec
  displayName?: string
  description?: string
  version?: string
  author?: PersonRef
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  category?: string
  tags?: string[]
  /** Whether `plugin.json` is the authority (default true). */
  strict?: boolean
  defaultEnabled?: boolean
}

export interface MarketplaceManifest {
  name: string
  owner: PersonRef
  description?: string
  version?: string
  metadata?: { pluginRoot?: string; version?: string; description?: string }
  plugins: MarketplaceEntry[]
  /** Former name → current name, or null for a plugin that was removed. */
  renames?: Record<string, string | null>
}

export interface PluginManifest extends ComponentPaths {
  name: string
  displayName?: string
  version?: string
  description?: string
  author?: PersonRef
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  defaultEnabled?: boolean
  /** Declared and ignored here; named in the validation report so nobody wonders. */
  unsupported: string[]
}

export interface ReadResult<T> { value: T | null; problems: string[] }

// ---- helpers ---------------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** kebab-case: what Claude Code accepts for a plugin or marketplace name. */
export const KEBAB = /^[a-z0-9][a-z0-9-]*$/

/** Names Claude Code keeps for Anthropic's own catalogs. A third party cannot register one. */
export const RESERVED_MARKETPLACE_NAMES: readonly string[] = [
  'claude-code-marketplace', 'claude-code-plugins', 'claude-plugins-official', 'claude-plugins-community',
  'claude-community', 'anthropic-marketplace', 'anthropic-plugins', 'agent-skills', 'anthropic-agent-skills',
  'knowledge-work-plugins', 'life-sciences', 'claude-for-legal', 'claude-for-financial-services',
  'financial-services-plugins', 'first-party-plugins', 'healthcare',
]

/** One of the reserved names — exactly, as Claude Code checks it. */
export function impersonatesOfficial(name: string): boolean {
  return RESERVED_MARKETPLACE_NAMES.includes(name)
}

/**
 * A name that could pass for Anthropic's without being on the list: `anthropic-extras`,
 * `official-claude-tools`. Not refused — plenty of honest community catalogs say
 * "claude-code" in their name — but noted, with where the catalog really comes from.
 */
export function resemblesOfficial(name: string): boolean {
  return /anthropic|official/.test(name)
}

function parseJsonFile(path: string, what: string): ReadResult<Record<string, unknown>> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { value: null, problems: [code === 'ENOENT' ? `${what} not found at ${path}` : `could not read ${path}: ${(e as Error).message}`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(settingsText(raw))
  } catch (e) {
    return { value: null, problems: [`${path} is not valid JSON: ${(e as Error).message}`] }
  }
  if (!isRecord(parsed)) return { value: null, problems: [`${path} must be a JSON object`] }
  return { value: parsed, problems: [] }
}

function str(raw: Record<string, unknown>, key: string, where: string, problems: string[]): string | undefined {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v === 'string') return v
  problems.push(`${where}.${key} must be a string; ignored`)
  return undefined
}

function bool(raw: Record<string, unknown>, key: string, where: string, problems: string[]): boolean | undefined {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v === 'boolean') return v
  problems.push(`${where}.${key} must be true or false; ignored`)
  return undefined
}

function strings(raw: Record<string, unknown>, key: string, where: string, problems: string[]): string[] | undefined {
  const v = raw[key]
  if (v === undefined) return undefined
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[]
  problems.push(`${where}.${key} must be an array of strings; ignored`)
  return undefined
}

function person(raw: unknown, where: string, problems: string[]): PersonRef | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'string') return { name: raw }
  if (!isRecord(raw) || typeof raw['name'] !== 'string') {
    problems.push(`${where} must be an object with a "name"; ignored`)
    return undefined
  }
  const out: PersonRef = { name: raw['name'] }
  if (typeof raw['email'] === 'string') out.email = raw['email']
  if (typeof raw['url'] === 'string') out.url = raw['url']
  return out
}

/** A component path field: a string, a list of strings, or (hooks/mcp/lsp) an inline object. */
function paths(
  raw: Record<string, unknown>, key: keyof ComponentPaths, where: string, problems: string[], inlineAllowed: boolean,
): ComponentPaths[typeof key] {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[]
  if (inlineAllowed && isRecord(v)) return v
  problems.push(`${where}.${key} must be a path, a list of paths${inlineAllowed ? ' or an object' : ''}; ignored`)
  return undefined
}

function componentPaths(raw: Record<string, unknown>, where: string, problems: string[]): ComponentPaths {
  const out: ComponentPaths = {}
  const skills = paths(raw, 'skills', where, problems, false)
  if (skills !== undefined) out.skills = skills as string | string[]
  const commands = paths(raw, 'commands', where, problems, false)
  if (commands !== undefined) out.commands = commands as string | string[]
  const agents = paths(raw, 'agents', where, problems, false)
  if (agents !== undefined) out.agents = agents as string | string[]
  const hooks = paths(raw, 'hooks', where, problems, true)
  if (hooks !== undefined) out.hooks = hooks
  const mcp = paths(raw, 'mcpServers', where, problems, true)
  if (mcp !== undefined) out.mcpServers = mcp
  const lsp = paths(raw, 'lspServers', where, problems, true)
  if (lsp !== undefined) out.lspServers = lsp
  return out
}

/** The plugin.json keys Claude Code acts on that PrivateCode does not (docs §7). */
const UNSUPPORTED_MANIFEST_KEYS = [
  'lspServers', 'outputStyles', 'workflows', 'userConfig', 'channels', 'dependencies', 'experimental',
]

// ---- sources ---------------------------------------------------------------------------------

export function readSource(raw: unknown, where: string, problems: string[]): PluginSourceSpec | null {
  if (typeof raw === 'string') {
    if (raw.trim() === '') { problems.push(`${where}.source is empty`); return null }
    return raw
  }
  if (!isRecord(raw) || typeof raw['source'] !== 'string') {
    problems.push(`${where}.source must be a path or an object with a "source" kind`)
    return null
  }
  const kind = raw['source']
  const need = (key: string): string | null => {
    const v = raw[key]
    if (typeof v === 'string' && v.trim() !== '') return v
    problems.push(`${where}.source (${kind}) needs a "${key}"`)
    return null
  }
  const opt = (key: string): string | undefined => (typeof raw[key] === 'string' ? raw[key] as string : undefined)
  switch (kind) {
    case 'github': {
      const repo = need('repo')
      if (repo === null) return null
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) { problems.push(`${where}.source.repo must be owner/repo`); return null }
      return { source: 'github', repo, ...(opt('ref') !== undefined ? { ref: opt('ref') as string } : {}),
        ...(opt('sha') !== undefined ? { sha: opt('sha') as string } : {}), ...(opt('path') !== undefined ? { path: opt('path') as string } : {}) }
    }
    case 'url': case 'git': {
      const url = need('url')
      if (url === null) return null
      return { source: 'url', url, ...(opt('ref') !== undefined ? { ref: opt('ref') as string } : {}), ...(opt('sha') !== undefined ? { sha: opt('sha') as string } : {}) }
    }
    case 'git-subdir': {
      const url = need('url')
      const path = need('path')
      if (url === null || path === null) return null
      return { source: 'git-subdir', url, path, ...(opt('ref') !== undefined ? { ref: opt('ref') as string } : {}), ...(opt('sha') !== undefined ? { sha: opt('sha') as string } : {}) }
    }
    case 'archive': {
      const url = need('url')
      if (url === null) return null
      return { source: 'archive', url, ...(opt('sha256') !== undefined ? { sha256: opt('sha256') as string } : {}) }
    }
    case 'npm': {
      const pkg = need('package')
      if (pkg === null) return null
      return { source: 'npm', package: pkg, ...(opt('version') !== undefined ? { version: opt('version') as string } : {}), ...(opt('registry') !== undefined ? { registry: opt('registry') as string } : {}) }
    }
    case 'command': {
      const command = need('command')
      if (command === null) return null
      return { source: 'command', command, ...(typeof raw['timeout'] === 'number' ? { timeout: raw['timeout'] } : {}), ...(opt('mode') !== undefined ? { mode: opt('mode') as string } : {}) }
    }
    default:
      problems.push(`${where}.source kind "${kind}" is not one Claude Code defines`)
      return null
  }
}

/** One line a person can read: where a source points. */
export function describeSource(source: PluginSourceSpec): string {
  if (typeof source === 'string') return source
  switch (source.source) {
    case 'github': return `github ${source.repo}${source.ref !== undefined ? `@${source.ref}` : ''}${source.path !== undefined ? ` (${source.path})` : ''}`
    case 'url': return source.url
    case 'git-subdir': return `${source.url} (${source.path})`
    case 'archive': return source.url
    case 'npm': return `npm ${source.package}${source.version !== undefined ? `@${source.version}` : ''}`
    case 'command': return `command: ${source.command}`
  }
}

// ---- marketplace.json ----------------------------------------------------------------------------

export function readMarketplaceEntry(raw: unknown, index: number, problems: string[]): MarketplaceEntry | null {
  const where = `plugins[${index}]`
  if (!isRecord(raw)) { problems.push(`${where} must be an object`); return null }
  const name = str(raw, 'name', where, problems)
  if (name === undefined || name === '') { problems.push(`${where} has no name`); return null }
  if (!KEBAB.test(name)) problems.push(`${where} "${name}": a plugin name is kebab-case (letters, digits, dashes)`)
  const source = readSource(raw['source'], `${where} "${name}"`, problems)
  if (source === null) return null
  const entry: MarketplaceEntry = { name, source, ...componentPaths(raw, `${where} "${name}"`, problems) }
  const w = `${where} "${name}"`
  const displayName = str(raw, 'displayName', w, problems); if (displayName !== undefined) entry.displayName = displayName
  const description = str(raw, 'description', w, problems); if (description !== undefined) entry.description = description
  const version = str(raw, 'version', w, problems); if (version !== undefined) entry.version = version
  const author = person(raw['author'], `${w}.author`, problems); if (author !== undefined) entry.author = author
  const homepage = str(raw, 'homepage', w, problems); if (homepage !== undefined) entry.homepage = homepage
  const repository = str(raw, 'repository', w, problems); if (repository !== undefined) entry.repository = repository
  const license = str(raw, 'license', w, problems); if (license !== undefined) entry.license = license
  const keywords = strings(raw, 'keywords', w, problems); if (keywords !== undefined) entry.keywords = keywords
  const category = str(raw, 'category', w, problems); if (category !== undefined) entry.category = category
  const tags = strings(raw, 'tags', w, problems); if (tags !== undefined) entry.tags = tags
  const strict = bool(raw, 'strict', w, problems); if (strict !== undefined) entry.strict = strict
  const defaultEnabled = bool(raw, 'defaultEnabled', w, problems); if (defaultEnabled !== undefined) entry.defaultEnabled = defaultEnabled
  return entry
}

export function parseMarketplaceManifest(raw: Record<string, unknown>, where: string): ReadResult<MarketplaceManifest> {
  const problems: string[] = []
  const name = str(raw, 'name', where, problems)
  if (name === undefined || name === '') return { value: null, problems: [...problems, `${where} has no "name"`] }
  if (!KEBAB.test(name)) problems.push(`${where}: marketplace name "${name}" is not kebab-case`)
  const owner = person(raw['owner'], `${where}.owner`, problems) ?? { name: 'unknown' }
  if (raw['owner'] === undefined) problems.push(`${where} has no "owner"`)
  const pluginsRaw = raw['plugins']
  if (!Array.isArray(pluginsRaw)) return { value: null, problems: [...problems, `${where}.plugins must be an array`] }
  const plugins: MarketplaceEntry[] = []
  const seen = new Set<string>()
  pluginsRaw.forEach((entry, i) => {
    const read = readMarketplaceEntry(entry, i, problems)
    if (read === null) return
    if (seen.has(read.name)) { problems.push(`plugin "${read.name}" is listed twice; the first entry wins`); return }
    seen.add(read.name)
    plugins.push(read)
  })
  const manifest: MarketplaceManifest = { name, owner, plugins }
  const description = str(raw, 'description', where, problems); if (description !== undefined) manifest.description = description
  const version = str(raw, 'version', where, problems); if (version !== undefined) manifest.version = version
  if (isRecord(raw['metadata'])) {
    const m = raw['metadata']
    const metadata: NonNullable<MarketplaceManifest['metadata']> = {}
    if (typeof m['pluginRoot'] === 'string') metadata.pluginRoot = m['pluginRoot']
    if (typeof m['version'] === 'string') metadata.version = m['version']
    if (typeof m['description'] === 'string') metadata.description = m['description']
    manifest.metadata = metadata
  }
  if (raw['renames'] !== undefined) {
    if (isRecord(raw['renames'])) {
      const renames: Record<string, string | null> = {}
      for (const [from, to] of Object.entries(raw['renames'])) {
        if (to === null || typeof to === 'string') renames[from] = to
        else problems.push(`${where}.renames.${from} must be a name or null; ignored`)
      }
      manifest.renames = renames
    } else {
      problems.push(`${where}.renames must be an object; ignored`)
    }
  }
  return { value: manifest, problems }
}

/** `<dir>/.claude-plugin/marketplace.json`, or the file itself when `path` names one. */
export function marketplaceManifestPath(path: string): string {
  return basename(path).toLowerCase() === 'marketplace.json' ? path : join(path, '.claude-plugin', 'marketplace.json')
}

export function readMarketplaceManifest(path: string): ReadResult<MarketplaceManifest> {
  const file = marketplaceManifestPath(path)
  const parsed = parseJsonFile(file, 'marketplace.json')
  if (parsed.value === null) return { value: null, problems: parsed.problems }
  return parseMarketplaceManifest(parsed.value, file)
}

// ---- plugin.json -----------------------------------------------------------------------------

export function parsePluginManifest(raw: Record<string, unknown>, where: string): ReadResult<PluginManifest> {
  const problems: string[] = []
  const name = str(raw, 'name', where, problems)
  if (name === undefined || name === '') return { value: null, problems: [...problems, `${where} has no "name"`] }
  if (!KEBAB.test(name)) problems.push(`${where}: plugin name "${name}" is not kebab-case`)
  const manifest: PluginManifest = { name, unsupported: [], ...componentPaths(raw, where, problems) }
  const displayName = str(raw, 'displayName', where, problems); if (displayName !== undefined) manifest.displayName = displayName
  const version = str(raw, 'version', where, problems); if (version !== undefined) manifest.version = version
  const description = str(raw, 'description', where, problems); if (description !== undefined) manifest.description = description
  const author = person(raw['author'], `${where}.author`, problems); if (author !== undefined) manifest.author = author
  const homepage = str(raw, 'homepage', where, problems); if (homepage !== undefined) manifest.homepage = homepage
  const repository = str(raw, 'repository', where, problems); if (repository !== undefined) manifest.repository = repository
  const license = str(raw, 'license', where, problems); if (license !== undefined) manifest.license = license
  const keywords = strings(raw, 'keywords', where, problems); if (keywords !== undefined) manifest.keywords = keywords
  const defaultEnabled = bool(raw, 'defaultEnabled', where, problems); if (defaultEnabled !== undefined) manifest.defaultEnabled = defaultEnabled
  for (const key of UNSUPPORTED_MANIFEST_KEYS) if (raw[key] !== undefined) manifest.unsupported.push(key)
  return { value: manifest, problems }
}

export function pluginManifestPath(dir: string): string {
  return join(dir, '.claude-plugin', 'plugin.json')
}

/**
 * The manifest of the plugin at `dir`, or null with no problem when there is none: a
 * directory of skills, commands and agents with no `.claude-plugin/plugin.json` is a valid
 * plugin whose name comes from the marketplace entry, exactly as in Claude Code.
 */
export function readPluginManifest(dir: string): ReadResult<PluginManifest> {
  const file = pluginManifestPath(dir)
  if (!existsSync(file)) return { value: null, problems: [] }
  const parsed = parseJsonFile(file, 'plugin.json')
  if (parsed.value === null) return { value: null, problems: parsed.problems }
  return parsePluginManifest(parsed.value, file)
}

// ---- the plugin's contents -----------------------------------------------------------------------

export interface PluginInventory {
  /** Skill names (a plugin with a root SKILL.md contributes one skill named after itself). */
  skills: string[]
  /** Command names from flat markdown files. */
  commands: string[]
  agents: string[]
  /** Hook events with the number of handlers under each. */
  hooks: { event: string; count: number }[]
  mcpServers: string[]
  /** What the plugin declares that PrivateCode does not act on. */
  unsupported: string[]
  problems: string[]
}

/** Every path a manifest may name must stay inside the plugin: `../` is refused. */
export function insidePlugin(dir: string, relativePath: string): string | null {
  const cleaned = relativePath.replace(/^\.\//, '')
  if (isAbsolute(cleaned)) return null
  const target = resolve(dir, cleaned)
  const rel = relative(resolve(dir), target)
  if (rel === '' ) return target
  if (rel.startsWith('..') || rel === '..' || rel.split(sep)[0] === '..') return null
  return target
}

function listOf(value: string | string[] | undefined, fallback: string): string[] {
  if (value === undefined) return [fallback]
  return Array.isArray(value) ? value : [value]
}

function markdownNames(dirs: string[], base: string, problems: string[], what: string): string[] {
  const names: string[] = []
  for (const d of dirs) {
    const abs = insidePlugin(base, d)
    if (abs === null) { problems.push(`${what} path "${d}" leaves the plugin; ignored`); continue }
    if (!existsSync(abs)) continue
    try {
      if (statSync(abs).isFile()) {
        if (abs.endsWith('.md')) names.push(basename(abs, '.md'))
        continue
      }
      walkMarkdown(abs, '', names)
    } catch (e) {
      problems.push(`could not read ${abs}: ${(e as Error).message}`)
    }
  }
  return names.sort()
}

/** `review/security.md` → `review:security`, the way Claude Code namespaces subfolders. */
function walkMarkdown(dir: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) { walkMarkdown(join(dir, entry.name), `${prefix}${entry.name}:`, out); continue }
    if (entry.isFile() && entry.name.endsWith('.md')) out.push(`${prefix}${entry.name.slice(0, -3)}`)
  }
}

export function skillNames(dir: string, manifest: PluginManifest | null, problems: string[], pluginName?: string): string[] {
  const names = new Set<string>()
  const roots = ['skills', ...listOf(manifest?.skills, 'skills').filter((p) => normalize(p.replace(/^\.\//, '')) !== 'skills')]
  for (const r of roots) {
    const abs = insidePlugin(dir, r)
    if (abs === null) { problems.push(`skills path "${r}" leaves the plugin; ignored`); continue }
    if (!existsSync(abs)) continue
    // A path straight at a skill directory (one holding SKILL.md) is that one skill.
    if (existsSync(join(abs, 'SKILL.md'))) { names.add(basename(abs)); continue }
    try {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(abs, entry.name, 'SKILL.md'))) names.add(entry.name)
      }
    } catch (e) {
      problems.push(`could not read ${abs}: ${(e as Error).message}`)
    }
  }
  // A single-skill plugin: SKILL.md at the root, named after the plugin — the manifest's
  // name, else the catalog's (an installed copy sits in a folder named after its version).
  if (names.size === 0 && existsSync(join(dir, 'SKILL.md'))) names.add(manifest?.name ?? pluginName ?? basename(dir))
  return [...names].sort()
}

function hookEvents(dir: string, manifest: PluginManifest | null, problems: string[]): PluginInventory['hooks'] {
  const counts = new Map<string, number>()
  const sources: Array<string | Record<string, unknown>> = []
  if (manifest?.hooks === undefined) sources.push('hooks/hooks.json')
  else if (typeof manifest.hooks === 'string') sources.push(manifest.hooks)
  else if (Array.isArray(manifest.hooks)) sources.push(...manifest.hooks)
  else sources.push(manifest.hooks)
  for (const s of sources) {
    let config: Record<string, unknown> | null = null
    if (typeof s === 'string') {
      const abs = insidePlugin(dir, s)
      if (abs === null) { problems.push(`hooks path "${s}" leaves the plugin; ignored`); continue }
      if (!existsSync(abs)) continue
      const parsed = parseJsonFile(abs, 'hooks.json')
      if (parsed.value === null) { problems.push(...parsed.problems); continue }
      config = parsed.value
    } else {
      config = s
    }
    const table = isRecord(config['hooks']) ? config['hooks'] : config
    for (const [event, groups] of Object.entries(table)) {
      if (!Array.isArray(groups)) continue
      let n = 0
      for (const g of groups) if (isRecord(g) && Array.isArray(g['hooks'])) n += g['hooks'].length
      counts.set(event, (counts.get(event) ?? 0) + n)
    }
  }
  return [...counts].map(([event, count]) => ({ event, count })).sort((a, b) => a.event.localeCompare(b.event))
}

function mcpServerNames(dir: string, manifest: PluginManifest | null, problems: string[]): string[] {
  const names = new Set<string>()
  const sources: Array<string | Record<string, unknown>> = []
  if (manifest?.mcpServers === undefined) sources.push('.mcp.json')
  else if (typeof manifest.mcpServers === 'string') sources.push(manifest.mcpServers)
  else if (Array.isArray(manifest.mcpServers)) sources.push(...manifest.mcpServers)
  else sources.push(manifest.mcpServers)
  for (const s of sources) {
    let config: Record<string, unknown> | null = null
    if (typeof s === 'string') {
      const abs = insidePlugin(dir, s)
      if (abs === null) { problems.push(`mcpServers path "${s}" leaves the plugin; ignored`); continue }
      if (!existsSync(abs)) continue
      const parsed = parseJsonFile(abs, '.mcp.json')
      if (parsed.value === null) { problems.push(...parsed.problems); continue }
      config = parsed.value
    } else {
      config = s
    }
    const servers = isRecord(config['mcpServers']) ? config['mcpServers'] : config
    for (const name of Object.keys(servers)) names.add(name)
  }
  return [...names].sort()
}

/**
 * What the plugin at `dir` contributes — the "Will install" list, and what is validated.
 * `pluginName` is the catalog's name for it, used when there is no manifest to ask.
 */
export function inventory(dir: string, manifest: PluginManifest | null, pluginName?: string): PluginInventory {
  const problems: string[] = []
  const unsupported = [...(manifest?.unsupported ?? [])]
  for (const [file, what] of [['.lsp.json', 'lspServers'], ['monitors/monitors.json', 'monitors'], ['settings.json', 'settings.json'], ['output-styles', 'outputStyles'], ['themes', 'themes'], ['workflows', 'workflows']] as const) {
    if (existsSync(join(dir, file)) && !unsupported.includes(what)) unsupported.push(what)
  }
  return {
    skills: skillNames(dir, manifest, problems, pluginName),
    commands: markdownNames(listOf(manifest?.commands, 'commands'), dir, problems, 'commands'),
    agents: markdownNames(listOf(manifest?.agents, 'agents'), dir, problems, 'agents'),
    hooks: hookEvents(dir, manifest, problems),
    mcpServers: mcpServerNames(dir, manifest, problems),
    unsupported,
    problems,
  }
}

// ---- validation ---------------------------------------------------------------------------------

export interface Validation {
  ok: boolean
  errors: string[]
  warnings: string[]
  manifest: PluginManifest | null
  inventory: PluginInventory
}

/**
 * `claude plugin validate`, as far as its rules are written down: a manifest that parses,
 * a kebab-case name, components at the plugin root and not inside `.claude-plugin/`, paths
 * that stay inside the plugin, hooks and MCP files that parse, skills with frontmatter.
 * Warnings are what Claude Code accepts but PrivateCode ignores.
 */
export function validatePlugin(dir: string, pluginName?: string): Validation {
  const errors: string[] = []
  const warnings: string[] = []
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, errors: [`${dir} is not a directory`], warnings, manifest: null, inventory: { skills: [], commands: [], agents: [], hooks: [], mcpServers: [], unsupported: [], problems: [] } }
  }
  const read = readPluginManifest(dir)
  errors.push(...read.problems.filter((p) => /not valid JSON|has no "name"|not found/.test(p)))
  warnings.push(...read.problems.filter((p) => !/not valid JSON|has no "name"|not found/.test(p)))
  const manifest = read.value
  const misplaced = ['commands', 'agents', 'skills', 'hooks'].filter((d) => existsSync(join(dir, '.claude-plugin', d)))
  for (const d of misplaced) errors.push(`${d}/ sits inside .claude-plugin/; it belongs at the plugin root`)
  const inv = inventory(dir, manifest, pluginName)
  errors.push(...inv.problems.filter((p) => /leaves the plugin|not valid JSON/.test(p)))
  warnings.push(...inv.problems.filter((p) => !/leaves the plugin|not valid JSON/.test(p)))
  for (const name of inv.skills) {
    const file = existsSync(join(dir, 'skills', name, 'SKILL.md')) ? join(dir, 'skills', name, 'SKILL.md') : join(dir, 'SKILL.md')
    try {
      const head = readFileSync(file, 'utf8').replace(/^﻿/, '')
      if (!head.startsWith('---')) warnings.push(`skills/${name}/SKILL.md has no frontmatter; its description will be its first paragraph`)
    } catch { /* listed from a directory that vanished between the two reads */ }
  }
  if (inv.unsupported.length > 0) warnings.push(`declares ${inv.unsupported.join(', ')}, which PrivateCode does not act on`)
  const empty = inv.skills.length + inv.commands.length + inv.agents.length + inv.hooks.length + inv.mcpServers.length === 0
  if (empty) warnings.push('contributes no skills, commands, agents, hooks or MCP servers')
  return { ok: errors.length === 0, errors, warnings, manifest, inventory: inv }
}
