import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SubAgentRole } from '../agent/subagent.js'
import type { CommandSource } from '../commands/custom.js'
import { readServersObject, type ServerConfig } from '../mcp/config.js'
import type { SkillSource } from '../skills/skills.js'
import { settingsText } from '../permissions/settings.js'
import { readAgentsDir } from './agents.js'
import { effectivePlugins, pluginPaths } from './installer.js'
import { insidePlugin, isRecord, type PluginManifest } from './manifest.js'
import { claudeConfigDir } from './settings.js'
import type { PluginStore } from './store.js'

/**
 * What the enabled plugins put into a session (docs/PLUGINS-2026-09.md §4), gathered once
 * per session build and handed to the loaders that already exist: skills as extra skill
 * sources, commands as extra command sources, agents as `delegate` roles, MCP servers as
 * server configs, hooks as raw configs for the hook engine, `bin/` folders for PATH.
 *
 * Also the standalone conventions of §0: `.claude/skills`, `.claude/commands`,
 * `.claude/agents`, `.mcp.json` and their `~/.claude/` twins, read the same way and handed
 * over first, so PrivateCode's own folders win a name clash.
 */

export interface HookSource {
  /** `plugin:<name>`, or `.claude/settings.json` and the like for a standalone file. */
  owner: string
  /** `${CLAUDE_PLUGIN_ROOT}` — absent for a hook that is not a plugin's. */
  root?: string
  data?: string
  /** The `hooks` object, Claude Code's shape: event → matcher groups. */
  config: Record<string, unknown>
  where: string
}

export interface LoadedPlugin {
  id: string
  name: string
  version: string
  root: string
  data: string
}

export interface PluginComponents {
  plugins: LoadedPlugin[]
  skillSources: SkillSource[]
  commandSources: CommandSource[]
  agents: SubAgentRole[]
  mcpServers: ServerConfig[]
  hookSources: HookSource[]
  binDirs: string[]
  problems: string[]
  /** What enabled plugins declare that PrivateCode does not act on, one line each. */
  ignored: string[]
}

export interface PluginVars { root: string; data: string; project: string }

/** `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}` in a string. */
export function substitutePluginVars(text: string, vars: PluginVars): string {
  return text
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, vars.root)
    .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, vars.data)
    .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, vars.project)
}

/** The same, inside a JSON text: a Windows path is escaped so the document still parses. */
function substituteInJson(text: string, vars: PluginVars): string {
  const esc = (s: string): string => JSON.stringify(s).slice(1, -1)
  return substitutePluginVars(text, { root: esc(vars.root), data: esc(vars.data), project: esc(vars.project) })
}

function listOf(value: string | string[] | undefined, fallback: string): string[] {
  if (value === undefined) return [fallback]
  return Array.isArray(value) ? value : [value]
}

function dirsFor(root: string, value: string | string[] | undefined, fallback: string, what: string, where: string, problems: string[]): string[] {
  const out: string[] = []
  for (const p of listOf(value, fallback)) {
    const abs = insidePlugin(root, p)
    if (abs === null) { problems.push(`${where}: ${what} path "${p}" leaves the plugin; ignored`); continue }
    if (existsSync(abs)) out.push(abs)
  }
  return out
}

/** A `.mcp.json`-shaped document (a file or an inline object) → server configs, renamed for the plugin. */
function pluginServers(plugin: LoadedPlugin, manifest: PluginManifest | null, vars: PluginVars, problems: string[]): ServerConfig[] {
  const sources: Array<{ text: string; where: string } | { object: Record<string, unknown>; where: string }> = []
  const declared = manifest?.mcpServers
  const paths = declared === undefined ? ['.mcp.json'] : typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []
  if (declared !== undefined && !Array.isArray(declared) && typeof declared !== 'string') {
    sources.push({ object: declared, where: `${plugin.id}: plugin.json mcpServers` })
  }
  for (const p of paths) {
    const abs = insidePlugin(plugin.root, p)
    if (abs === null) { problems.push(`${plugin.id}: mcpServers path "${p}" leaves the plugin; ignored`); continue }
    if (!existsSync(abs)) continue
    try { sources.push({ text: readFileSync(abs, 'utf8'), where: `${plugin.id}: ${p}` }) } catch (e) { problems.push(`${plugin.id}: could not read ${p}: ${(e as Error).message}`) }
  }
  const out: ServerConfig[] = []
  for (const s of sources) {
    let raw: unknown
    if ('text' in s) {
      try { raw = JSON.parse(settingsText(substituteInJson(s.text, vars))) } catch (e) { problems.push(`${s.where} is not valid JSON: ${(e as Error).message}`); continue }
    } else {
      try { raw = JSON.parse(substituteInJson(JSON.stringify(s.object), vars)) } catch { raw = s.object }
    }
    if (!isRecord(raw)) { problems.push(`${s.where} must be a JSON object`); continue }
    const table = isRecord(raw['mcpServers']) ? raw['mcpServers'] : raw
    for (const config of readServersObject(table, s.where, problems)) {
      const spec = config.spec.kind === 'stdio'
        ? { ...config.spec, env: { CLAUDE_PLUGIN_ROOT: vars.root, CLAUDE_PLUGIN_DATA: vars.data, ...(config.spec.env ?? {}) } }
        : config.spec
      out.push({ ...config, name: `plugin:${plugin.name}:${config.name}`, spec, source: s.where })
    }
  }
  return out
}

