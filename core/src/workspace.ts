import { realpathSync } from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join as pathJoin,
  relative as pathRelative,
  resolve as pathResolve,
  sep,
} from 'node:path'
import { type Mount, mountName } from './mounts.js'

export class WorkspaceViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceViolation'
  }
}

/**
 * Patterns that are refused regardless of the permission rules, because reading them
 * once is already the damage. Matched against the workspace-relative path, case
 * insensitively, per path segment.
 *
 * Known limitation, accepted deliberately: this is a denylist over *names*, and a
 * hardlink is not a link to a denied file, it is a second equally-real name for the
 * same bytes. `mklink /H notes.txt .env` succeeds without admin rights and produces a
 * `notes.txt` whose canonical form (`realpathSync.native`) is `notes.txt`, not `.env` —
 * there is nothing for canonicalization to see through, because there is no alias
 * relationship, just two directory entries pointing at the same inode. This vector is
 * not closed here, and deliberately so: an `nlink > 1` backstop would also reject
 * ordinary, legitimately hardlinked files, and pnpm lays out `node_modules` using
 * hardlinks, so that check would break normal JavaScript workspaces. The same mechanism
 * defeats containment, not just the name denylist: `mklink /H <root>\innocent.txt
 * <a file outside the root>` produces a path `resolve()` accepts as inside the workspace
 * whose bytes come from outside it. Bounded to files on the same volume; directories
 * cannot be hardlinked. The vector is also unreachable from the tools this workspace
 * currently exposes (nothing here can create a link), and once a tool exists that can
 * run arbitrary shell commands it bypasses this jail far more directly than a hardlink
 * would. Callers must not treat this denylist as a capability boundary against an actor
 * able to create filesystem links — it is a best-effort guard against accidental or
 * lexical access, not a security boundary against a deliberate adversary with
 * link-creation ability.
 */
const DENIED_SEGMENTS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /^id_rsa$/i,
  /^id_ed25519$/i,
  /\.pem$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /^\.npmrc$/i,
  /^credentials$/i,
]

/**
 * Windows strips trailing dots and spaces when it opens a file, so `.env.` and `.env `
 * both reach `.env`. Strip them before matching, or the denylist matches the string the
 * caller typed instead of the file the OS opens.
 */
const TRAILING_DOTS_AND_SPACES = /[. ]+$/

/**
 * `.privatecode/` holds the file the next session reads its `permissions`, `hooks` and
 * `format` rules from — and hook and format commands run with no permission gate at all,
 * so a write there is a write to the permission system itself.
 *
 * The permission engine denies those writes already, but it matches the path the model
 * SPELLED after a purely lexical canonicalize. On NTFS the same directory also answers to
 * its 8.3 alias: measured, `write_file({path:'PRIVAT~1/settings.json'})` was decided
 * `allow (mode)` in auto-edit and replaced the real `.privatecode/settings.json`, whose
 * planted `format` command then ran through powershell with no engine in the path.
 *
 * Deliberately NOT added to `DENIED_SEGMENTS`: that list guards reads too, and reading
 * one's own settings is legitimate. This is the write chokepoint, and it denies writes.
 */
const ANY_PRIVATE_DIR_SEGMENT = /(^|[\\/])\.privatecode([\\/]|$)/i

/**
 * Whether `abs` is a path the OS would open as `root` itself.
 *
 * Answers for ONE folder root. A caller holding a `Workspace` must ask it instead
 * (`mountRootFor`): `Workspace.root` is the primary folder only, so a guard written against
 * it says "no" for every attached folder — see the note on `mountRootFor`.
 *
 * `abs === root` is a string comparison, and Windows strips trailing dots and spaces
 * before it opens a path (see TRAILING_DOTS_AND_SPACES above), so `<root>\. ` opens the
 * root. Measured: `write_file` with `path: ". "` passed a raw-equality guard and created a
 * root-level entry literally named `. `; `edit_file` had the same hole.
 *
 * Compared with `pathRelative(...) === ''` rather than `===` because a string comparison is
 * also case-SENSITIVE, and Windows is not: an absolute `D:\ENGINE\. ` for a folder recorded
 * as `D:\engine` strips to a path that differs from the root only in case, which raw
 * equality passes as "not the root". `pathRelative` is the same test `mountFor` and
 * `resolveIn` already use, so all three agree about what "is the root" means on each
 * platform.
 *
 * Deliberately slightly over-strict on POSIX, where `. ` is an ordinary filename and does
 * not address the parent: refusing to *write a file called `. `* costs nothing, and the
 * target platform is Windows.
 */
