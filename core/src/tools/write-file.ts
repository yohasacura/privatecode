import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool } from './types.js'

export interface WriteFileArgs {
  path: string
  content: string
}

export const writeFileTool: Tool<WriteFileArgs> = {
  name: 'write_file',
  description:
    'Create a new file, or overwrite one completely. Use edit_file for changes to an ' +
    'existing file — rewriting a whole file costs many times more output tokens.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      content: { type: 'string', description: 'Full file contents.' },
    },
    required: ['path', 'content'],
  },
  validate(raw) {
    const r = raw as Partial<WriteFileArgs>
    if (typeof r?.path !== 'string' || r.path.trim() === '') {
      return { ok: false, error: 'path must be a non-empty workspace-relative path' }
    }
    if (typeof r?.content !== 'string') {
      return { ok: false, error: 'content must be a string' }
    }
    return { ok: true, args: { path: r.path, content: r.content } }
  },
  async execute(args, ctx) {
    let abs: string
    try {
      abs = ctx.workspace.resolve(args.path)
    } catch (e) {
      return { ok: false, content: (e as Error).message }
    }
    try {
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, args.content, 'utf8')
    } catch (e) {
      return { ok: false, content: `Could not write ${args.path}: ${(e as Error).message}` }
    }
    return {
      ok: true,
      content: `Wrote ${args.path} (${Buffer.byteLength(args.content, 'utf8')} bytes).`,
    }
  },
}
