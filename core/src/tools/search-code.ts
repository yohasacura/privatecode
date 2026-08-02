import { execa } from 'execa'
import type { Tool } from './types.js'

export interface SearchCodeArgs {
  pattern: string
  glob?: string
  max_results?: number
}

const DEFAULT_MAX = 80

export const searchCodeTool: Tool<SearchCodeArgs> = {
  name: 'search_code',
  description:
    'Search the workspace with a regular expression (ripgrep). Returns file:line:text. ' +
    'This is the primary way to locate code; it is exact and never stale.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Rust-flavoured regular expression.' },
      glob: { type: 'string', description: 'Optional file filter, e.g. "*.ts".' },
      max_results: { type: 'integer', description: `Cap on matches, default ${DEFAULT_MAX}.` },
    },
    required: ['pattern'],
  },
  validate(raw) {
    const r = raw as Partial<SearchCodeArgs>
    if (typeof r?.pattern !== 'string' || r.pattern.trim() === '') {
      return { ok: false, error: 'pattern must be a non-empty regular expression' }
    }
    const args: SearchCodeArgs = { pattern: r.pattern }
    if (typeof r.glob === 'string' && r.glob.trim() !== '') args.glob = r.glob
    if (Number.isInteger(r.max_results) && (r.max_results as number) > 0) {
      args.max_results = r.max_results as number
    }
    return { ok: true, args }
  },
  async execute(args, ctx) {
    const max = args.max_results ?? DEFAULT_MAX
    const argv = [
      '--line-number', '--no-heading', '--color', 'never',
      '--max-count', String(max),
      '--glob', '!node_modules', '--glob', '!.git',
    ]
    if (args.glob) argv.push('--glob', args.glob)
    argv.push('--regexp', args.pattern, '.')

    try {
      const { stdout } = await execa('rg', argv, {
        cwd: ctx.workspace.root,
        reject: false,
        timeout: 30_000,
        ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
      }).then((r) => {
        // rg exits 1 for "no matches" and 2 for a real error.
        if (r.exitCode === 2) throw new Error(r.stderr || 'ripgrep failed')
        return r
      })

      const lines = stdout.split('\n').filter((l) => l.trim() !== '')
      if (lines.length === 0) {
        return { ok: true, content: `No matches for /${args.pattern}/` }
      }
      const capped = lines.length >= max ? `\n(stopped at ${max} matches)` : ''
      return { ok: true, content: lines.slice(0, max).join('\n') + capped }
    } catch (e) {
      return { ok: false, content: `search_code failed: ${(e as Error).message}` }
    }
  },
}
