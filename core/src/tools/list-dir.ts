import { readdir } from 'node:fs/promises'
import { fsErrorReason } from './atomic-write.js'
import type { Tool } from './types.js'

/**
 * Entries hidden from a listing, matched as whole names rather than prefixes.
 *
 * `.git` is matched exactly: a `startsWith('.git')` test also swallows `.gitignore`,
 * `.gitattributes`, `.gitlab-ci.yml` and the whole `.github/` tree, which is CI config the
 * agent is routinely asked about.
 *
 * Denylisted names such as `.env` are deliberately NOT hidden here. The workspace denies
 * them because reading their *contents* is the damage; a listing exposes only the name,
 * and the agent needs to know the file exists - otherwise read_file's refusal looks like
 * a bug and the agent may try to create one over the top of it. Whatever is hidden is
 * named in the footer, so a filtered listing is never presented as a complete one.
 */
const HIDDEN_NAMES = new Set(['.git', 'node_modules'].map((s) => s.toLowerCase()))

export interface ListDirArgs { path: string }

export const listDirTool: Tool<ListDirArgs> = {
  name: 'list_dir',
  readOnly: true,
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
      const names: string[] = []
      const hidden: string[] = []
      for (const entry of entries) {
        const label = entry.isDirectory() ? `${entry.name}/` : entry.name
        if (HIDDEN_NAMES.has(entry.name.toLowerCase())) hidden.push(label)
        else names.push(label)
      }
      names.sort()
      hidden.sort()
      const footer = hidden.length ? `\n(hidden: ${hidden.join(', ')})` : ''
      const body = names.length
        ? names.join('\n')
        : hidden.length
          ? '(nothing listable)'
          : '(empty directory)'
      return { ok: true, content: body + footer }
    } catch (e) {
      // Measured before this: `Could not list nope: ENOENT: no such file or directory,
      // scandir 'C:\Users\...\nope'` — an absolute path and a raw errno, permanently, in a
      // transcript, for what is one short sentence of information. fsErrorReason exists for
      // exactly this; the write tools have used it from the start.
      const err = e as NodeJS.ErrnoException
      return {
        ok: false,
        content: err.code === 'ENOENT'
          ? `Directory not found: ${args.path}`
          : `Could not list ${args.path}: ${fsErrorReason(target, e)}`,
      }
    }
  },
}
