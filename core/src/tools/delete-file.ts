import { navProcess, noteWorkspaceWrite } from '../csharp/nav-process.js'
import { rm, stat } from 'node:fs/promises'
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
      // The jail refuses more than an escape here: a path that opens as a workspace FOLDER's
      // own root comes back as a violation too, so `path: "engine"` cannot remove an attached
      // project. The check this tool used to carry itself compared against the primary root
      // only, which no attached folder is.
      abs = ctx.workspace.resolveForWrite(args.path)
    } catch (e) {
      return { ok: false, content: (e as Error).message }
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

    // The C# index is loaded once per workspace and nothing but this call clears it, so
    // without it `csharp_nav` keeps answering about the file that was just removed — with
    // ok:true, pointing the model at a definition in a path `Read` can no longer open.
    // Edit, Write and move_file all report their writes; deleting a .cs file is the
    // largest invalidation of the lot and was the one that did not.
    if (isDirectory) {
      // `noteWorkspaceWrite` decides on the extension it is handed, and a directory has none
      // — yet a recursive delete may have taken every .cs file in a subtree with it. What was
      // inside cannot be inspected after the fact, so the reload is unconditional; it costs
      // only if a navigation question actually follows.
      navProcess()?.invalidate()
    } else {
      noteWorkspaceWrite(abs)
    }

    return {
      ok: true,
      content: isDirectory
        ? `Deleted ${args.path} (directory, recursive)`
        : `Deleted ${args.path} (${size} bytes)`,
    }
  },
}
