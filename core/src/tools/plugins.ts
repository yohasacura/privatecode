import type { Tool } from './types.js'

export interface PluginsArgs {
  line: string
}

/**
 * `/plugin …`, from the model.
 *
 * The same lines the composer, the REPL and the Settings tab run — `marketplace add`,
 * `install`, `enable`, `disable`, `update`, `uninstall`, `list` — answered by the host's own
 * runner, which owns the store and reloads what changed. The owner's ruling: the model must
 * be able to do everything the console can, plugins included, when asked. What keeps this
 * honest is the gate, not the tool: the line is the permission key, so in normal mode every
 * install is offered for approval like a command, and a `deny: ["plugins"]` rule switches
 * it off for good.
 *
 * Installing runs code from the internet — a marketplace is a git repository. The tool
 * says so in its description, and the approval prompt shows the exact line.
 */
export const pluginsTool: Tool<PluginsArgs> = {
  name: 'plugins',
  readOnly: false,
  description:
    'Run one /plugin line, exactly as the user would type it: `/plugin marketplace add ' +
    'owner/repo`, `/plugin install name@marketplace`, `/plugin enable|disable|update|uninstall ' +
    'name@marketplace`, `/plugin marketplace update|remove name`, `/plugin list`, `/plugin ' +
    'marketplace list`. Use it when the user asks to add a marketplace or install, update, ' +
    'enable or remove a plugin. Installing fetches code from a git repository, so name the ' +
    'source when you report back. A newly installed skill reaches this session on the next ' +
    'New session; commands, agents, hooks and MCP servers apply at once.',
  parameters: {
    type: 'object',
    properties: {
      line: { type: 'string', description: 'The whole line, starting with /plugin.' },
    },
    required: ['line'],
  },
  validate(raw) {
    const r = raw as Partial<PluginsArgs>
    if (typeof r?.line !== 'string' || r.line.trim() === '') {
      return { ok: false, error: 'line must be a /plugin command, for example /plugin install name@marketplace' }
    }
    const line = r.line.trim()
    if (!/^\/plugins?(\s|$)/.test(line)) {
      return { ok: false, error: `the line must start with /plugin (got "${line.slice(0, 40)}")` }
    }
    return { ok: true, args: { line } }
  },
  permissionKey(args) {
    return { tool: 'plugins', command: args.line }
  },
  approvalPreview(args) {
    const install = /^\/plugins?\s+(install|marketplace\s+add)\b/.test(args.line)
    return {
      summary: args.line,
      detail: install
        ? 'Fetches and enables code from a git repository or URL named in the line; its commands, agents, hooks and MCP servers apply at once.'
        : 'Changes which plugins and marketplaces this workspace uses; nothing outside the plugin store is written.',
    }
  },
  async execute(args, ctx) {
    if (ctx.plugins === undefined) {
      return { ok: false, content: 'This host has no plugin store, so /plugin lines cannot be run here. Ask the user to run it in the app.' }
    }
    const r = await ctx.plugins.run(args.line)
    return { ok: r.ok, content: r.text }
  },
}
