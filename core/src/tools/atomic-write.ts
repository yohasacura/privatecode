import { randomBytes } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * Codes Windows answers while some other handle on the target is still open. They are not
 * verdicts, they clear in milliseconds — an antivirus scanner opening a file the instant it
 * appears, the search indexer, a watcher, an editor between saves — and the failure is
 * reproducible here: three concurrent runs of the suite make one `rename` onto a
 * just-written target fail this way. A permanent refusal (a read-only file) reports the
 * same EPERM, so the retry budget is deliberately small: 75ms of latency added to a write
 * that was going to fail anyway is cheaper than losing an edit that would have succeeded.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

async function renameWithRetry(tmp: string, abs: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, abs)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 4 || code === undefined || !TRANSIENT_RENAME_CODES.has(code)) throw e
      await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt))
    }
  }
}

/**
 * Replace the contents of `abs` without ever leaving it half written.
 *
 * `fs.writeFile` truncates at open. Between that open and the final byte the file on disk
 * is neither the old content nor the new one — a 24-byte file measures 0 bytes the instant
 * after `open(p, 'w')` — and a crash, an ENOSPC or a killed process inside that window
 * leaves an empty file with nothing to fall back on. These are the only two tools that can
 * destroy the user's work, there are no checkpoints and no undo, and the user's own git is
 * the sole safety net; a window in which the file is empty on disk is not acceptable.
 *
 * Writing a sibling temp file and renaming over the target moves that window onto a file
 * nobody depends on. `rename` replaces the directory entry in one step (MoveFileEx with
 * MOVEFILE_REPLACE_EXISTING on Windows), so a concurrent reader — an editor, a watcher,
 * tsc — sees either the whole old file or the whole new one.
 *
 * The temp file is a sibling rather than a file under the OS temp directory so the rename
 * stays on one volume: across volumes `rename` degrades to copy-then-delete and is not
 * atomic. Its name is unique per call, so two writes in flight against one path cannot
 * collide, and it is removed when anything fails — a failed write leaves the workspace
 * byte-for-byte as it was, including the case that matters most here, a read-only target,
 * where the rename itself answers EPERM.
 *
 * The temp file's data is flushed before the rename. The containing directory is not
 * fsync'd, so this is a guarantee against a crash mid-write, not against a power loss
 * reordering the rename itself — the failure mode the tools actually face.
 */
export async function writeFileAtomic(abs: string, data: string): Promise<void> {
  const tmp = join(dirname(abs), `.${basename(abs)}.${randomBytes(6).toString('hex')}.tmp`)
  // 'wx' rather than 'w': the cleanup below deletes this path, so it must be a file this
  // call created and not one it happened to find.
  const handle = await open(tmp, 'wx')
  try {
    await handle.writeFile(data, 'utf8')
    // Some filesystems answer EINVAL here; a missing flush is not a reason to fail a
    // write that otherwise succeeded.
    await handle.sync().catch(() => {})
    await handle.close()
    await renameWithRetry(tmp, abs)
  } catch (e) {
    await handle.close().catch(() => {})
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

/**
 * Why a filesystem call failed, with the absolute paths Node appends stripped off.
 *
 * Everything a tool returns is permanent transcript, and a raw errno message reads
 * `EPERM: operation not permitted, rename 'C:\Users\...\ro.ts' -> ...`: it spends context
 * on a path the model cannot use, names the temp file rather than the file the model asked
 * about, and buries the one word that says what to do. The caller re-states the
 * workspace-relative path itself.
 */
export function fsErrorReason(abs: string, e: unknown): string {
  const err = e as NodeJS.ErrnoException
  const raw = typeof err?.message === 'string' ? err.message : String(e)
  const cut = raw.indexOf(', ')
  const text = cut === -1 ? raw : raw.slice(0, cut)
  // Belt and braces: anything still carrying the absolute path falls back to the code.
  if (text.includes(abs) || text.includes(dirname(abs))) return err?.code ?? 'the call failed'
  return text
}