function pluginHooks(plugin: LoadedPlugin, manifest: PluginManifest | null, vars: PluginVars, problems: string[]): HookSource[] {
  const out: HookSource[] = []
  const declared = manifest?.hooks
  const inline = declared !== undefined && !Array.isArray(declared) && typeof declared !== 'string' ? declared : null
  const paths = declared === undefined ? ['hooks/hooks.json'] : typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []
  const push = (raw: unknown, where: string): void => {
    if (!isRecord(raw)) { problems.push(`${where} must be a JSON object`); return }
    const config = isRecord(raw['hooks']) ? raw['hooks'] : raw
    out.push({ owner: `plugin:${plugin.name}`, root: vars.root, data: vars.data, config, where })
  }
  if (inline !== null) push(inline, `${plugin.id}: plugin.json hooks`)
  for (const p of paths) {
    const abs = insidePlugin(plugin.root, p)
    if (abs === null) { problems.push(`${plugin.id}: hooks path "${p}" leaves the plugin; ignored`); continue }
    if (!existsSync(abs)) continue
    try {
      push(JSON.parse(settingsText(readFileSync(abs, 'utf8'))), `${plugin.id}: ${p}`)
    } catch (e) {
      problems.push(`${plugin.id}: ${p} is not valid JSON: ${(e as Error).message}`)
    }
  }
  return out
}

/**
 * Everything the enabled plugins contribute to this workspace. Never throws; a plugin whose
 * files are missing is one problem line and no components.
 */
export function loadPluginComponents(store: PluginStore, workspaceRoot: string, opts: { userPath?: string } = {}): PluginComponents {
  const out: PluginComponents = {
    plugins: [], skillSources: [], commandSources: [], agents: [], mcpServers: [], hookSources: [], binDirs: [], problems: [], ignored: [],
  }
  const eff = effectivePlugins(store, workspaceRoot, opts.userPath)
  out.problems.push(...eff.problems)
  for (const d of eff.declared) out.problems.push(`${d.id} is enabled in ${d.from} but not installed — /plugin install ${d.id}`)
  for (const p of eff.plugins) {
    if (!p.enabled) continue
    if (!existsSync(p.installPath)) { out.problems.push(`${p.id}: its files are missing at ${p.installPath} — /plugin install ${p.id} restores them`); continue }
    const paths = pluginPaths(store, p)
    try { mkdirSync(paths.data, { recursive: true }) } catch { /* a read-only store: the data folder is a convenience */ }
    const plugin: LoadedPlugin = { id: p.id, name: p.name, version: p.version, root: paths.root, data: paths.data }
    const vars: PluginVars = { root: paths.root, data: paths.data, project: resolve(workspaceRoot) }
    out.plugins.push(plugin)
    out.problems.push(...p.problems.map((m) => `${p.id}: ${m}`))
    const manifest = p.manifest

    for (const dir of dirsFor(plugin.root, manifest?.skills, 'skills', 'skills', p.id, out.problems)) {
      // A path straight at one skill (its folder holds SKILL.md) is that skill's parent with a filter.
      if (existsSync(join(dir, 'SKILL.md'))) {
        out.skillSources.push({ scope: 'plugin', dir: resolve(dir, '..'), prefix: p.name, label: p.id, only: [join(dir).split(/[\\/]/).pop()!] })
      } else {
        out.skillSources.push({ scope: 'plugin', dir, prefix: p.name, label: p.id })
      }
    }
    if (existsSync(join(plugin.root, 'SKILL.md'))) {
      // A single-skill plugin: the plugin folder IS the skill, named after the plugin — with
      // no prefix to repeat, so Anthropic's `docx` is `/docx`, not `/docx:docx`.
      out.skillSources.push({ scope: 'plugin', dir: resolve(plugin.root, '..'), plugin: p.name, label: p.id, only: [plugin.root.split(/[\\/]/).pop()!], rename: p.name })
    }
    for (const dir of dirsFor(plugin.root, manifest?.commands, 'commands', 'commands', p.id, out.problems)) {
      out.commandSources.push({ dir, prefix: p.name, kind: 'commands', label: p.id })
    }
    // A skill is a slash command too, exactly as in Claude Code.
    for (const s of out.skillSources.filter((s) => s.label === p.id)) {
      out.commandSources.push({
        dir: s.dir, kind: 'skills', label: p.id,
        ...(s.prefix !== undefined ? { prefix: s.prefix } : {}),
        ...(s.only !== undefined ? { only: s.only } : {}),
        ...(s.rename !== undefined ? { rename: s.rename } : {}),
      })
    }
    for (const dir of dirsFor(plugin.root, manifest?.agents, 'agents', 'agents', p.id, out.problems)) {
      out.agents.push(...readAgentsDir(dir, p.name, p.id, out.problems))
    }
    out.mcpServers.push(...pluginServers(plugin, manifest, vars, out.problems))
    out.hookSources.push(...pluginHooks(plugin, manifest, vars, out.problems))
    const bin = join(plugin.root, 'bin')
    if (existsSync(bin) && statSync(bin).isDirectory()) out.binDirs.push(bin)
    if (p.inventory.unsupported.length > 0) out.ignored.push(`${p.id} declares ${p.inventory.unsupported.join(', ')}, which PrivateCode does not act on`)
  }
  return out
}

