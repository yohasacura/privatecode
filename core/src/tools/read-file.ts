import { readFile, stat } from 'node:fs/promises'
import { fsErrorReason } from './atomic-write.js'
import { BOM } from './line-endings.js'
import { outlineFile } from '../outline/tree-sitter.js'
import { renderDiff } from './edit-file.js'
import type { Tool } from './types.js'

export interface ReadFileArgs {
  path: string
  start_line?: number
  end_line?: number
  /** Ask for the text again even though it has already been read. See `execute`. */
  full?: boolean
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

/**
 * Above this, a request for a whole file is answered with its structure instead.
 *
 * ~6k tokens, about 5% of the window. Chosen as the point where a file stops being
 * something you read and becomes something you navigate.
 */
const WHOLE_FILE_LIMIT = 24_000
/** Enough to see the imports, the namespace and how the file opens. */
const HEAD_LINES = 50
/** One line of a minified bundle is the whole file; the head must survive that. */
const HEAD_LINE_LIMIT = 300
/** And the head as a whole stays small — this path exists to spend less, not differently. */
const HEAD_CHAR_LIMIT = 4_000

/**
 * What a large file IS, in place of what it contains: its declarations with line numbers,
 * its opening, and the three ways to get the part actually wanted.
 *
 * The line numbers are the point. Every entry doubles as the argument for the next call, so
 * "read the whole thing" turns into "read lines 210-260" without a second round of guessing.
 * A file with no grammar mapped to it (json, markdown, plain text) still gets its head and
 * its options — less useful, and better than 15k tokens of a config file.
 */
async function shapeOf(
  abs: string, path: string, text: string, lines: readonly string[], total: number,
): Promise<string> {
  const parts: string[] = [
    `${path} (${total} lines, ${Math.round(text.length / 1000)}k characters) — too large to ` +
    'put in context whole, so this is its shape.',
  ]

  let outlined = false
  try {
    const result = await outlineFile(abs, text)
    if (Array.isArray(result) && result.length > 0) {
      outlined = true
      parts.push('', 'Declarations:')
      for (const e of result) {
        parts.push(`  ${'  '.repeat(e.depth)}${e.kind} ${e.name}  :${e.line}`)
      }
    }
  } catch { /* no outline is a worse answer, not a failed one */ }

  // Bounded by characters as well as by lines, because "50 lines" is not a bound at all on
  // the file this most often fires for. A minified bundle is one line of three megabytes,
  // and a head that emitted it whole would be a context-saving path that spends more than
  // the read it replaced — caught by the test that has guarded that case since before this
  // function existed.
  const headLines: string[] = []
  let headChars = 0
  for (let i = 0; i < Math.min(HEAD_LINES, total); i++) {
    const raw = lines[i] ?? ''
    const clipped = raw.length > HEAD_LINE_LIMIT
      ? `${raw.slice(0, HEAD_LINE_LIMIT)}… (line is ${raw.length} characters)`
      : raw
    const row = `${i + 1}\t${clipped}`
    if (headChars + row.length > HEAD_CHAR_LIMIT) break
    headLines.push(row)
    headChars += row.length + 1
  }
  parts.push('', `First ${headLines.length} line${headLines.length === 1 ? '' : 's'}:`)
  parts.push(...headLines)

  parts.push(
    '',
    'To read a part of it: read_file with start_line and end_line — the line numbers ' +
    (outlined ? 'above are where each declaration starts. ' : 'in the head above are a start. ') +
    'To find something by name: search_code with path=' + path + '. ' +
    'For C#, csharp_nav answers where a symbol is defined and what references it without ' +
    'reading the file at all.',
  )
  return parts.join('\n')
}

/** Ceiling on the copy the APP shows (`ToolResult.display`). The model's budget bounds what
 * becomes permanent context; this one only bounds what one transcript card can weigh. */
const MAX_DISPLAY_CHARS = 400_000

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
    `${MAX_LINES} lines and ${MAX_CHARS} characters per call. Asking for a LARGE file ` +
    'whole returns its structure — declarations with line numbers — instead of its text, ' +
    'so read it by range: everything read stays in context permanently and crowds out ' +
    'your own reasoning. Reading a file you have ALREADY read returns what changed since ' +
    'then, not the file again — pass full: true when you really need the whole text back.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      start_line: { type: 'integer', description: 'First line to return, 1-based.' },
      end_line: { type: 'integer', description: 'Last line to return, inclusive.' },
      full: {
        type: 'boolean',
        description:
          'Return the whole text even if you have already read this file. Reading it again ' +
          'is answered with what CHANGED by default; set this when you need the file itself ' +
          'back in front of you.',
      },
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
    if (r.full === true) args.full = true
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
          // Not `err.message`: raw errno text is `EPERM: operation not permitted, open
          // 'C:\Users\...'` - it spends permanent transcript on a path the model cannot use
          // and buries the one word that says what happened. The two write tools already
          // route through fsErrorReason and assert their messages never contain the root.
          : `Could not read ${args.path}: ${fsErrorReason(abs, e)}`,
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
          // Not `err.message`: raw errno text is `EPERM: operation not permitted, open
          // 'C:\Users\...'` - it spends permanent transcript on a path the model cannot use
          // and buries the one word that says what happened. The two write tools already
          // route through fsErrorReason and assert their messages never contain the root.
          : `Could not read ${args.path}: ${fsErrorReason(abs, e)}`,
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

