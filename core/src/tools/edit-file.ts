import { readFile, writeFile } from 'node:fs/promises'
import { applySearchReplace } from '../edit/search-replace.js'
import type { Tool } from './types.js'

export interface EditFileArgs {
  path: string
  search_text: string
  replace_text: string
}

/** Minimal unified-diff rendering, enough for the model and the UI to see what changed. */
function renderDiff(before: string, after: string, path: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA > start && endB > start && a[endA] === b[endB]) { endA--; endB-- }
  const removed = a.slice(start, endA + 1).map((l) => `-${l}`)
  const added = b.slice(start, endB + 1).map((l) => `+${l}`)
  return [`--- ${path}`, `+++ ${path}`, `@@ line ${start + 1} @@`, ...removed, ...added].join('\n')
}

export const editFileTool: Tool<EditFileArgs> = {
  name: 'edit_file',
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
  async execute(args, ctx) {
    let abs: string
    try {
      abs = ctx.workspace.resolve(args.path)
    } catch (e) {
      return { ok: false, content: (e as Error).message }
    }
    let before: string
    try {
      before = await readFile(abs, 'utf8')
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      return {
        ok: false,
        content: err.code === 'ENOENT'
          ? `File not found: ${args.path}. Use write_file to create it.`
          : `Could not read ${args.path}: ${err.message}`,
      }
    }

    const outcome = applySearchReplace(before, args.search_text, args.replace_text)
    if (!outcome.ok) {
      return { ok: false, content: `edit_file could not apply the change: ${outcome.hint}` }
    }
    await writeFile(abs, outcome.text, 'utf8')
    const note = outcome.matchedExactly
      ? ''
      : '\n(note: the anchor matched only after ignoring whitespace)'
    return { ok: true, content: `${renderDiff(before, outcome.text, args.path)}${note}` }
  },
}
