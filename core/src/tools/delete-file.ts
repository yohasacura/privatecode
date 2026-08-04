import { rm, stat } from 'node:fs/promises'
import { opensAsWorkspaceRoot } from '../workspace.js'
import { fsErrorReason } from './atomic-write.js'
import type { ApprovalPreview, PermissionKey, Tool } from './types.js'

export interface DeleteFileArgs {
  path: string
  recursive?: boolean
}

export const deleteFileTool: Tool<DeleteFileArgs> = {
  name: 'delete_file',
  readOnly: false,
  description:
    'Delete a file, or a directory and everything in it with recursive: true. There is no ' +
    'undo and no checkpoint — this is permanent. Bytes are deleted as-is; nothing is read ' +
    'or reinterpreted first.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path to delete.' },
      recursive: {
        type: 'boolean',
        description: 'Required to delete a directory and everything in it.',
      },
    },
    required: ['path'],
  },
  validate(raw) {
    const r = raw as Partial<DeleteFileArgs>
    if (typeof r?.path !== 'string' || r.path.trim() === '') {
      return { ok: false, error: 'path must be a non-empty workspace-relative path' }
    }
    if (r.recursive !== undefined && typeof r.recursive !== 'boolean') {
      return { ok: false, error: 'recursive must be a boolean when given' }
    }
    const args: DeleteFileArgs = { path: r.path }
    if (r.recursive !== undefined) args.recursive = r.recursive
    return { ok: true, args }
  },
  permissionKey(args): PermissionKey {
    return { tool: 'delete_file', paths: [args.path] }
  },
  approvalPreview(args): ApprovalPreview {
    return {
      summary: `delete ${args.path}`,
      detail: args.recursive
        ? `Permanently delete ${args.path} and everything in it. There is no undo.`
        : `Permanently delete ${args.path}. There is no undo.`,
    }
  },
  async execute(args, ctx) {
    let abs: string
    try {
      abs = ctx.workspace.resolveForWrite(args.path)
    } catch (e) {
      return { ok: false, content: (e as Error).message }
    }

    // The workspace root is not a file or directory this tool may remove, whether or not
    // it exists on disk. Same idiom as edit_file/write_file/move_file.
    if (opensAsWorkspaceRoot(abs, ctx.workspace.root)) {
      return {
        ok: false,
        content:
          `${args.path} resolves to the workspace root, not a file; delete_file cannot ` +
          'delete the workspace itself',
      }
    }

    // Stat first: whether the target is a file or a directory decides which refusal (if
    // any) applies, and a file's size has to be known before rm removes it — it is the
    // only surviving record that the delete happened, there being no checkpoint.
    let isDirectory: boolean
    let size: number
    try {
      const info = await stat(abs)
      isDirectory = info.isDirectory()
      size = info.size
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        return { ok: false, content: `${args.path} is already absent; nothing to delete` }
      }
      return { ok: false, content: `Could not check ${args.path}: ${fsErrorReason(abs, e)}` }
    }

    if (isDirectory && !args.recursive) {
      return {
        ok: false,
        content:
          `${args.path} is a directory; pass recursive: true to delete a directory and ` +
          'everything in it',
      }
    }

    try {
      await rm(abs, { recursive: true, force: false })
    } catch (e) {
      return { ok: false, content: `Could not delete ${args.path}: ${fsErrorReason(abs, e)}` }
    }

    return {
      ok: true,
      content: isDirectory
        ? `Deleted ${args.path} (directory, recursive)`
        : `Deleted ${args.path} (${size} bytes)`,
    }
  },
}
