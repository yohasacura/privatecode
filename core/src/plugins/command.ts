import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { validatePlugin } from './manifest.js'
import {
  addMarketplace, readCatalog, removeMarketplace, updateMarketplace, DEFAULT_MARKETPLACES, SUGGESTED_MARKETPLACES,
} from './marketplaces.js'
import { effectivePlugins, installPlugin, resolveInstalledId, setEnabled, uninstallPlugin, updatePlugin } from './installer.js'
import { describeMarketplaceSource } from './sources.js'
import type { PluginScope, PluginStore } from './store.js'

/**
 * `/plugin …` and `/reload-plugins`, typed in the composer or the REPL, parsed once here and
 * run once here so every front end says the same thing (docs/PLUGINS-2026-09.md §0).
 *
 * The grammar is Claude Code's, shortcuts included: `/plugin market` for `marketplace`, `rm`
 * for `remove`, `i` for `install`, `--scope user|project|local`, `-s`.
 */

export type PluginCommand =
  | { kind: 'open' }
  | { kind: 'help' }
  | { kind: 'marketplace-add'; source: string; scope?: PluginScope }
  | { kind: 'marketplace-list' }
  | { kind: 'marketplace-remove'; name: string }
  | { kind: 'marketplace-update'; name?: string }
  | { kind: 'install'; spec: string; scope?: PluginScope }
  | { kind: 'uninstall'; spec: string; scope?: PluginScope }
  | { kind: 'enable'; spec: string; scope?: PluginScope }
  | { kind: 'disable'; spec: string; scope?: PluginScope }
  | { kind: 'update'; spec: string; scope?: PluginScope }
  | { kind: 'list'; filter?: 'enabled' | 'disabled' }
  | { kind: 'details'; spec: string }
  | { kind: 'validate'; path: string }
  | { kind: 'reload'; force: boolean }
  | { kind: 'error'; message: string }

const HELP = [
  '/plugin                              open the plugin manager',
  '/plugin marketplace add <source>     owner/repo, owner/repo@ref, a git URL, a marketplace.json URL, or a folder',
  '/plugin marketplace list             the marketplaces you have added',
  '/plugin marketplace update [name]    refresh one, or all of them',
  '/plugin marketplace remove <name>    forget it (its plugins are uninstalled)',
  '/plugin install <name>[@marketplace] [--scope user|project|local]',
  '/plugin uninstall <name>[@marketplace] [--scope …]',
  '/plugin enable <name>[@marketplace]',
  '/plugin disable <name>[@marketplace]',
  '/plugin update <name>[@marketplace]',
  '/plugin list [--enabled|--disabled]',
  '/plugin details <name>[@marketplace]',
  '/plugin validate <path>              check a plugin folder the way claude plugin validate does',
  '/reload-plugins [--force]            apply enable/disable/install to the running session',
].join('\n')

function takeScope(words: string[]): { rest: string[]; scope?: PluginScope; error?: string } {
  const rest: string[] = []
  let scope: PluginScope | undefined
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === '--scope' || w === '-s') {
      const v = words[++i]
      if (v !== 'user' && v !== 'project' && v !== 'local') return { rest, error: '--scope must be user, project or local' }
      scope = v
    } else if (w.startsWith('--scope=')) {
      const v = w.slice('--scope='.length)
      if (v !== 'user' && v !== 'project' && v !== 'local') return { rest, error: '--scope must be user, project or local' }
      scope = v
    } else {
      rest.push(w)
    }
  }
  return { rest, ...(scope !== undefined ? { scope } : {}) }
}