export function opensAsWorkspaceRoot(abs: string, root: string): boolean {
  return pathRelative(root, pathResolve(abs.replace(TRAILING_DOTS_AND_SPACES, ''))) === ''
}

/**
 * Refuse a single path segment that names something other than the plain file it appears
 * to name. Applied to the caller's spelling and again to the canonical one.
 */
function assertSegmentAllowed(segment: string, path: string): void {
  if (segment.includes(':')) {
    // `.env::$DATA` opens `.env`. No workspace-relative path needs an alternate data
    // stream, so the whole shape is refused rather than parsed.
    throw new WorkspaceViolation(
      `access denied to ${path} (segment "${segment}" names an alternate data stream)`,
    )
  }
  const opened = segment.replace(TRAILING_DOTS_AND_SPACES, '')
  // An 8.3 short name such as `ENV~1` is not matched here on the caller's literal
  // spelling: it is caught one layer up, in resolve(), where the path is re-checked
  // against `canonicalize()`'s output. `realpathSync.native` expands the alias to its
  // real long name (`ENV~1` -> `.env`), and that canonical segment is run back through
  // this same function, so it hits the DENIED_SEGMENTS loop below on the name it
  // actually aliases. A short name that does not exist yet aliases nothing, so there is
  // nothing to deny — see the "lexical 8.3 rule" note in workspace.test.ts for the
  // verification that canonicalization alone covers this without false denials on real
  // `~N` filenames.
  for (const pattern of DENIED_SEGMENTS) {
    if (pattern.test(opened)) {
      throw new WorkspaceViolation(`access denied to ${path} (matched ${pattern})`)
    }
  }
}

/**
 * The path Windows would actually open: the deepest ancestor that exists, resolved with
 * `realpathSync.native` so junctions, symlinks and 8.3 aliases collapse to their real
 * long names, with the not-yet-existing remainder rejoined. Paths that do not exist yet
 * are the normal case for a write, so a missing target is not an error here.
 */
function canonicalize(target: string): string {
  const pending: string[] = []
  let current = target
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return pending.length === 0 ? real : pathJoin(real, ...pending)
    } catch {
      // Windows strips trailing dots and spaces when it opens a file (see
      // TRAILING_DOTS_AND_SPACES above), but realpathSync.native does not tolerate them
      // and fails outright on a name like `ENV~1.`. Retry once with the same stripping
      // applied to the final segment before walking up a level: otherwise a trailing
      // dot or space would hide whatever that segment aliases (an 8.3 short name, a
      // junction) from every check below, even though Windows itself opens the file.
      const strippedBase = basename(current).replace(TRAILING_DOTS_AND_SPACES, '')
      if (strippedBase !== basename(current) && strippedBase !== '') {
        try {
          const real = realpathSync.native(pathJoin(dirname(current), strippedBase))
          return pending.length === 0 ? real : pathJoin(real, ...pending)
        } catch {
          // Stripped name doesn't exist either; fall through and walk up.
        }
      }
      const parent = dirname(current)
      if (parent === current) return target
      pending.unshift(basename(current))
      current = parent
    }
  }
}

/** `''`, `'.'`, `'./'` — the workspace itself rather than anything inside it. */
export function isRootPath(path: string): boolean {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  return trimmed === '' || trimmed === '.'
}

export class Workspace {
  /** Primary first. A single-folder workspace has exactly one. */
  readonly mounts: readonly Mount[]
  /** The primary folder — where `.privatecode/` lives and what every existing caller means
   * by "the workspace root". */
  readonly root: string

