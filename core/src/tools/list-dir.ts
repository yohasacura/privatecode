import { readdir } from 'node:fs/promises'
import type { Tool } from './types.js'

export interface ListDirArgs { path: string }

export const listDirTool: Tool<ListDirArgs> = {
  name: 'list_dir',
  description: 'List the entries of a directory in the workspace. Directories end with "/".',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Workspace-relative directory.' } },
    required: ['path'],
  },
  validate(raw) {
    const r = raw as Partial<ListDirArgs>
    if (typeof r?.path !== 'string' || r.path.trim() === '') {
      return { ok: false, error: 'path must be a non-empty workspace-relative directory' }
    }
    return { ok: true, args: { path: r.path } }
  },
  async execute(args, ctx) {
    // '.', './' and '' all resolve to the workspace root, which the jail allows.
    let target: string
    try {
      target = ctx.workspace.resolve(args.path)
    } catch (e) {
      return { ok: false, content: (e as Error).message }
    }
    try {
      const entries = await readdir(target, { withFileTypes: true })
      const names = entries
        .filter((e) => e.name !== 'node_modules' && !e.name.startsWith('.git'))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
      return { ok: true, content: names.length ? names.join('\n') : '(empty directory)' }
    } catch (e) {
      return { ok: false, content: `Could not list ${args.path}: ${(e as Error).message}` }
    }
  },
}
