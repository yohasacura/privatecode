import { readFile } from 'node:fs/promises'
import type { Tool } from './types.js'

export interface ReadFileArgs {
  path: string
  start_line?: number
  end_line?: number
}

const MAX_LINES = 2000

export const readFileTool: Tool<ReadFileArgs> = {
  name: 'read_file',
  description:
    'Read a text file from the workspace. Returns lines numbered from 1. Prefer a line ' +
    'range over reading a whole large file: everything read stays in context permanently.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      start_line: { type: 'integer', description: 'First line to return, 1-based.' },
      end_line: { type: 'integer', description: 'Last line to return, inclusive.' },
    },
    required: ['path'],
  },
  validate(raw) {
    const r = raw as Partial<ReadFileArgs>
    if (typeof r?.path !== 'string' || r.path.trim() === '') {
      return { ok: false, error: 'path must be a non-empty workspace-relative path' }
    }
    if (r.start_line !== undefined && (!Number.isInteger(r.start_line) || r.start_line < 1)) {
      return { ok: false, error: 'start_line must be an integer >= 1' }
    }
    if (r.end_line !== undefined && (!Number.isInteger(r.end_line) || r.end_line < 1)) {
      return { ok: false, error: 'end_line must be an integer >= 1' }
    }
    const args: ReadFileArgs = { path: r.path }
    if (r.start_line !== undefined) args.start_line = r.start_line
    if (r.end_line !== undefined) args.end_line = r.end_line
    return { ok: true, args }
  },
  async execute(args, ctx) {
    let abs: string
    try {
      abs = ctx.workspace.resolve(args.path)
    } catch (e) {
      return { ok: false, content: (e as Error).message }
    }
    let text: string
    try {
      text = await readFile(abs, 'utf8')
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      return {
        ok: false,
        content: err.code === 'ENOENT'
          ? `File not found: ${args.path}`
          : `Could not read ${args.path}: ${err.message}`,
      }
    }
    const lines = text.split('\n')
    const from = (args.start_line ?? 1) - 1
    const to = Math.min(args.end_line ?? from + MAX_LINES, lines.length)
    const slice = lines.slice(from, to)
    const body = slice.map((l, i) => `${from + i + 1}\t${l}`).join('\n')
    const truncated = to < lines.length && args.end_line === undefined
      ? `\n... ${lines.length - to} more lines; call read_file again with start_line=${to + 1}`
      : ''
    return { ok: true, content: `${args.path} (${lines.length} lines)\n${body}${truncated}` }
  },
}
