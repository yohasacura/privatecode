import { readFile, stat } from 'node:fs/promises'
import { applySearchReplace } from '../edit/search-replace.js'
import { opensAsWorkspaceRoot } from '../workspace.js'
import { writeFileAtomic, fsErrorReason } from './atomic-write.js'
import { BOM, applyEndings, detectEndings, toLf } from './line-endings.js'
import type { ApprovalPreview, PermissionKey, Tool } from './types.js'

export interface EditFileArgs {
  path: string
  search_text: string
  replace_text: string
}

/**
 * The same ceiling read_file applies, for the same reason: the file is about to be held in
 * memory as a string, twice over. Duplicated rather than shared because read_file owns its
 * own constants; the two must not drift.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024

/** How many leading bytes the "is this actually text?" sniff inspects. Matches read_file. */
const SNIFF_BYTES = 4096

/**
 * Ceiling on the rendered diff. A diff is a receipt, not content: the model already holds
 * both search_text and replace_text, and everything returned lands in an append-only
 * transcript. Unbounded, an eleven-character edit to a one-line minified file rendered
 * 1.6 million characters — twenty-six times read_file's entire per-call budget.
 */
const MAX_DIFF_CHARS = 4_000

/** Ceiling on one rendered row, so a single minified line cannot blow the budget alone. */
const MAX_DIFF_LINE_CHARS = 400

/** Mirrors read_file's size wording so the two tools describe the same file the same way. */
function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Why the head of this file is not UTF-8 text, or null if it looks like text. Kept in step
 * with read_file's sniff of the same name: read_file refusing a file that edit_file will
 * happily rewrite is precisely the hole this closes.
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
 * A text's lines for diffing, with the empty element a terminal newline produces dropped.
 *
 * Keeping that element is what makes a pure deletion render a trailing bare `-` and `+`:
 * two rows that correspond to nothing in the file and that the model has to work out are
 * artifacts. Dropping it means the presence of a final newline is invisible to the line
 * diff, which renderDiff reports separately rather than silently.
 */
function toDiffLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function clipRow(row: string): string {
  if (row.length <= MAX_DIFF_LINE_CHARS) return row
  const dropped = row.length - MAX_DIFF_LINE_CHARS
  return `${row.slice(0, MAX_DIFF_LINE_CHARS)} ... (+${dropped} more characters on this line)`
}

/**
 * Minimal unified-diff rendering, enough for the model and the UI to see what changed, and
 * bounded so that seeing it costs a fixed amount of context.
 *
 * Both texts are LF-normalised by the caller, so the diff describes content only and never
 * shows a change that is purely a line ending.
 */
export function renderDiff(before: string, after: string, path: string): string {
  const head = `--- ${path}\n+++ ${path}`
  const a = toDiffLines(before)
  const b = toDiffLines(after)

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  // `>=`, not `>`: a deletion's common suffix must be allowed to consume the whole of one
  // side, or the diff repeats the lines after the change as both removed and added.
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  const removed = a.slice(start, endA + 1)
  const added = b.slice(start, endB + 1)

  if (removed.length === 0 && added.length === 0) {
    // A header over an empty body is the one output the model cannot read: it cannot tell
    // an applied edit from a rejected one. Say which of the two this is.
    if (before === after) {
      return `${head}\n(no change: the replacement produced text identical to the original, ` +
        `so ${path} is unchanged)`
    }
    const was = before.endsWith('\n') ? 'present' : 'absent'
    const now = after.endsWith('\n') ? 'present' : 'absent'
    return `${head}\n(only the final newline changed: ${was} -> ${now})`
  }

  const rows = [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)]
  const shown: string[] = []
  let used = 0
  for (const row of rows) {
    const clipped = clipRow(row)
    if (used + clipped.length + 1 > MAX_DIFF_CHARS) break
    shown.push(clipped)
    used += clipped.length + 1
  }
  const elided = rows.length - shown.length
  const notice = elided === 0
    ? ''
    : `\n... (${elided} more diff lines not shown; this diff is capped at ` +
      `${MAX_DIFF_CHARS} characters — the edit itself was applied in full)`

  return `${head}\n@@ line ${start + 1} @@\n${shown.join('\n')}${notice}`
}

