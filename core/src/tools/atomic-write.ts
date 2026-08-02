import { randomBytes } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Workspace } from '../workspace.js'

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

export async function renameWithRetry(tmp: string, abs: string): Promise<void> {
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
 * Basename for the sibling temp file.
 *
 * The previous scheme, `.${basename(abs)}.<hex>.tmp`, joined the target's own name to the
 * random suffix with a dot. For a target legitimately named `env` that produces
 * `.env.<hex>.tmp` — and the workspace's own denylist refuses `.env` files with
 * `/^\.env(\..+)?$/i`, whose suffix group is an unanchored `\..+` that swallows anything
 * shaped like `.env.<more>`, so that temp name matches it. No secret is exposed by the
 * collision itself — the bytes are the model's own — but if the process dies between
 * `open` and `rename`, the orphan left behind is a hidden dotfile that `Workspace.resolve`
 * then refuses for every tool that might otherwise find and remove it, including this
 * one's own callers.
 *
 * The fixed `.pc-tmp-` prefix and `.tmp` suffix are load-bearing, not decoration: every
 * denylist entry is either an exact whole-segment match (`id_rsa`, `id_ed25519`, `.npmrc`,
 * `credentials`) or anchored at one end (`/^\.env.../`, `/\.pem$/`, `/\.pfx$/`, `/\.p12$/`),
 * so a fixed prefix that is never `.env` and a fixed suffix that is never `.pem`/`.pfx`/
 * `.p12` means no denylist pattern can match *regardless* of what the target is called.
 *
 * A leading dot alone was tried and rejected: `.${targetBasename}~<hex>.tmp` defeats every
 * denylist pattern, but for a target whose own basename already starts with a dot (`.npmrc`,
 * `.env` itself, `.gitignore`, ...) it produces a name starting with two literal dots —
 * `..npmrc~<hex>.tmp` — and `Workspace.resolve` treats any relative path that merely
 * *starts with* the characters `..` as escaping the workspace (`rel.startsWith('..')`),
 * whether or not it is an actual parent-directory segment. That is a second, independent
 * way to mint an orphan no tool can ever see again, caught only because the test enumerates
 * every denylisted stem as a *target* name, not just as a fixed literal. `.pc-tmp-` cannot
 * start with `..` no matter what follows it, so this scheme closes both failure modes at
 * once. Verified in write-tools.test.ts against every denylisted stem, used as the target.
 */
export function tempBasename(targetBasename: string): string {
  return `.pc-tmp-${targetBasename}~${randomBytes(6).toString('hex')}.tmp`
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
 *
 * `abs` is re-resolved through `workspace` before it is ever opened, rather than trusted
 * as-is. Every caller today reaches this function with an `abs` that already came from
 * `Workspace.resolve`, but that is a fact about the callers, not one this function can see
 * for itself — and it is exactly the assumption that broke once before, when a directory
 * that did not yet exist let a caller's own containment check fall through.
 *
 * The whole path is re-resolved, not merely `dirname(abs)`. Resolving only the directory
 * gave containment but not the secrets denylist, because the denylist matches the *file's*
 * own segment: `writeFileAtomic(join(root, '.env'), 'SECRET=1', ws)` wrote the file, with
 * this function's own comment claiming the guarantee held. Neither of today's two callers
 * can reach that, but "the callers get it right" is precisely what re-resolving here
 * exists not to depend on.
 */
export async function writeFileAtomic(abs: string, data: string, workspace: Workspace): Promise<void> {
  const target = workspace.resolve(abs)
  const tmp = join(dirname(target), tempBasename(basename(target)))
  // 'wx' rather than 'w': the cleanup below deletes this path, so it must be a file this
  // call created and not one it happened to find.
  const handle = await open(tmp, 'wx')
  try {
    await handle.writeFile(data, 'utf8')
    // Some filesystems answer EINVAL when fsync is unsupported at all; that alone is not a
    // reason to fail a write that otherwise succeeded. Anything else — an EIO at flush, for
    // instance — is a real failure and has to surface, not be silently treated as success
    // while the rename goes on to commit a file that was never actually flushed.
    await handle.sync().catch((e) => {
      if ((e as NodeJS.ErrnoException).code === 'EINVAL') return
      throw e
    })
    await handle.close()
    await renameWithRetry(tmp, target)
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
