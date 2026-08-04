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
 * Whether `abs` is a path the OS would open as the workspace root itself.
 *
 * `abs === root` is a string comparison, and Windows strips trailing dots and spaces
 * before it opens a path (see TRAILING_DOTS_AND_SPACES above), so `<root>\. ` opens the
 * root. Measured: `write_file` with `path: ". "` passed a raw-equality guard and created a
 * root-level entry literally named `. `; `edit_file` had the same hole.
 *
 * Deliberately slightly over-strict on POSIX, where `. ` is an ordinary filename and does
 * not address the parent: refusing to *write a file called `. `* costs nothing, and the
 * target platform is Windows.
 */
export function opensAsWorkspaceRoot(abs: string, root: string): boolean {
  return pathResolve(abs.replace(TRAILING_DOTS_AND_SPACES, '')) === root
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
   * `resolve`, and then a refusal if the folder was attached read-only.
   *
   * This sits in the jail rather than in the permission engine on purpose: a rule can be
   * written, remembered and granted, and a reference folder that a rule could open is not a
   * reference folder. Binds the file tools only — `run_command` was never contained here.
   */
  resolveForWrite(relativePath: string): string {
    const abs = this.resolve(relativePath)
    const mount = this.mountFor(abs)
    if (mount?.access === 'read') {
      throw new WorkspaceViolation(
        `"${mount.name}" is attached read-only, so nothing can be written to ${relativePath}. ` +
        'Read it, quote it, copy from it — but the change has to land in a writable folder.',
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
