import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Mount } from '../mounts.js'
import { PRIVATE_DIR, statePath } from '../private-dir.js'

/**
 * What the undo store actually snapshots.
 *
 * A shadow git repository cannot cover a directory that is itself a git repository. Measured,
 * in a scratch tree: `git add -A` records a nested repository as `160000 <sha>` — a gitlink,
 * a pointer to a commit — and a rewind restores the pointer and not one file inside it. The
 * outer file came back; the nested one stayed changed, with no warning anywhere. That hole is
 * not new to multi-folder workspaces; it has always been there for anyone whose project
 * contains a vendored repository. A workspace of five folders simply hits it every time.
 *
 * So coverage is a SET of units: every writable folder, plus every repository nested inside
 * one, each with its own shadow store and its own work tree. A unit excludes its immediate
 * children through `$GIT_DIR/info/exclude` — that file rather than the `checkpoints.exclude`
 * the user may edit, because this list is generated and rewritten whenever the shape of the
 * workspace changes. Verified in the same scratch tree: the "adding embedded git repository"
 * warning disappears, both files come back, and the user's own repository is untouched.
 *
 * Read-only folders get no unit at all. Nothing writes there, so there is nothing to undo.
 */

export interface SnapshotUnit {
  /** Stable across runs — it names the shadow store's directory. */
  id: string
  /** The work tree. */
  root: string
  /** What a person reads: the folder name, or `folder/path/to/nested-repo`. */
  label: string
  /** Where the shadow repository lives. Always under the primary folder. */
  gitDir: string
  /** The primary folder — where `.privatecode/` is. Never the unit's own work tree unless the
   * unit IS the primary folder, so an attached project stays free of our files. */
  stateRoot: string
  /** Immediate child units, relative to `root`, for this unit's generated exclude file. */
  excluded: string[]
}

/** Directories never descended into while looking for nested repositories. A repository
 * inside `node_modules` is a dependency, not the user's work. */
const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.gradle', '.terraform', PRIVATE_DIR,
])

/** Deep enough for `packages/x/y`, shallow enough that a walk of a big tree stays cheap. */
const MAX_DEPTH = 6
/** A backstop on pathological trees; past it the scan simply reports what it found. */
const MAX_DIRS = 5_000

/**
 * Every directory strictly inside `root` that is its own git repository.
 *
 * Deliberately keeps descending past one: a repository inside a repository is unusual but
 * real (a vendored dependency that itself vendors one), and stopping at the first would leave
 * exactly the hole this function exists to close.
 */
export async function findNestedRepos(root: string): Promise<string[]> {
  const found: string[] = []
  let budget = MAX_DIRS

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || budget <= 0) return
    budget--
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory: not a reason to fail the whole scan
    }
    // `.git` is a directory in an ordinary clone and a FILE in a worktree or submodule.
    // Both mean "this is a repository boundary".
    if (entries.some((e) => e.name === '.git')) {
      if (resolve(dir) !== resolve(root)) found.push(resolve(dir))
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === '.git' || SKIP_DIRS.has(entry.name.toLowerCase())) continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }

  await walk(resolve(root), 0)
  return found
}

/**
 * Whether `child` is `parent` or below it.
 *
 * `isAbsolute`, not `!rel.includes(':')`: on Windows `relative` answers with an ABSOLUTE
 * path when the two are on different drives, and while such an answer does contain a colon
 * today, the colon is incidental — the property that actually disqualifies it is that it is
 * not a relative path at all. The same test in `Workspace.mountFor` and in
 * `CheckpointSet.inside`, so all three agree about what containment means.
 */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * A shadow store's directory name: readable, and unique even when two folders share a
 * basename. The hash is of the absolute path so the same folder resolves to the same store on
 * every launch — a store that moved would be a history that vanished.
 */
function unitId(label: string, root: string): string {
  const safe = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'folder'
  const hash = createHash('sha1').update(resolve(root).toLowerCase()).digest('hex').slice(0, 8)
  return `${safe}-${hash}`
}

/** The legacy path, kept so an existing workspace does not lose the checkpoints it has. */
const LEGACY_GIT_DIR = 'checkpoints.git'
const UNIT_DIR = 'checkpoints'

/**
 * The single unit a plain workspace has, without a disk scan to find it.
 *
 * For callers that have no mounts and no reason to look for nested repositories — the tests,
 * and any code path that predates folders. Produces exactly the store a single-folder
 * workspace has always had.
 */
export function soleUnit(root: string): SnapshotUnit {
  const abs = resolve(root)
  const label = basename(abs) || abs
  return {
    id: unitId(label, abs),
    root: abs,
    label,
    gitDir: statePath(abs, LEGACY_GIT_DIR),
    stateRoot: abs,
    excluded: [],
  }
}

/**
 * Every unit this workspace needs, primary folder first.
 *
 * The primary folder's own unit keeps the git directory it has always had, so no workspace
 * has to be migrated; every other unit gets one under `.privatecode/checkpoints/`, which means
 * an attached folder never has anything of ours written into it.
 */
export async function discoverUnits(
  mounts: readonly Mount[], primaryRoot: string,
): Promise<SnapshotUnit[]> {
  const writable = mounts.filter((m) => m.access === 'write')
  const units: SnapshotUnit[] = []

  for (const mount of writable) {
    const mountUnit: SnapshotUnit = {
      id: unitId(mount.name, mount.root),
      root: resolve(mount.root),
      label: mount.name,
      gitDir: mount.primary
        ? statePath(primaryRoot, LEGACY_GIT_DIR)
        : statePath(primaryRoot, UNIT_DIR, `${unitId(mount.name, mount.root)}.git`),
      stateRoot: primaryRoot,
      excluded: [],
    }
    units.push(mountUnit)

    for (const repo of await findNestedRepos(mount.root)) {
      const label = `${mount.name}/${relative(mount.root, repo).split(sep).join('/')}`
      units.push({
        id: unitId(label, repo),
        root: repo,
        label,
        gitDir: statePath(primaryRoot, UNIT_DIR, `${unitId(label, repo)}.git`),
        stateRoot: primaryRoot,
        excluded: [],
      })
    }
  }

  // Each unit excludes the units immediately below it — "immediately" meaning no other unit
  // sits between them, so a repo three levels down is excluded by its own parent repo and not
  // twice over by the folder above that.
  for (const unit of units) {
    const enclosing = units
      .filter((u) => u !== unit && contains(u.root, unit.root))
      .sort((a, b) => b.root.length - a.root.length)[0]
    if (enclosing) {
      enclosing.excluded.push(`/${relative(enclosing.root, unit.root).split(sep).join('/')}/`)
    }
  }

  return units
}