  constructor(rootOrMounts: string | readonly Mount[]) {
    if (typeof rootOrMounts === 'string') {
      const root = pathResolve(rootOrMounts)
      this.mounts = [{ name: mountName(root, new Set()), root, access: 'write', primary: true }]
      this.root = root
      return
    }
    if (rootOrMounts.length === 0) throw new Error('a workspace needs at least one folder')
    this.mounts = rootOrMounts.map((m) => ({ ...m, root: pathResolve(m.root) }))
    this.root = this.mounts[0]!.root
  }

  /** More than one folder, which is what makes the `<folder>/` prefix mandatory. */
  get multi(): boolean {
    return this.mounts.length > 1
  }

  /**
   * The folder whose own root this path opens as, if any — as opposed to `mountFor`, which
   * answers for anything *inside* a folder.
   *
   * Every mount, not just the primary. `resolve('engine')` deliberately returns the engine
   * folder's own root, and the write tools each carried their own
   * `opensAsWorkspaceRoot(abs, workspace.root)` guard, where `root` is `mounts[0].root`. So
   * with D:\engine attached to a workspace whose primary is C:\proj, that guard compared
   * D:\engine against C:\proj, said "not the root", and `delete_file({ path: 'engine',
   * recursive: true })` removed the entire attached project — permanently, delete_file
   * having no checkpoint, and in autopilot with no approval card in the way. A workspace
   * folder is never a file, whichever folder it is.
   */
  mountRootFor(absolutePath: string): Mount | undefined {
    return this.mounts.find((m) => opensAsWorkspaceRoot(absolutePath, m.root))
  }

