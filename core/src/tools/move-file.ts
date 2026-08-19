import { noteWorkspaceWrite } from '../csharp/nav-process.js'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, sep } from 'node:path'
import { fsErrorReason, renameWithRetry } from './atomic-write.js'
import type { ApprovalPreview, PermissionKey, Tool } from './types.js'

export interface MoveFileArgs {
  from: string
  to: string
  overwrite?: boolean
}

export const moveFileTool: Tool<MoveFileArgs> = {
  name: 'move_file',
  readOnly: false,
  description:
    'Move or rename a file or directory within the workspace. Refuses to replace an ' +
    'existing target unless overwrite: true is given, and never renames onto a directory. ' +
    'Bytes are moved as-is; nothing is read or reinterpreted.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Workspace-relative path to move.' },
      to: { type: 'string', description: 'Workspace-relative destination path.' },
      overwrite: {
        type: 'boolean',
        description: 'Required to replace an existing file at to. Ignored if to is a directory.',
      },
    },
    required: ['from', 'to'],
  },
  validate(raw) {
    const r = raw as Partial<MoveFileArgs>
    if (typeof r?.from !== 'string' || r.from.trim() === '') {
      return { ok: false, error: 'from must be a non-empty workspace-relative path' }
    }
    if (typeof r?.to !== 'string' || r.to.trim() === '') {
      return { ok: false, error: 'to must be a non-empty workspace-relative path' }
    }
    if (r.overwrite !== undefined && typeof r.overwrite !== 'boolean') {
      return { ok: false, error: 'overwrite must be a boolean when given' }
    }
    const args: MoveFileArgs = { from: r.from, to: r.to }
    if (r.overwrite !== undefined) args.overwrite = r.overwrite
    return { ok: true, args }
  },
  permissionKey(args): PermissionKey {
    return { tool: 'move_file', paths: [args.from, args.to] }
  },
  approvalPreview(args): ApprovalPreview {
    return {
      summary: `move ${args.from} -> ${args.to}`,
      detail: args.overwrite
        ? `Move ${args.from} to ${args.to}, replacing the existing file there.`
        : `Move ${args.from} to ${args.to}.`,
    }
  },
  async execute(args, ctx) {
    // Neither endpoint may be a workspace FOLDER's own root: it is not a file or directory
    // entry that can be renamed away from or onto, whether or not it currently exists on
    // disk. The jail refuses that for both endpoints (see workspace.ts's `resolveForWrite`);
    // the copy of the check this tool used to carry compared against the primary root only,
    // so `from: "engine"` renamed an attached project away.
    let fromAbs: string
    try {
      fromAbs = ctx.workspace.resolveForWrite(args.from)
    } catch (e) {
      return { ok: false, content: (e as Error).message }
    }
    let toAbs: string
    try {
      toAbs = ctx.workspace.resolveForWrite(args.to)
    } catch (e) {
      return { ok: false, content: (e as Error).message }
    }

    try {
      await stat(fromAbs)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      return {
        ok: false,
        content: err.code === 'ENOENT'
          ? `${args.from} not found; nothing to move`
          : `Could not read ${args.from}: ${fsErrorReason(fromAbs, e)}`,
      }
    }

    // Target existence has two independent refusals: a directory target is never a valid
    // rename destination regardless of overwrite (renaming a file onto a directory either
    // fails confusingly or, worse, moves it *inside* the directory depending on platform);
    // a file target is fine to replace, but only when the caller opted in.
    try {
      const info = await stat(toAbs)
      if (info.isDirectory()) {
        return {
          ok: false,
          content:
            `${args.to} is an existing directory; move_file will not rename onto a directory`,
        }
      }
      if (!args.overwrite) {
        return {
          ok: false,
          content: `${args.to} already exists; pass overwrite: true to replace it`,
        }
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') {
        return { ok: false, content: `Could not check ${args.to}: ${fsErrorReason(toAbs, e)}` }
      }
      // ENOENT: no existing target, nothing to refuse.
    }

    // A directory cannot be moved into its own subtree; and if we let it reach mkdir,
    // the parent chain for `to` would be created INSIDE `from` before rename fails —
    // a failed call must not mutate the workspace.
    const fromPrefix = fromAbs.toLowerCase() + sep
    if (toAbs.toLowerCase() === fromAbs.toLowerCase() ||
        toAbs.toLowerCase().startsWith(fromPrefix)) {
      return {
        ok: false,
        content: `Cannot move ${args.from} into itself or its own subtree (${args.to}).`,
      }
    }

    try {
      await mkdir(dirname(toAbs), { recursive: true })
      await renameWithRetry(fromAbs, toAbs)
    } catch (e) {
      return {
        ok: false,
        content: `Could not move ${args.from} to ${args.to}: ${fsErrorReason(toAbs, e)}`,
      }
    }

    noteWorkspaceWrite(args.from)
    noteWorkspaceWrite(args.to)
    return { ok: true, content: `Moved ${args.from} -> ${args.to}` }
  },
}
