import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic, fsErrorReason } from './atomic-write.js'
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

    // Whether the target already exists, and how big it was. Several paths lead a model to
    // overwrite a file it did not mean to: edit_file's not-found hint points here by name,
    // and read_file caps at 2000 lines, so a model that saw only the head of a long file
    // and then "rewrites" it silently truncates the rest. There is no undo and no
    // checkpoint, so the size it replaced is the only surviving record that it happened —
    // and it has to be in the result, because the result is what stays in the transcript.
    let replaced: number | null = null
    try {
      const info = await stat(abs)
      if (info.isDirectory()) {
        return { ok: false, content: `${args.path} is an existing directory, not a file` }
      }
      if (!info.isFile()) {
        return { ok: false, content: `${args.path} exists and is not a regular file` }
      }
      replaced = info.size
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') {
        return { ok: false, content: `Could not write ${args.path}: ${fsErrorReason(abs, e)}` }
      }
    }

    const bytes = Buffer.byteLength(args.content, 'utf8')
    try {
      await mkdir(dirname(abs), { recursive: true })
      await writeFileAtomic(abs, args.content)
    } catch (e) {
      return { ok: false, content: `Could not write ${args.path}: ${fsErrorReason(abs, e)}` }
    }

    return {
      ok: true,
      content: replaced === null
        ? `Wrote ${args.path} (${bytes} bytes).`
        : `Replaced ${args.path} (${replaced} bytes -> ${bytes} bytes).`,
    }
  },
}
