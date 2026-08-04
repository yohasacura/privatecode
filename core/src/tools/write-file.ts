import { mkdir, open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { opensAsWorkspaceRoot } from '../workspace.js'
import { writeFileAtomic, fsErrorReason } from './atomic-write.js'
import { BOM, applyEndings, detectEndings, toLf } from './line-endings.js'
import type { ApprovalPreview, PermissionKey, Tool } from './types.js'

export interface WriteFileArgs {
  path: string
  content: string
}

/**
 * How much of the head of an existing file is inspected to learn its shape.
 *
 * Bounded rather than a full read: this runs on every overwrite, the file may be up to
 * MAX_FILE_BYTES, and nothing beyond the head changes the answer in any realistic file. A
 * file whose first 64 KB is CRLF and whose remainder is LF-dominant would be classified by
 * its head; that is a deliberate trade, and it is the same answer a human would give.
 */
const DETECT_BYTES = 64 * 1024

/** The shape of an existing text file that a whole-file rewrite has to put back. */
interface ExistingShape {
  bom: boolean
  /** The dominant ending, or null when the file has no line endings to preserve. */
  eol: '\n' | '\r\n' | null
}

/**
 * The line endings and BOM of the file about to be replaced, or null if there is nothing
 * to learn from it.
 *
 * Returns null for a file whose head contains NUL bytes: that file has no line structure
 * to preserve, and inferring one from stray CR/LF bytes inside binary data would be
 * inventing a shape rather than keeping one. Also returns null if the file cannot be
 * opened — the write itself will fail and report that properly.
 */
async function readExistingShape(abs: string): Promise<ExistingShape | null> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(abs, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(DETECT_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, DETECT_BYTES, 0)
    const head = buffer.subarray(0, bytesRead)
    if (head.includes(0)) return null
    // A multi-byte character clipped by the 64 KB bound decodes to U+FFFD, which affects
    // neither the BOM test (position 0) nor the CR/LF counts.
    const text = head.toString('utf8')
    const endings = detectEndings(text)
    return {
      bom: text.charCodeAt(0) === 0xfeff,
      eol: endings.crlf + endings.lf === 0 ? null : endings.eol,
    }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * The same ceiling read_file and edit_file apply, for the same reason: the content is
 * about to be held in memory and then written whole. Duplicated rather than shared — see
 * edit-file.ts's identical constant — so the three tools' ceilings cannot silently drift
 * apart from one shared import changing underneath them.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024

/** Mirrors read_file's and edit_file's size wording so all three describe sizes alike. */
function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const writeFileTool: Tool<WriteFileArgs> = {
  name: 'write_file',
  readOnly: false,
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
  permissionKey(args): PermissionKey {
    return { tool: 'write_file', paths: [args.path] }
  },
  approvalPreview(args): ApprovalPreview {
    const bytes = Buffer.byteLength(args.content, 'utf8')
    const clipped = args.content.length > 1_500
      ? `${args.content.slice(0, 1_500)}\n... (clipped)`
      : args.content
    return {
      summary: `write ${args.path}`,
      detail: `write_file ${args.path} (${bytes} bytes)\n${clipped}`,
    }
  },
  async execute(args, ctx) {
    let abs: string
    try {
      abs = ctx.workspace.resolveForWrite(args.path)
    } catch (e) {
      return { ok: false, content: (e as Error).message }
    }

    // The workspace root itself is not a file, whether or not it exists on disk yet.
    // Without this, a root that does not exist yet slips past the ENOENT guard below with
    // `replaced` still null, and `mkdir(dirname(abs), ...)` then creates directories at the
    // root's own *parent* — outside the workspace — while the atomic temp file is opened
    // there too, before ever being renamed onto the root path itself. Refusing this case up
    // front means the guarantee rests on containment again, not on the root happening to
    // already exist as a directory.
    //
    // Compared against the path Windows would actually *open*: it strips trailing dots and
    // spaces first, so `<root>\. ` is the root. Raw equality missed that, and `path: ". "`
    // reached the disk (measured: it created a root-level entry literally named `. `).
    if (opensAsWorkspaceRoot(abs, ctx.workspace.root)) {
      return {
        ok: false,
        content:
          `${args.path} resolves to the workspace root, not a file; write_file cannot ` +
          'replace the workspace itself',
      }
    }

    const bytes = Buffer.byteLength(args.content, 'utf8')
    if (bytes > MAX_FILE_BYTES) {
      return {
        ok: false,
        content:
          `${args.path} would be ${describeBytes(bytes)}; write_file refuses to create or ` +
          `replace a file larger than ${describeBytes(MAX_FILE_BYTES)}, the ceiling ` +
          'read_file and edit_file both apply.',
      }
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

    // Overwriting an existing file keeps that file's line endings and its BOM. This tool
    // rewrites every line, so normalising the endings turns a one-line change into a
    // whole-file diff — and the design names the user's own git as the only safety net,
    // which a whole-file diff switches off. The BOM is not cosmetic either: MSBuild treats
    // it as meaningful and this workspace is C#/TS on Windows. The model cannot supply
    // either one, because read_file shows it an LF-only, BOM-less view of every file — the
    // same reason edit_file restores them rather than trusting its input, and the same
    // logic, imported rather than copied.
    //
    // A genuinely new file is left exactly as given: there is no existing shape to match,
    // and imposing one would be inventing a convention the workspace never expressed.
    let content = args.content
    const notes: string[] = []
    if (replaced !== null) {
      const shape = await readExistingShape(abs)
      if (shape?.eol) {
        const restored = applyEndings(toLf(content), shape.eol)
        if (restored !== content) {
          content = restored
          notes.push(
            `line endings were normalised to ${shape.eol === '\r\n' ? 'CRLF' : 'LF'}, ` +
            'matching the file that was replaced')
        }
      }
      if (shape?.bom && !content.startsWith(BOM)) {
        content = `${BOM}${content}`
        notes.push("the file's UTF-8 byte-order mark was preserved")
      }
    }
    const written = Buffer.byteLength(content, 'utf8')

    try {
      await mkdir(dirname(abs), { recursive: true })
      await writeFileAtomic(abs, content, ctx.workspace)
    } catch (e) {
      return { ok: false, content: `Could not write ${args.path}: ${fsErrorReason(abs, e)}` }
    }

    const note = notes.length === 0 ? '' : `\n(note: ${notes.join('; ')})`
    return {
      ok: true,
      content: replaced === null
        ? `Wrote ${args.path} (${written} bytes).${note}`
        : `Replaced ${args.path} (${replaced} bytes -> ${written} bytes).${note}`,
    }
  },
}
