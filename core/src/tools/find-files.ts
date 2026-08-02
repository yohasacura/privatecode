import { glob } from 'node:fs/promises'
import type { Tool } from './types.js'

export interface FindFilesArgs { glob: string }

const MAX_RESULTS = 200

export const findFilesTool: Tool<FindFilesArgs> = {
  name: 'find_files',
  description: 'Find files by glob pattern, for example "src/**/*.ts".',
  parameters: {
    type: 'object',
    properties: { glob: { type: 'string', description: 'Glob relative to the workspace root.' } },
    required: ['glob'],
  },
  validate(raw) {
    const r = raw as Partial<FindFilesArgs>
    if (typeof r?.glob !== 'string' || r.glob.trim() === '') {
      return { ok: false, error: 'glob must be a non-empty pattern' }
    }
    return { ok: true, args: { glob: r.glob } }
  },
  async execute(args, ctx) {
    const found: string[] = []
    try {
      for await (const entry of glob(args.glob, { cwd: ctx.workspace.root })) {
        const normalised = String(entry).split('\\').join('/')
        if (normalised.startsWith('node_modules/') || normalised.includes('/node_modules/')) continue
        found.push(normalised)
        if (found.length >= MAX_RESULTS) break
      }
    } catch (e) {
      return { ok: false, content: `Glob failed: ${(e as Error).message}` }
    }
    if (found.length === 0) return { ok: true, content: `No files match ${args.glob}` }
    const capped = found.length >= MAX_RESULTS ? `\n(stopped at ${MAX_RESULTS} results)` : ''
    return { ok: true, content: found.sort().join('\n') + capped }
  },
}
