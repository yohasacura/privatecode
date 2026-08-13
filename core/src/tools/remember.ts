import { addProjectNote } from '../memory/project-notes.js'
import type { Tool } from './types.js'

export interface RememberArgs {
  note: string
  files: string[]
}

/**
 * Write down something about this project that was expensive to work out.
 *
 * The model calls this on its own — no human in the loop — because knowledge that needs
 * asking permission to record does not get recorded, and the whole point is that working on
 * the same project every day should get cheaper.
 *
 * Autonomy is affordable here only because the note cannot rot: it must name the files it
 * came from, their hashes are taken now, and the next session drops it if any of them
 * changed. So the worst a bad note can do is be dropped early or waste a line; it cannot
 * become a confident sentence about code that no longer exists.
 *
 * NOT read-only, and correctly so: it writes a file in the workspace. It is nonetheless
 * unremarkable to approve — the file is ours, in `.privatecode/`, and holds prose.
 */
export const rememberTool: Tool<RememberArgs> = {
  name: 'remember',
  readOnly: false,
  description:
    'Record something durable you worked out about this project — an architectural fact, a ' +
    'convention, a gotcha — so future sessions do not have to derive it again. Give the ' +
    'files you learned it from: the note is dropped automatically when they change, so it ' +
    'can never describe code that has moved on. Use it for what stays true, not for what ' +
    'you did today.',
  parameters: {
    type: 'object',
    properties: {
      note: {
        type: 'string',
        description:
          'One fact, in a sentence or three. "Act numbers are allocated by a row-locked ' +
          'per-tenant counter, separate from the invoice sequence."',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Workspace-relative paths this was learned from. Required — a note that names no ' +
          'file cannot be checked later and is refused.',
      },
    },
    required: ['note', 'files'],
  },
  validate(raw) {
    const r = raw as Partial<RememberArgs>
    if (typeof r?.note !== 'string' || r.note.trim() === '') {
      return { ok: false, error: 'note must be a non-empty statement' }
    }
    if (!Array.isArray(r.files) || r.files.length === 0) {
      return {
        ok: false,
        error: 'files must list at least one workspace-relative path this was learned from',
      }
    }
    const files = r.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
    if (files.length === 0) return { ok: false, error: 'files must contain real paths' }
    return { ok: true, args: { note: r.note.trim(), files } }
  },
  permissionKey() {
    // Keyed on the tool alone: every call writes the same file, and a per-note key would ask
    // the user the same question forever.
    return { tool: 'remember' }
  },
  approvalPreview(args) {
    return {
      summary: `remember: ${args.note.slice(0, 60)}${args.note.length > 60 ? '…' : ''}`,
      detail: `Add to the project notes:\n\n${args.note}\n\nLearned from: ${args.files.join(', ')}`,
    }
  },
  async execute(args, ctx) {
    const result = addProjectNote(ctx.workspace.root, args.note, args.files)
    if (!result.ok) return { ok: false, content: result.problem ?? 'the note was not stored' }
    const caveat = result.problem !== undefined ? ` (${result.problem})` : ''
    return {
      ok: true,
      content:
        `Noted, tied to ${result.note?.evidence.map((e) => e.path).join(', ')}${caveat}. ` +
        'It will be loaded in future sessions until one of those files changes.',
    }
  },
}