    // The BOM is the file's encoding marker, not its content, and it must not reach the
    // model: it made line 1 arrive with an invisible U+FEFF glued to its front, so an
    // anchor the model copied back from line 1 could never match exactly. Two bugs were
    // cancelling — edit_file holds the file's own BOM aside, and its whitespace-tolerant
    // fallback then matched the BOM-carrying anchor anyway, reporting "matched only after
    // ignoring whitespace" for an anchor that was in fact verbatim. edit_file and
    // write_file put the BOM back on the way out, so dropping it here loses nothing.
    const decoded = buffer.toString('utf8')
    const text = decoded.startsWith(BOM) ? decoded.slice(1) : decoded
    const lines = splitLines(text)
    const total = lines.length
    const header = `${args.path} (${total} lines)`
    if (total === 0) return { ok: true, content: header }

    // A whole-file read of a big file answers with its SHAPE, not its bytes.
    //
    // This is the one place the tool overrides what was asked, and the reason is measured
    // rather than tidy. Context rot is real for this model family: accuracy falls well
    // before the window is full, and coherent related text — exactly what a transcript of
    // source files is — degrades attention faster than unrelated text. A single 60,000
    // character read is 12% of a 131k window, spent permanently, on a file the model
    // usually needs ten lines of.
    //
    // An explicit range is NOT intercepted: there the model has said what it wants and is
    // entitled to it. This only catches "give me all of it", which is the request that is
    // almost never what was meant.
    const wholeFile = args.start_line === undefined && args.end_line === undefined

    // A second look costs what a second look is worth.
    //
    // Measured over every session this tool has run: one 40k-character file was read whole
    // 31 times in one session — roughly 310k tokens on a 131k window, for one file. The
    // pattern is read, edit, read, edit: the model checking its own work, which was the only
    // way it had. So a repeat is answered with what CHANGED, and `full: true` still returns
    // the text — the model decides, but the cheap answer is the one it gets without asking.
    //
    // Only consulted for a WHOLE-file read, and only populated when the real text was
    // returned (see below): a ranged read showed part of a file, and a large file's read
    // showed only its shape, so neither can honestly be diffed against later.
    if (wholeFile && args.full !== true) {
      const before = ctx.reads?.get(args.path) ?? null
      if (before !== null) {
        if (before === text) {
          return {
            ok: true,
            content:
              `${args.path} is unchanged since you read it earlier in this session — the ` +
              'text you already have is current. Use read_file with full: true if you need ' +
              'it in front of you again.',
          }
        }
        ctx.reads?.record(args.path, text)
        return {
          ok: true,
          content:
            `${args.path} changed since you read it (${total} lines now). What changed:\n` +
            `${renderDiff(before, text, args.path)}\n\n` +
            'Use read_file with full: true for the whole file.',
        }
      }
    }

    if (wholeFile && text.length > WHOLE_FILE_LIMIT) {
      return { ok: true, content: await shapeOf(abs, args.path, text, lines, total) }
    }
    // Recorded only here, where the model is about to be given the actual text.
    if (wholeFile) ctx.reads?.record(args.path, text)

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

    // What the app shows: the whole range that was asked for, not the part that fitted in
    // the model's budget. Bounded independently -- a 10 MB file's full text still must not
    // land in the transcript -- but far above MAX_CHARS.
    const displayRows: string[] = []
    let displayUsed = 0
    for (let i = from; i < to; i++) {
      const row = `${i + 1}\t${lines[i] ?? ''}`
      if (displayUsed + row.length + 1 > MAX_DISPLAY_CHARS) break
      displayRows.push(row)
      displayUsed += row.length + 1
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

    const content = `${header}\n${rows.join('\n')}${notice}`
    const display = `${header}\n${displayRows.join('\n')}`
    return {
      ok: true,
      content,
      ...(display !== content ? { display } : {}),
    }
  },
}
