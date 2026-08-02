import { readFile, stat } from 'node:fs/promises'
import type { Tool } from './types.js'

export interface ReadFileArgs {
  path: string
  start_line?: number
  end_line?: number
}

/**
 * Ceiling on the lines one call may emit. A ceiling, not a default: `end_line` cannot
 * raise it, because `end_line: 999999` is exactly how a model asks for "the rest".
 */
const MAX_LINES = 2000

/**
 * Ceiling on the characters of numbered body one call may emit. A line cap alone does not
 * bound a response - a single minified line can be megabytes - and everything returned
 * lands in an append-only transcript, so an oversized read is spent context that cannot
 * be reclaimed.
 */
const MAX_CHARS = 60_000

/** Above this a file is refused outright, before it is read into memory. */
const MAX_FILE_BYTES = 10 * 1024 * 1024

/** How many leading bytes the "is this actually text?" sniff inspects. */
const SNIFF_BYTES = 4096

function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Why the head of this file is not UTF-8 text, or null if it looks like text.
 *
 * A NUL byte is the usual binary tell and also catches BOM-less UTF-16, whose ASCII runs
 * are NUL-interleaved; the BOM is tested separately only so the message can name what the
 * file actually is. UTF-16LE is not exotic on this platform - Windows PowerShell `>`
 * redirection writes it - so a log the agent produced itself would otherwise read back as
 * interleaved NULs and poison the transcript as "content".
 */
function notTextReason(head: Buffer): string | null {
  const b0 = head[0]
  const b1 = head[1]
  if (b0 !== undefined && b1 !== undefined) {
    if (b0 === 0xff && b1 === 0xfe) return 'it starts with a UTF-16LE byte-order mark'
    if (b0 === 0xfe && b1 === 0xff) return 'it starts with a UTF-16BE byte-order mark'
  }
  if (head.includes(0)) {
    return `it has NUL bytes in the first ${head.length} bytes, so it is binary`
  }
  return null
}

/**
 * The file's lines as the file actually has them.
 *
 * Splitting on /\r?\n/ keeps carriage returns out of the model's view: the write path owns
 * line endings, and a CR left on a line makes an anchor fed back to the edit engine either
 * fail to match or silently rewrite that line's ending. The single trailing empty element
 * a final newline produces is dropped, so a 5-line file reports 5 lines and an empty file
 * reports none - every consumer that reasons about file length inherits this count.
 */
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export const readFileTool: Tool<ReadFileArgs> = {
  name: 'read_file',
  readOnly: true,
  description:
    'Read a text file from the workspace. Returns lines numbered from 1, at most ' +
    `${MAX_LINES} lines and ${MAX_CHARS} characters per call. Prefer a line range over ` +
    'reading a whole large file: everything read stays in context permanently.',
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
    if (r.start_line !== undefined && r.end_line !== undefined && r.end_line < r.start_line) {
      return {
        ok: false,
        error: `end_line (${r.end_line}) is before start_line (${r.start_line}); an inverted range reads nothing`,
      }
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

    const start = args.start_line ?? 1
    if (args.end_line !== undefined && args.end_line < start) {
      return {
        ok: false,
        content: `end_line (${args.end_line}) is before start_line (${start}); an inverted range reads nothing`,
      }
    }

    // Stat before read: the size must be known before the bytes are in memory, or the
    // budget is consulted after the damage is done.
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
          : `Could not read ${args.path}: ${err.message}`,
      }
    }

    if (size > MAX_FILE_BYTES) {
      return {
        ok: false,
        content:
          `${args.path} is ${describeBytes(size)}; read_file refuses files larger than ` +
          `${describeBytes(MAX_FILE_BYTES)}. Use find_files to locate a smaller file, or ` +
          'work on this one with tools that do not put its bytes in context.',
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
          : `Could not read ${args.path}: ${err.message}`,
      }
    }

    const reason = notTextReason(buffer.subarray(0, SNIFF_BYTES))
    if (reason) {
      return {
        ok: false,
        content:
          `Cannot read ${args.path} (${describeBytes(size)}): ${reason}. ` +
          'read_file returns UTF-8 text only.',
      }
    }

    const lines = splitLines(buffer.toString('utf8'))
    const total = lines.length
    const header = `${args.path} (${total} lines)`
    if (total === 0) return { ok: true, content: header }

    if (start > total) {
      return {
        ok: false,
        content: `${args.path} has ${total} lines; start_line ${start} is past the end of the file`,
      }
    }

    const from = start - 1
    // end_line narrows the window; it can never widen it past the caps below.
    const to = args.end_line === undefined ? total : Math.min(args.end_line, total)

    const rows: string[] = []
    let used = 0
    let next = from
    let stop: 'lines' | 'chars' | 'mid-line' | null = null
    let cutLine = 0
    let cutLength = 0

    for (let i = from; i < to; i++) {
      if (rows.length >= MAX_LINES) {
        stop = 'lines'
        break
      }
      const raw = lines[i] ?? ''
      const row = `${i + 1}\t${raw}`
      const cost = rows.length === 0 ? row.length : row.length + 1
      if (used + cost > MAX_CHARS) {
        if (rows.length === 0) {
          // One line longer than the whole budget. Emit what fits rather than nothing,
          // and say plainly that paging cannot help here.
          rows.push(row.slice(0, MAX_CHARS))
          stop = 'mid-line'
          cutLine = i + 1
          cutLength = raw.length
        } else {
          stop = 'chars'
        }
        break
      }
      rows.push(row)
      used += cost
      next = i + 1
    }

    let notice = ''
    if (stop === 'mid-line') {
      notice =
        `\n... stopped at the ${MAX_CHARS}-character cap partway through line ${cutLine}, ` +
        `which is ${cutLength} characters long; read_file cannot resume inside a line`
    } else if (stop !== null) {
      const cap = stop === 'lines' ? `${MAX_LINES}-line cap` : `${MAX_CHARS}-character cap`
      notice =
        `\n... ${total - next} more lines (stopped at the ${cap}); ` +
        `call read_file again with start_line=${next + 1}`
    }

    return { ok: true, content: `${header}\n${rows.join('\n')}${notice}` }
  },
}
