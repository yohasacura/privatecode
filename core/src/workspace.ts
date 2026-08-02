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
 * True for an 8.3 short name such as `ENV~1`, `ENV~1.PRO` or `SERVER~1.PEM`. Those alias
 * denied long names (`.env`, `.env.production`, `server.pem`) and are accepted by every
 * Windows file API, so they have to be refused outright: the aliased target cannot be
 * known when the file does not exist yet, and this is a denylist, so it fails closed.
 */
function isShortNameAlias(segment: string): boolean {
  const dot = segment.lastIndexOf('.')
  const base = dot === -1 ? segment : segment.slice(0, dot)
  const extension = dot === -1 ? '' : segment.slice(dot + 1)
  // A short name is at most 8 characters plus an optional 3 character extension, and
  // never holds more than one dot.
  if (base.includes('.') || base.length > 8 || extension.length > 3) return false
  return /~\d+$/.test(base)
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
  if (isShortNameAlias(opened)) {
    throw new WorkspaceViolation(
      `access denied to ${path} (segment "${segment}" is an 8.3 short name and may alias a denied file)`,
    )
  }
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
      const parent = dirname(current)
      if (parent === current) return target
      pending.unshift(basename(current))
      current = parent
    }
  }
}

export class Workspace {
  readonly root: string

  constructor(root: string) {
    this.root = pathResolve(root)
  }

  resolve(relativePath: string): string {
    const abs = isAbsolute(relativePath)
      ? pathResolve(relativePath)
      : pathResolve(this.root, relativePath)

    const rel = pathRelative(this.root, abs)
    // The root addresses itself: '', '.', './' and the root's own absolute path.
    if (rel === '') return this.root
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspaceViolation(
        `path escapes the workspace: ${relativePath} resolves outside ${this.root}`,
      )
    }
    for (const segment of rel.split(sep)) {
      assertSegmentAllowed(segment, rel)
    }

    // Everything above is lexical, and lexical checks cannot see through a directory
    // junction (which `mklink /J` creates without any privilege) or an 8.3 alias. Redo
    // both checks against the name the filesystem reports.
    const canonicalRel = pathRelative(canonicalize(this.root), canonicalize(abs))
    if (canonicalRel !== '') {
      if (canonicalRel.startsWith('..') || isAbsolute(canonicalRel)) {
        throw new WorkspaceViolation(
          `path escapes the workspace: ${relativePath} resolves outside ${this.root} once links are followed`,
        )
      }
      for (const segment of canonicalRel.split(sep)) {
        assertSegmentAllowed(segment, canonicalRel)
      }
    }

    return abs
  }

  relative(absolute: string): string {
    return pathRelative(this.root, pathResolve(absolute))
  }
}
