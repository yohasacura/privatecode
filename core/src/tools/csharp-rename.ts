import { open } from 'node:fs/promises'
import { csharpRoot, navProcess, noteWorkspaceWrite, toWorkspacePath } from '../csharp/nav-process.js'
import { writeFileAtomic, fsErrorReason } from './atomic-write.js'
import { BOM } from './line-endings.js'
import type { ApprovalPreview, PermissionKey, Tool } from './types.js'

export interface CsharpRenameArgs {
  symbol: string
  new_name: string
}

/** A C# identifier as the model may spell it; the helper has the last word. */
const IDENTIFIER = /^@?[A-Za-z_][A-Za-z0-9_]*$/

/** Whether the file on disk opens with a UTF-8 byte-order mark, which the renamed text must keep. */
async function hasBom(abs: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(abs, 'r')
  } catch {
    return false
  }
  try {
    const head = Buffer.alloc(3)
    const { bytesRead } = await handle.read(head, 0, 3, 0)
    return bytesRead === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
  } catch {
    return false
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * A rename the compiler performs: every declaration and use of the symbol, in every file,
 * and nothing that merely shares the name.
 *
 * The alternative was what the sessions show — an Edit per site, found by Grep, with the
 * same-named member of another type and the word inside a string caught up in it — or a
 * `replace_all` per file, which is the same thing with fewer steps. Roslyn's own rename
 * knows which tokens ARE the symbol. The helper answers with the new text of each file it
 * changes; this side writes them, keeping each file's line endings (the text keeps them) and
 * its byte-order mark (put back here), tells the index and the C# check that they moved,
 * and asks the compiler at once whether the rename left anything broken — a collision with
 * an existing name is the case worth catching before the model moves on.
 */
export const csharpRenameTool: Tool<CsharpRenameArgs> = {
  name: 'CSharpRename',
  readOnly: false,
  description:
    'Renames a C# type, method, property, field, event or parameter everywhere it is declared and used, ' +
    'through the compiler (Roslyn): every reference in every file, and nothing that only shares the name — ' +
    'a same-named member of another type, a word in a string or comment. One call instead of an Edit per file. ' +
    'The files are written and the compiler check runs on them; the result lists them.',
  parameters: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'The symbol as CSharpNav names it: `Save`, `IInvoiceRepository.Save`, or fully qualified. Must name exactly one symbol.',
      },
      new_name: { type: 'string', description: 'The new identifier.' },
    },
    required: ['symbol', 'new_name'],
  },
  validate(raw) {
    const r = raw as Partial<CsharpRenameArgs>
    if (typeof r?.symbol !== 'string' || r.symbol.trim() === '') {
      return { ok: false, error: 'symbol must be a non-empty name' }
    }
    if (typeof r.new_name !== 'string' || !IDENTIFIER.test(r.new_name.trim())) {
      return { ok: false, error: 'new_name must be a valid C# identifier' }
    }
    return { ok: true, args: { symbol: r.symbol.trim(), new_name: r.new_name.trim() } }
  },
  permissionKey(args): PermissionKey {
    return { tool: 'CSharpRename', target: args.symbol }
  },
  approvalPreview(args): ApprovalPreview {
    return {
      summary: `rename ${args.symbol} → ${args.new_name}`,
      detail:
        `Rename ${args.symbol} to ${args.new_name} in every C# file that declares or uses it, ` +
        'through Roslyn. The files it changes are listed in the result.',
    }
  },
  async execute(args, ctx) {
    const nav = navProcess()
    if (nav === null) {
      return { ok: false, content: 'C# rename is not available in this build (the helper binary is not installed). Use Edit with replace_all per file.' }
    }
    const root = csharpRoot(ctx.workspace)
    let loaded: Record<string, unknown>
    try {
      loaded = await nav.ensureLoaded(root)
    } catch (e) {
      return { ok: false, content: `the C# index could not be built: ${(e as Error).message}` }
    }
    if (loaded['ok'] !== true) {
      return { ok: false, content: `the C# index could not be built: ${String(loaded['error'] ?? 'unknown')}` }
    }

    let reply: Record<string, unknown>
    try {
      reply = await nav.ask('rename', { symbol: args.symbol, newName: args.new_name })
    } catch (e) {
      return { ok: false, content: `rename failed: ${(e as Error).message}` }
    }
    const rel = (p: unknown): string => (typeof p === 'string' ? toWorkspacePath(p, root) : '?')
    const listed = (key: 'suggestions' | 'candidates'): string => {
      const rows = Array.isArray(reply[key]) ? reply[key] as Record<string, unknown>[] : []
      if (rows.length === 0) return ''
      const title = key === 'suggestions' ? 'Close names' : 'Candidates'
      return `\n${title}:\n${rows.map((r) => {
        const loc = (r['located'] ?? {}) as Record<string, unknown>
        return `  ${rel(loc['file'])}:${String(loc['line'])}  ${String(r['signature'] ?? loc['name'])}`
      }).join('\n')}`
    }
    if (reply['ok'] !== true) {
      return { ok: false, content: `rename failed: ${String(reply['error'] ?? 'unknown')}${listed('suggestions')}${listed('candidates')}` }
    }

    const files = Array.isArray(reply['files']) ? reply['files'] as Record<string, unknown>[] : []
    const wrote: string[] = []
    const absWritten: string[] = []
    const receipts: string[] = []
    const refused: string[] = []
    let places = 0
    for (const f of files) {
      const abs = typeof f['file'] === 'string' ? f['file'] : ''
      const text = typeof f['text'] === 'string' ? f['text'] : null
      if (abs === '' || text === null) continue
      const mount = ctx.workspace.mountFor(abs)
      if (mount === undefined || mount.access === 'read') {
        refused.push(rel(abs))
        continue
      }
      const content = (await hasBom(abs)) ? `${BOM}${text}` : text
      try {
        await writeFileAtomic(abs, content, ctx.workspace)
      } catch (e) {
        return {
          ok: false,
          content: `Could not write ${rel(abs)}: ${fsErrorReason(abs, e)}. ` +
            `${wrote.length} file${wrote.length === 1 ? '' : 's'} had already been renamed: ${wrote.join(', ') || 'none'}.`,
          ...(wrote.length > 0 ? { wrote } : {}),
        }
      }
      const path = rel(abs)
      wrote.push(path)
      absWritten.push(abs)
      ctx.reads?.markWritten(path)
      noteWorkspaceWrite(abs)
      const n = typeof f['places'] === 'number' ? f['places'] : 0
      places += n
      const lines = Array.isArray(f['lines']) ? (f['lines'] as number[]).join(', ') : ''
      receipts.push(`  ${path} — ${n} place${n === 1 ? '' : 's'}${lines !== '' ? ` (line${lines.includes(',') ? 's' : ''} ${lines})` : ''}`)
    }
    if (wrote.length === 0) {
      return {
        ok: false,
        content: refused.length > 0
          ? `Nothing renamed: every file that uses ${args.symbol} is in a read-only folder (${refused.join(', ')}).`
          : `Nothing to rename: no file uses ${args.symbol}.`,
      }
    }

    const notes: string[] = []
    if (refused.length > 0) notes.push(`not written, in a read-only folder: ${refused.join(', ')}`)
    const generated = typeof reply['generated'] === 'number' ? reply['generated'] : 0
    if (generated > 0) {
      notes.push(
        `${generated} generated file${generated === 1 ? '' : 's'} (XAML partials, obj/) also use${generated === 1 ? 's' : ''} the old name — ` +
        'the markup they are generated from needs the same change by hand')
    }

    // The compiler, right away: a rename that collides with an existing name, or that a
    // generated file still uses, is broken code the model should hear about now, not at
    // the end of the turn.
    let check = ''
    const diag = await nav.diagnostics(root, absWritten)
    if (diag !== null) {
      if (diag.reported === 0) {
        check = `\nC# compiler check: ok (${(diag.ms / 1000).toFixed(1)}s).`
      } else {
        const shown = diag.errors.slice(0, 10).map((e) =>
          `  ${e.file === '' ? '(no file)' : ctx.workspace.display(e.file)}:${e.line}:${e.column}: ${e.code} ${e.message}`)
        check = `\nC# compiler check after the rename found ${diag.reported} error${diag.reported === 1 ? '' : 's'}:\n${shown.join('\n')}${diag.reported > shown.length ? `\n  … and ${diag.reported - shown.length} more` : ''}`
      }
    }
    const signature = typeof reply['signature'] === 'string' ? reply['signature'] : args.symbol
    return {
      ok: true,
      content:
        `Renamed ${signature} to ${args.new_name} in ${wrote.length} file${wrote.length === 1 ? '' : 's'}, ${places} place${places === 1 ? '' : 's'}:\n` +
        `${receipts.join('\n')}${notes.length > 0 ? `\n(note: ${notes.join('; ')})` : ''}${check}`,
      wrote,
    }
  },
}