/** Parses a typed line. Returns null when the line is not a plugin command at all. */
export function parsePluginCommand(line: string): PluginCommand | null {
  const trimmed = line.trim()
  const words = trimmed.split(/\s+/).filter((w) => w !== '')
  const head = (words[0] ?? '').toLowerCase()
  if (head === '/reload-plugins') return { kind: 'reload', force: words.includes('--force') }
  if (head !== '/plugin' && head !== '/plugins') return null
  const sub = (words[1] ?? '').toLowerCase()
  if (sub === '') return { kind: 'open' }
  if (sub === 'help' || sub === '--help' || sub === '-h') return { kind: 'help' }
  if (sub === 'marketplace' || sub === 'market' || sub === 'marketplaces') {
    const action = (words[2] ?? 'list').toLowerCase()
    const { rest, scope, error } = takeScope(words.slice(3))
    if (error !== undefined) return { kind: 'error', message: error }
    switch (action) {
      case 'add': return rest[0] === undefined ? { kind: 'error', message: 'say where the marketplace is: /plugin marketplace add owner/repo' } : { kind: 'marketplace-add', source: rest.join(' '), ...(scope !== undefined ? { scope } : {}) }
      case 'list': case 'ls': return { kind: 'marketplace-list' }
      case 'remove': case 'rm': return rest[0] === undefined ? { kind: 'error', message: 'say which marketplace to remove' } : { kind: 'marketplace-remove', name: rest[0] }
      case 'update': case 'refresh': return rest[0] === undefined ? { kind: 'marketplace-update' } : { kind: 'marketplace-update', name: rest[0] }
      default: return { kind: 'error', message: `unknown marketplace action "${action}". ${HELP}` }
    }
  }
  const { rest, scope, error } = takeScope(words.slice(2))
  if (error !== undefined) return { kind: 'error', message: error }
  const spec = rest[0]
  const withScope = scope !== undefined ? { scope } : {}
  switch (sub) {
    case 'install': case 'i': case 'add': return spec === undefined ? { kind: 'error', message: 'say which plugin: /plugin install name@marketplace' } : { kind: 'install', spec, ...withScope }
    case 'uninstall': case 'remove': case 'rm': return spec === undefined ? { kind: 'error', message: 'say which plugin to uninstall' } : { kind: 'uninstall', spec, ...withScope }
    case 'enable': return spec === undefined ? { kind: 'error', message: 'say which plugin to enable' } : { kind: 'enable', spec, ...withScope }
    case 'disable': return spec === undefined ? { kind: 'error', message: 'say which plugin to disable' } : { kind: 'disable', spec, ...withScope }
    case 'update': case 'upgrade': return spec === undefined ? { kind: 'error', message: 'say which plugin to update' } : { kind: 'update', spec, ...withScope }
    case 'list': case 'ls': return { kind: 'list', ...(rest.includes('--enabled') ? { filter: 'enabled' as const } : rest.includes('--disabled') ? { filter: 'disabled' as const } : {}) }
    case 'details': case 'info': case 'show': return spec === undefined ? { kind: 'error', message: 'say which plugin' } : { kind: 'details', spec }
    case 'validate': return spec === undefined ? { kind: 'error', message: 'say which folder to validate' } : { kind: 'validate', path: rest.join(' ') }
    default: return { kind: 'error', message: `unknown plugin command "${sub}".\n${HELP}` }
  }
}

export interface CommandContext {
  store: PluginStore
  workspaceRoot?: string
  /** Where a relative marketplace path is resolved from. */
  cwd?: string
  userPath?: string
  /** The caller applies a change to the running session itself, so the report need not say "run /reload-plugins". */
  autoReload?: boolean
}

function applyNote(ctx: CommandContext, what = 'apply'): string {
  return ctx.autoReload === true ? '' : ` Run /reload-plugins to ${what}.`
}

export interface CommandOutcome {
  ok: boolean
  /** What to show the person, as plain lines. */
  text: string
  /** The set of installed or enabled plugins changed: the session should reload them. */
  changed: boolean
  /** `/plugin` with no arguments: the front end opens its manager. */
  open?: boolean
  /** `/reload-plugins`: the front end rebuilds the session's plugin components. */
  reload?: { force: boolean }
}

function done(text: string, changed = false): CommandOutcome { return { ok: true, text, changed } }
function failed(text: string): CommandOutcome { return { ok: false, text: `✗ ${text}`, changed: false } }