  /** The folder a resolved absolute path belongs to. Mounts never overlap, so at most one. */
  mountFor(absolutePath: string): Mount | undefined {
    const abs = pathResolve(absolutePath)
    return this.mounts.find((m) => {
      const rel = pathRelative(m.root, abs)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
  }

  /**
   * How a path is written back to the model: `api/src/server.ts` in a multi-folder workspace,
   * `src/server.ts` in a single-folder one. Forward slashes throughout, matching what
   * `find_files` has always emitted.
   */
  display(absolutePath: string): string {
    const abs = pathResolve(absolutePath)
    const mount = this.mountFor(abs)
    if (mount === undefined) return abs
    const rel = pathRelative(mount.root, abs).split(sep).join('/')
    if (!this.multi) return rel === '' ? '.' : rel
    return rel === '' ? mount.name : `${mount.name}/${rel}`
  }

  private mountNames(): string {
    return this.mounts.map((m) => (m.access === 'read' ? `${m.name} (read-only)` : m.name)).join(', ')
  }

  /**
   * A model-written path to an absolute one, or a `WorkspaceViolation`.
   *
   * In a multi-folder workspace the first segment is the folder name and is REQUIRED. An
   * unprefixed path is refused rather than assumed to mean the primary folder: a write that
   * silently landed in the wrong repository is the failure this rules out, and the refusal
   * carries the list of names, so the cost of being strict is one wasted step.
   */
  resolve(relativePath: string): string {
    if (!this.multi) return this.resolveIn(this.mounts[0]!, relativePath, relativePath)

    if (isAbsolute(relativePath)) {
      const mount = this.mountFor(relativePath)
      if (mount === undefined) {
        throw new WorkspaceViolation(
          `path escapes the workspace: ${relativePath} is not inside any of its folders (${this.mountNames()})`,
        )
      }
      return this.resolveIn(mount, relativePath, relativePath)
    }

    if (isRootPath(relativePath)) {
      throw new WorkspaceViolation(
        `this workspace has several folders, so "${relativePath}" does not name one; start the path with a folder name (${this.mountNames()})`,
      )
    }

    const cut = relativePath.search(/[\\/]/)
    const head = cut === -1 ? relativePath : relativePath.slice(0, cut)
    const rest = cut === -1 ? '' : relativePath.slice(cut + 1)
    const mount = this.mounts.find((m) => m.name.toLowerCase() === head.toLowerCase())
    if (mount === undefined) {
      throw new WorkspaceViolation(
        `"${head}" is not a folder in this workspace; every path must start with one of: ${this.mountNames()}`,
      )
    }
    return this.resolveIn(mount, rest, relativePath)
  }

  /**
   * `resolve`, and then a refusal if the folder was attached read-only, or if the path
   * addresses a folder's own root rather than something inside it.
   *
   * This sits in the jail rather than in the permission engine on purpose: a rule can be
   * written, remembered and granted, and a reference folder that a rule could open is not a
   * reference folder. Binds the file tools only — `run_command` was never contained here.
   *
   * The folder-root refusal is here rather than in each tool for the same reason it is not a
   * rule: every write tool had its own copy of the check, every copy compared against the
   * PRIMARY root, and an attached folder equals that root only in a single-folder workspace.
   * One check at the chokepoint every write goes through (`edit_file`, `write_file`,
   * `delete_file`, `move_file` both endpoints, and `writeFileAtomic`'s re-resolve) covers
   * every folder, including for callers that never thought about mounts at all.
   */
  resolveForWrite(relativePath: string): string {
    const abs = this.resolve(relativePath)
    const mount = this.mountFor(abs)
    // The name the filesystem reports, not the one the model typed -- see
    // ANY_PRIVATE_DIR_SEGMENT. `resolve` has already canonicalized this path once to check
    // for escapes; it did not check WHAT it landed on, because reads are allowed to land
    // there. One extra realpath per write, against a write.
    const canonicalRel =
      mount === undefined ? abs : pathRelative(canonicalize(mount.root), canonicalize(abs))
    if (ANY_PRIVATE_DIR_SEGMENT.test(canonicalRel)) {
      throw new WorkspaceViolation(
        `access denied to ${relativePath}: it is inside .privatecode, where this workspace ` +
        'keeps its permission, hook and format settings. Those are the user\'s to change, ' +
        'not yours — ask them, or use the settings UI.',
      )
    }
    if (mount?.access === 'read') {
      throw new WorkspaceViolation(
        `"${mount.name}" is attached read-only, so nothing can be written to ${relativePath}. ` +
        'Read it, quote it, copy from it — but the change has to land in a writable folder.',
      )
    }
    const folder = this.mountRootFor(abs)
    if (folder !== undefined) {
      throw new WorkspaceViolation(
        this.multi
          ? `"${relativePath}" is the root of the folder "${folder.name}" itself, not a file in ` +
            'it; a folder of this workspace cannot be written to, moved onto or deleted as if ' +
            'it were a file. Name a path inside it.'
          : `"${relativePath}" is the workspace root itself, not a file in it; the workspace ` +
            'root cannot be written to, moved onto or deleted as if it were a file. Name a ' +
            'path inside it.',
      )
    }
    return abs
  }

  /** The original single-root jail, now applied within one mount. */
  private resolveIn(mount: Mount, relativePath: string, spelledAs: string): string {
    const abs = isAbsolute(relativePath)
      ? pathResolve(relativePath)
      : pathResolve(mount.root, relativePath)

    const rel = pathRelative(mount.root, abs)
    // The root addresses itself: '', '.', './' and the root's own absolute path.
    if (rel === '') return mount.root
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspaceViolation(
        `path escapes the workspace: ${spelledAs} resolves outside ${mount.root}`,
      )
    }
    for (const segment of rel.split(sep)) {
      assertSegmentAllowed(segment, rel)
    }

    // Everything above is lexical, and lexical checks cannot see through a directory
    // junction (which `mklink /J` creates without any privilege) or an 8.3 alias. Redo
    // both checks against the name the filesystem reports.
    const canonicalRel = pathRelative(canonicalize(mount.root), canonicalize(abs))
    if (canonicalRel !== '') {
      if (canonicalRel.startsWith('..') || isAbsolute(canonicalRel)) {
        throw new WorkspaceViolation(
          `path escapes the workspace: ${spelledAs} resolves outside ${mount.root} once links are followed`,
        )
      }
      for (const segment of canonicalRel.split(sep)) {
        assertSegmentAllowed(segment, canonicalRel)
      }
    }

    return abs
  }
}
