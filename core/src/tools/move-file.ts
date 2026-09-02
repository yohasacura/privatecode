import { noteWorkspaceWrite } from '../csharp/nav-process.js'
import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, sep } from 'node:path'
import { fsErrorReason, renameWithRetry } from './atomic-write.js'
import type { ApprovalPreview, PermissionKey, Tool } from './types.js'

/**
 * Remove the directory chain a failed move created, deepest first.
 *
 * `mkdir(..., {recursive:true})` answers with the FIRST directory it had to create, so
 * `rm(that, {recursive:true})` takes the whole chain back out and nothing else. `undefined`
 * means the parent already existed and there is nothing to undo.
 *
 * Failure here is swallowed: the caller is already returning an error about the move, and
 * "could not clean up after the thing that failed" is not the message that helps.
 */
async function undoCreatedDirs(created: string | undefined): Promise<void> {
  if (created === undefined) return
  await rm(created, { recursive: true, force: true }).catch(() => {})
}

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

    // `mkdir` returns the FIRST directory it had to create, or undefined when the parent
    // already existed — which is exactly the record needed to undo it. Without that, a
    // failed move left the destination tree behind: measured across two real volumes,
    // `appC/src/a.ts -> appD/lib/deep/a.ts` came back
    // `EXDEV: cross-device link not permitted` with the source still in place and
    // `appD/lib/deep` newly created, breaking the invariant the comment fifteen lines above
    // states in so many words. A multi-drive workspace is a DESIGNED shape (`FolderSpec`
    // says "absolute otherwise"), so this is reachable by pointing at a second drive.
    let created: string | undefined
    try {
      created = await mkdir(dirname(toAbs), { recursive: true })
    } catch (e) {
      return {
        ok: false,
        content: `Could not move ${args.from} to ${args.to}: ${fsErrorReason(toAbs, e)}`,
      }
    }
    try {
      await renameWithRetry(fromAbs, toAbs)
    } catch (e) {
      // Cross-device: rename cannot do it and never could, so copy the bytes and unlink the
      // source. `cp` recurses, which matters because this tool moves directories too.
      if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
        try {
          await cp(fromAbs, toAbs, { recursive: true, force: true, errorOnExist: false })
          await rm(fromAbs, { recursive: true, force: true })
          noteWorkspaceWrite(fromAbs)
          noteWorkspaceWrite(toAbs)
          return { ok: true, content: `Moved ${args.from} -> ${args.to}` }
        } catch (copyError) {
          await undoCreatedDirs(created)
          return {
            ok: false,
            content: `Could not move ${args.from} to ${args.to}: ${fsErrorReason(toAbs, copyError)}`,
          }
        }
      }
      await undoCreatedDirs(created)
      return {
        ok: false,
        content: `Could not move ${args.from} to ${args.to}: ${fsErrorReason(toAbs, e)}`,
      }
    }

    noteWorkspaceWrite(fromAbs)
    noteWorkspaceWrite(toAbs)
    return { ok: true, content: `Moved ${args.from} -> ${args.to}` }
  },
}