function scopeOpts(ctx: CommandContext, scope: PluginScope | undefined): { scope?: PluginScope; workspaceRoot?: string; userPath?: string } {
  return {
    ...(scope !== undefined ? { scope } : {}),
    ...(ctx.workspaceRoot !== undefined ? { workspaceRoot: ctx.workspaceRoot } : {}),
    ...(ctx.userPath !== undefined ? { userPath: ctx.userPath } : {}),
  }
}

function summarise(inv: { skills: string[]; commands: string[]; agents: string[]; hooks: { event: string; count: number }[]; mcpServers: string[] }): string {
  const parts: string[] = []
  if (inv.skills.length > 0) parts.push(`${inv.skills.length} skill${inv.skills.length === 1 ? '' : 's'}`)
  if (inv.commands.length > 0) parts.push(`${inv.commands.length} command${inv.commands.length === 1 ? '' : 's'}`)
  if (inv.agents.length > 0) parts.push(`${inv.agents.length} agent${inv.agents.length === 1 ? '' : 's'}`)
  const hooks = inv.hooks.reduce((n, h) => n + h.count, 0)
  if (hooks > 0) parts.push(`${hooks} hook${hooks === 1 ? '' : 's'}`)
  if (inv.mcpServers.length > 0) parts.push(`${inv.mcpServers.length} MCP server${inv.mcpServers.length === 1 ? '' : 's'}`)
  return parts.length === 0 ? 'nothing it can use here' : parts.join(', ')
}

