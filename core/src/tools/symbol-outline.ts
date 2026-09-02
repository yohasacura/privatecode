import { readFile, stat } from 'node:fs/promises'
import { fsErrorReason } from './atomic-write.js'
import { BOM } from './line-endings.js'
import { outlineFile, SUPPORTED_EXTENSIONS } from '../outline/tree-sitter.js'
import type { Tool } from './types.js'

export interface SymbolOutlineArgs {
  path: string
}

/** Above this a file is refused outright, before it is read into memory. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const SUPPORTED_LIST = SUPPORTED_EXTENSIONS.join(' ')

export const symbolOutlineTool: Tool<SymbolOutlineArgs> = {
  name: 'symbol_outline',
  readOnly: true,
  description:
    'Extract a structural outline (classes, methods, functions, interfaces, enums, ...) ' +
    `from a source file, with nesting shown by indentation. Supports ${SUPPORTED_LIST} ` +
    'files. Faster and shorter than Read for orienting in an unfamiliar file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
    },
    required: ['path'],
  },
  validate(raw) {
    const r = raw as Partial<SymbolOutlineArgs>
    if (typeof r?.path !== 'string' || r.path.trim() === '') {
      return { ok: false, error: 'path must be a non-empty workspace-relative path' }
    }
    return { ok: true, args: { path: r.path } }
  },
  async execute(args, ctx) {
    let abs: string
    try {
      abs = ctx.workspace.resolve(args.path)
    } catch (e) {
      return { ok: false, content: (e as Error).message }
    }

    let size: number
    try {
      const info = await stat(abs)
      if (info.isDirectory()) {
        return { ok: false, content: `${args.path} is a directory; use list_dir` }
      }
      if (!info.isFile()) {
        return { ok: false, content: `${args.path} is not a regular file` }
      }
      size = info.size
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      return {
        ok: false,
        content: err.code === 'ENOENT'
          ? `File not found: ${args.path}`
          : `Could not read ${args.path}: ${fsErrorReason(abs, e)}`,
      }
    }

    if (size > MAX_FILE_BYTES) {
      return {
        ok: false,
        content:
          `${args.path} is ${describeBytes(size)}; symbol_outline refuses files larger ` +
          `than ${describeBytes(MAX_FILE_BYTES)}. Use Read with a line range, or ` +
          'Grep, instead.',
      }
    }

    let buffer: Buffer
    try {
      buffer = await readFile(abs)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      return {
        ok: false,
        content: err.code === 'ENOENT'
          ? `File not found: ${args.path}`
          : `Could not read ${args.path}: ${fsErrorReason(abs, e)}`,
      }
    }

    const decoded = buffer.toString('utf8')
    const source = decoded.startsWith(BOM) ? decoded.slice(1) : decoded

    let result: Awaited<ReturnType<typeof outlineFile>>
    try {
      result = await outlineFile(abs, source)
    } catch (e) {
      return {
        ok: false,
        content: `symbol_outline failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }

    if ('unsupported' in result) {
      return {
        ok: false,
        content:
          `symbol_outline supports ${SUPPORTED_LIST} files; use Read or Grep ` +
          `for ${result.unsupported}`,
      }
    }

    if (result.length === 0) {
      return { ok: true, content: `${args.path} parses but contains no top-level symbols this tool extracts.` }
    }

    const lines = result.map((e) => `${'  '.repeat(e.depth)}${e.kind} ${e.name}  :${e.line}`)
    const lastEntry = result[result.length - 1]
    const isCapped = lastEntry?.kind === '...'
    const realCount = isCapped ? result.length - 1 : result.length
    const header = `${args.path} — ${realCount} symbols${isCapped ? ' (capped at 400)' : ''}`
    return { ok: true, content: `${header}:\n${lines.join('\n')}` }
  },
}