export interface StandaloneComponents {
  skillSources: SkillSource[]
  commandSources: CommandSource[]
  agents: SubAgentRole[]
  /** From `.mcp.json` and the `.claude/` settings files, lowest precedence first. */
  mcpServers: ServerConfig[]
  hookSources: HookSource[]
  problems: string[]
}

function serversFromFile(path: string, where: string, problems: string[]): ServerConfig[] {
  if (!existsSync(path)) return []
  let raw: unknown
  try { raw = JSON.parse(settingsText(readFileSync(path, 'utf8'))) } catch (e) { problems.push(`${where} is not valid JSON: ${(e as Error).message}`); return [] }
  if (!isRecord(raw) || !isRecord(raw['mcpServers'])) return []
  return readServersObject(raw['mcpServers'], where, problems)
}

function hooksFromFile(path: string, where: string): HookSource[] {
  if (!existsSync(path)) return []
  let raw: unknown
  // A JSON error is reported once, by `serversFromFile` over the same file.
  try { raw = JSON.parse(settingsText(readFileSync(path, 'utf8'))) } catch { return [] }
  if (!isRecord(raw) || !isRecord(raw['hooks']) || Array.isArray(raw['hooks'])) return []
  return [{ owner: where, config: raw['hooks'], where }]
}

/**
 * Claude Code's own folders and files, read as PrivateCode reads its own — `.claude/skills`,
 * `.claude/commands`, `.claude/agents`, `.mcp.json`, and `mcpServers`/`hooks` in the
 * `.claude/settings*.json` files — user level first, then the project.
 */
export function standaloneComponents(workspaceRoot: string, claudeDir = claudeConfigDir()): StandaloneComponents {
  const out: StandaloneComponents = { skillSources: [], commandSources: [], agents: [], mcpServers: [], hookSources: [], problems: [] }
  const project = join(workspaceRoot, '.claude')
  for (const [scope, base, label] of [['user', claudeDir, '~/.claude'], ['project', project, '.claude']] as const) {
    const skills = join(base, 'skills')
    if (existsSync(skills)) {
      out.skillSources.push({ scope, dir: skills, label: `${label}/skills` })
      out.commandSources.push({ dir: skills, kind: 'skills', label: `${label}/skills` })
    }
    const commands = join(base, 'commands')
    if (existsSync(commands)) out.commandSources.push({ dir: commands, kind: 'commands', label: `${label}/commands` })
    out.agents.push(...readAgentsDir(join(base, 'agents'), null, `${label}/agents`, out.problems))
  }
  out.mcpServers.push(...serversFromFile(join(claudeDir, 'settings.json'), '~/.claude/settings.json', out.problems))
  out.hookSources.push(...hooksFromFile(join(claudeDir, 'settings.json'), '~/.claude/settings.json'))
  out.mcpServers.push(...serversFromFile(join(workspaceRoot, '.mcp.json'), '.mcp.json', out.problems))
  for (const file of ['settings.json', 'settings.local.json']) {
    out.mcpServers.push(...serversFromFile(join(project, file), `.claude/${file}`, out.problems))
    out.hookSources.push(...hooksFromFile(join(project, file), `.claude/${file}`))
  }
  return out
}

/** Servers from several sources, later ones winning by name — the rule `loadServers` follows. */
export function mergeServers(...lists: ServerConfig[][]): ServerConfig[] {
  const merged = new Map<string, ServerConfig>()
  for (const list of lists) for (const s of list) merged.set(s.name, s)
  return [...merged.values()]
}