/** Runs a parsed command against the store. Never throws; every failure is a line. */
export async function runPluginCommand(cmd: PluginCommand, ctx: CommandContext): Promise<CommandOutcome> {
  const { store } = ctx
  switch (cmd.kind) {
    case 'open': return { ok: true, text: '', changed: false, open: true }
    case 'help': return done(HELP)
    case 'error': return failed(cmd.message)
    case 'reload': return { ok: true, text: 'Reloading plugins…', changed: false, reload: { force: cmd.force } }

    case 'marketplace-add': {
      const r = await addMarketplace(store, cmd.source, { ...scopeOpts(ctx, cmd.scope), ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}) })
      if ('error' in r) return failed(r.error)
      const lines = [`✔ ${r.refreshed ? 'Refreshed' : 'Added'} marketplace ${r.manifest.name} (${r.manifest.plugins.length} plugin${r.manifest.plugins.length === 1 ? '' : 's'}) from ${describeMarketplaceSource(r.marketplace.source)}`]
      lines.push(`  Install with /plugin install <name>@${r.manifest.name}`)
      for (const p of r.problems) lines.push(`  note: ${p}`)
      return done(lines.join('\n'))
    }
    case 'marketplace-list': {
      const known = store.knownMarketplaces()
      if (known.length === 0) return done('No marketplaces added. Try /plugin marketplace add anthropics/claude-plugins-official')
      const lines = known.map((m) => {
        const catalog = readCatalog(store, m.name)
        const count = 'error' in catalog ? 'not fetched yet' : `${catalog.manifest.plugins.length} plugins`
        return `  ${m.name.padEnd(28)} ${describeMarketplaceSource(m.source)}  — ${count}${m.bundled === true ? ' (bundled)' : ''}`
      })
      const suggested = SUGGESTED_MARKETPLACES.filter((s) => !known.some((k) => k.name === s.name))
      if (suggested.length > 0) {
        lines.push('', 'Worth adding:')
        for (const s of suggested) lines.push(`  /plugin marketplace add ${s.source.source === 'github' ? s.source.repo : describeMarketplaceSource(s.source)}   — ${s.why}`)
      }
      return done(lines.join('\n'))
    }
    case 'marketplace-remove': {
      const catalog = readCatalog(store, cmd.name)
      const removedPlugins: string[] = []
      for (const p of store.installed().filter((p) => p.marketplace === cmd.name)) {
        // Every scope it was installed for, not just the one this workspace would pick.
        for (const s of p.scopes) {
          const r = uninstallPlugin(store, p.id, { scope: s.scope, ...(s.workspaceRoot !== undefined ? { workspaceRoot: s.workspaceRoot } : {}), ...(ctx.userPath !== undefined ? { userPath: ctx.userPath } : {}) })
          if (!('error' in r) && !removedPlugins.includes(p.id)) removedPlugins.push(p.id)
        }
      }
      const r = removeMarketplace(store, cmd.name, scopeOpts(ctx, undefined))
      if ('error' in r) return failed(r.error)
      const what = 'error' in catalog ? '' : ` (${catalog.manifest.plugins.length} plugins were listed)`
      return done(`✔ Removed marketplace ${cmd.name}${what}${removedPlugins.length > 0 ? `; uninstalled ${removedPlugins.join(', ')}` : ''}`, removedPlugins.length > 0)
    }
    case 'marketplace-update': {
      const names = cmd.name !== undefined ? [cmd.name] : store.knownMarketplaces().map((m) => m.name)
      if (names.length === 0) return done('No marketplaces to update.')
      const lines: string[] = []
      let ok = true
      for (const name of names) {
        const r = await updateMarketplace(store, name)
        if ('error' in r) { ok = false; lines.push(`✗ ${r.error}`); continue }
        lines.push(`✔ ${name}: ${r.changed ? 'updated' : 'already up to date'}, ${r.plugins} plugins`)
      }
      return { ok, text: lines.join('\n'), changed: false }
    }

    case 'install': {
      const r = await installPlugin(store, cmd.spec, scopeOpts(ctx, cmd.scope))
      if ('error' in r) return failed(r.error)
      const lines = [`✔ ${r.alreadyInstalled ? 'Already installed' : 'Installed'} ${r.id} ${r.version} (${r.scope} scope)${r.renamedFrom !== undefined ? ` — "${r.renamedFrom}" is now "${r.name}"` : ''}`]
      lines.push(`  Adds ${summarise(r.inventory)}.`)
      if (r.inventory.hooks.length > 0 || r.inventory.mcpServers.length > 0) {
        lines.push('  This plugin runs code on your machine' +
          (r.inventory.hooks.length > 0 ? `: hooks on ${r.inventory.hooks.map((h) => h.event).join(', ')}` : '') +
          (r.inventory.mcpServers.length > 0 ? `${r.inventory.hooks.length > 0 ? ';' : ':'} MCP servers ${r.inventory.mcpServers.join(', ')}` : '') + '.')
      }
      for (const w of r.warnings) lines.push(`  note: ${w}`)
      if (r.enabled) { if (ctx.autoReload !== true) lines.push('  Run /reload-plugins to activate.') }
      else lines.push('  Installed disabled (the plugin asks not to be enabled by default). /plugin enable to turn it on.')
      return done(lines.join('\n'), true)
    }
    case 'uninstall': {
      const r = uninstallPlugin(store, cmd.spec, scopeOpts(ctx, cmd.scope))
      if ('error' in r) return failed(r.error)
      return done(`✔ Uninstalled ${r.id} (${r.scope} scope)${r.removedFiles ? '' : '; it stays installed for its other scopes'}.${applyNote(ctx)}`, true)
    }
    case 'enable': case 'disable': {
      const r = setEnabled(store, cmd.spec, cmd.kind === 'enable', scopeOpts(ctx, cmd.scope))
      if ('error' in r) return failed(r.error)
      return done(`✔ ${cmd.kind === 'enable' ? 'Enabled' : 'Disabled'} ${r.id} (${r.scope} scope, ${r.path}).${applyNote(ctx)}`, true)
    }
    case 'update': {
      const r = await updatePlugin(store, cmd.spec, scopeOpts(ctx, cmd.scope))
      if ('error' in r) return failed(r.error)
      const lines = [r.changed ? `✔ Updated ${r.id}: ${r.from} → ${r.to}.${applyNote(ctx)}` : `✔ ${r.id} is already at ${r.to}.`]
      for (const w of r.warnings) lines.push(`  note: ${w}`)
      return done(lines.join('\n'), r.changed)
    }
    case 'list': {
      const eff = effectivePlugins(store, ctx.workspaceRoot, ctx.userPath)
      const rows = eff.plugins.filter((p) => cmd.filter === undefined || (cmd.filter === 'enabled') === p.enabled)
      const lines: string[] = []
      if (rows.length === 0) lines.push(cmd.filter === undefined ? 'No plugins installed. /plugin marketplace list shows where to get some.' : `No ${cmd.filter} plugins.`)
      for (const p of rows) {
        lines.push(`  ${p.enabled ? '●' : '○'} ${p.id.padEnd(40)} ${p.version.padEnd(14)} ${p.enabled ? 'enabled' : 'disabled'} (${p.scopes.map((s) => s.scope).join(', ')})  ${summarise(p.inventory)}`)
        for (const problem of p.problems) lines.push(`      ! ${problem}`)
      }
      for (const d of eff.declared) lines.push(`  ? ${d.id} is enabled in ${d.from} but not installed — /plugin install ${d.id}`)
      for (const problem of eff.problems) lines.push(`  ! ${problem}`)
      return done(lines.join('\n'))
    }
    case 'details': {
      const plugin = resolveInstalledId(store, cmd.spec)
      if ('error' in plugin) return failed(plugin.error)
      const v = validatePlugin(plugin.installPath, plugin.name)
      const lines = [
        `${plugin.id} ${plugin.version}`,
        `  path      ${plugin.installPath}`,
        `  scopes    ${plugin.scopes.map((s) => s.scope + (s.workspaceRoot !== undefined ? ` (${s.workspaceRoot})` : '')).join(', ')}`,
        `  installed ${plugin.installedAt}${plugin.sha !== undefined ? `  commit ${plugin.sha.slice(0, 12)}` : ''}`,
      ]
      if (v.manifest?.description !== undefined) lines.push(`  about     ${v.manifest.description}`)
      if (v.inventory.skills.length > 0) lines.push(`  skills    ${v.inventory.skills.map((s) => `/${plugin.name}:${s}`).join(', ')}`)
      if (v.inventory.commands.length > 0) lines.push(`  commands  ${v.inventory.commands.map((s) => `/${plugin.name}:${s}`).join(', ')}`)
      if (v.inventory.agents.length > 0) lines.push(`  agents    ${v.inventory.agents.map((a) => `${plugin.name}:${a}`).join(', ')}`)
      if (v.inventory.hooks.length > 0) lines.push(`  hooks     ${v.inventory.hooks.map((h) => `${h.event} ×${h.count}`).join(', ')}`)
      if (v.inventory.mcpServers.length > 0) lines.push(`  mcp       ${v.inventory.mcpServers.join(', ')}`)
      for (const w of [...v.errors, ...v.warnings]) lines.push(`  note      ${w}`)
      return done(lines.join('\n'))
    }
    case 'validate': {
      const path = resolve(ctx.cwd ?? process.cwd(), cmd.path)
      if (!existsSync(path)) return failed(`${cmd.path} does not exist`)
      const v = validatePlugin(path)
      const lines = [v.ok ? (v.warnings.length > 0 ? '✔ Validation passed with warnings' : '✔ Validation passed') : '✗ Validation failed']
      for (const e of v.errors) lines.push(`  error: ${e}`)
      for (const w of v.warnings) lines.push(`  warning: ${w}`)
      if (v.ok) lines.push(`  Adds ${summarise(v.inventory)}.`)
      return { ok: v.ok, text: lines.join('\n'), changed: false }
    }
  }
}

/** The lines the window and the REPL show for `/plugin help`, and the bundled catalog note. */
export function pluginHelpText(): string {
  return `${HELP}\n\nBundled marketplaces: ${DEFAULT_MARKETPLACES.map((d) => d.name).join(', ')}.`
}