export const editFileTool: Tool<EditFileArgs> = {
  name: 'edit_file',
  readOnly: false,
  description:
    'Replace an exact fragment of a file. search_text must be copied verbatim from the ' +
    'file and must identify exactly one place — include surrounding lines if it would ' +
    'otherwise be ambiguous. This is the cheapest way to change code; do not rewrite ' +
    'whole files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      search_text: { type: 'string', description: 'Exact text to find, copied from the file.' },
      replace_text: { type: 'string', description: 'Text that replaces it.' },
    },
    required: ['path', 'search_text', 'replace_text'],
  },
  validate(raw) {
    const r = raw as Partial<EditFileArgs>
    if (typeof r?.path !== 'string' || r.path.trim() === '') {
      return { ok: false, error: 'path must be a non-empty workspace-relative path' }
    }
    if (typeof r?.search_text !== 'string' || r.search_text.trim() === '') {
      return {
        ok: false,
        error: 'search_text must be a non-empty fragment copied verbatim from the file',
      }
    }
    if (typeof r?.replace_text !== 'string') {
      return { ok: false, error: 'replace_text must be a string (use "" to delete)' }
    }
    if (r.search_text === r.replace_text) {
      return { ok: false, error: 'search_text and replace_text are identical; this edit is a no-op' }
    }
    return {
      ok: true,
      args: { path: r.path, search_text: r.search_text, replace_text: r.replace_text },
    }
  },
  permissionKey(args): PermissionKey {
    return { tool: 'edit_file', paths: [args.path] }
  },
  approvalPreview(args): ApprovalPreview {
    const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n... (clipped)` : s)
    return {
      summary: `edit ${args.path}`,
      detail: `edit_file ${args.path}\n<<<<<<< SEARCH\n${clip(args.search_text, 1_500)}\n` +
              `=======\n${clip(args.replace_text, 1_500)}\n>>>>>>> REPLACE`,
    }
  },
  async execute(args, ctx) {
    let abs: string
    try {
      abs = ctx.workspace.resolveForWrite(args.path)
    } catch (e) {
      return { ok: false, content: (e as Error).message }
    }

    // The workspace root itself is not a file, whether or not it exists on disk. When the
    // root exists, the isDirectory() check below happens to catch this anyway — but a root
    // that does not exist yet throws ENOENT first, and that path used to be safe here only
    // by accident (it happens to produce a "File not found" message rather than touching
    // the disk). Naming the root explicitly means the refusal rests on containment, not on
    // whichever accident of control flow the root's current existence happens to trigger.
    //
    // Compared against the path Windows would actually *open*, not the string that was
    // typed: Windows strips trailing dots and spaces before opening, so `<root>\. ` is the
    // root. Raw equality missed that, and `path: ". "` reached the disk (measured: it
    // created a root-level entry literally named `. `). workspace.ts already owns this rule.
    if (opensAsWorkspaceRoot(abs, ctx.workspace.root)) {
      return {
        ok: false,
        content:
          `${args.path} resolves to the workspace root, not a file; edit_file changes ` +
          'files, not the workspace itself',
      }
    }

    // Stat first: the size has to be known before the bytes are in memory, and a directory
    // has to be named as one rather than surfacing as an errno from the read.
    let size: number
    try {
      const info = await stat(abs)
      if (info.isDirectory()) {
        return { ok: false, content: `${args.path} is a directory; edit_file changes files` }
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
          ? `File not found: ${args.path}. Use write_file to create it.`
          : `Could not read ${args.path}: ${fsErrorReason(abs, e)}`,
      }
    }

    if (size > MAX_FILE_BYTES) {
      return {
        ok: false,
        content:
          `${args.path} is ${describeBytes(size)}; edit_file refuses files larger than ` +
          `${describeBytes(MAX_FILE_BYTES)}, the ceiling read_file applies. An anchor cannot ` +
          'have been copied out of a file this size, because read_file refuses it too.',
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
          ? `File not found: ${args.path}. Use write_file to create it.`
          : `Could not read ${args.path}: ${fsErrorReason(abs, e)}`,
      }
    }

    // Read as bytes and prove they are text before rewriting them as text. `readFile(abs,
    // 'utf8')` maps every invalid byte to U+FFFD and the write puts it back as EF BF BD,
    // so editing a PNG used to report success while destroying the header. The sniff is
    // read_file's, so the two tools agree about what they will touch; the round-trip check
    // then catches what a 4 KB sniff cannot — a stray Latin-1 byte with no NUL near it.
    const reason = notTextReason(buffer.subarray(0, SNIFF_BYTES))
    if (reason) {
      return {
        ok: false,
        content:
          `Cannot edit ${args.path} (${describeBytes(size)}): ${reason}. edit_file rewrites ` +
          'the whole file as UTF-8 text, which would destroy it.',
      }
    }
    const raw = buffer.toString('utf8')
    if (!Buffer.from(raw, 'utf8').equals(buffer)) {
      return {
        ok: false,
        content:
          `Cannot edit ${args.path} (${describeBytes(size)}): it is not valid UTF-8. Decoding ` +
          'it replaces bytes with U+FFFD, and writing it back would corrupt the file.',
      }
    }

    // A UTF-8 BOM is whitespace to the whitespace-tolerant matcher, so a line-1 anchor
    // matches and the rebuilt line comes back without it. MSBuild reads the BOM as
    // meaningful, so it is held aside rather than left in the text to be trimmed away.
    const hasBom = raw.charCodeAt(0) === 0xfeff
    const body = hasBom ? raw.slice(1) : raw

    // read_file splits on /\r?\n/, so the model never sees a carriage return and the anchor
    // it copies back is always LF-joined — against a CRLF file that anchor cannot match
    // any line boundary, on either the exact or the whitespace-tolerant path, and the
    // not-found hint tells the model to do exactly what it just did. Matching happens on
    // LF text and the file's own ending is restored on the way out, which is also what
    // stops a fallback edit from converting the lines it touched.
    const endings = detectEndings(body)
    const lfBody = toLf(body)
    const search = toLf(args.search_text)
    const replace = toLf(args.replace_text)

    const outcome = applySearchReplace(lfBody, search, replace)
    if (!outcome.ok) {
      return { ok: false, content: `edit_file could not apply the change: ${outcome.hint}` }
    }

    const restored = applyEndings(outcome.text, endings.eol)
    const next = hasBom ? `${BOM}${restored}` : restored

    if (next !== raw) {
      try {
        await writeFileAtomic(abs, next, ctx.workspace)
      } catch (e) {
        // Unwrapped, this leaked an absolute path into the permanent transcript and lost
        // the one fact the model needs: the file it asked about is still intact.
        return {
          ok: false,
          content:
            `Could not write ${args.path}: ${fsErrorReason(abs, e)}. ` +
            `${args.path} is unchanged.`,
        }
      }
    }

    // Formatting happens HERE, between the write and the diff, which is the whole point of
    // it living in the tool: `renderDiff` below is then rendered against the file as it now
    // exists on disk, so the text the model is shown is the text its next SEARCH anchor
    // will have to match. A formatter that ran after this result was built would leave the
    // diff describing bytes that are no longer there.
    let finalText = outcome.text
    const formatNotes: string[] = []
    if (next !== raw && ctx.format) {
      const formatted = await ctx.format.run(args.path, ctx.signal)
      if (formatted.note !== undefined) formatNotes.push(formatted.note)
      if (formatted.text !== null && formatted.changed) {
        // Compared in the same normalised space `renderDiff` works in, so a formatter that
        // only rewrote line endings does not show up as a change to every line.
        const body = formatted.text.charCodeAt(0) === 0xfeff ? formatted.text.slice(1) : formatted.text
        finalText = toLf(body)
      }
    }

    const notes: string[] = [...formatNotes]
    if (!outcome.matchedExactly) notes.push('the anchor matched only after ignoring whitespace')
    if (endings.crlf > 0 && endings.lf > 0) {
      notes.push(
        `mixed line endings (${endings.crlf} CRLF, ${endings.lf} LF); the whole file was ` +
        `written back as ${endings.eol === '\r\n' ? 'CRLF' : 'LF'}, the dominant ending`,
      )
    }
    const note = notes.length === 0 ? '' : `\n(note: ${notes.join('; ')})`

    return { ok: true, content: `${renderDiff(lfBody, finalText, args.path)}${note}` }
  },
}
