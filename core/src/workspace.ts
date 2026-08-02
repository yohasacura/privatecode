import { isAbsolute, relative as pathRelative, resolve as pathResolve, sep } from 'node:path'

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
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspaceViolation(
        `path escapes the workspace: ${relativePath} resolves outside ${this.root}`,
      )
    }
    for (const segment of rel.split(sep)) {
      for (const pattern of DENIED_SEGMENTS) {
        if (pattern.test(segment)) {
          throw new WorkspaceViolation(`access denied to ${rel} (matched ${pattern})`)
        }
      }
    }
    return abs
  }

  relative(absolute: string): string {
    return pathRelative(this.root, pathResolve(absolute))
  }
}
