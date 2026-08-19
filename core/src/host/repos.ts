import { execa } from 'execa'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { findNestedRepos } from '../checkpoints/units.js'
import type { Workspace } from '../workspace.js'
import { type GitFileChange, parsePorcelain } from './git.js'

/**
 * Which repositories a workspace actually contains — asked, never assumed.
 *
 * With one folder there was one question: is this a git repository? With five there are as
 * many answers as folders, and they are not the same answer:
 *
 * - the folder IS a repository (the ordinary case)
 * - the folder is a SUBDIRECTORY of one — you mounted `monorepo/packages/api` as a lens
 * - the folder is under no version control at all — a scratch directory, a docs tree
 * - the folder CONTAINS repositories, one or several, at any depth
 * - two folders turn out to be two subtrees of the SAME repository
 *
 * So repositories are discovered per folder and deduplicated by their toplevel, and each one
 * carries the parts of itself that are actually inside the workspace. That last part is what
 * makes the panel honest: mounting one package of a monorepo and being shown the whole
 * monorepo's changes would invite a commit of forty files you never looked at.
 *
 * Read-only folders are left out. Nothing here will ever write to them, and a Changes panel
 * is about your work.
 */

const GIT_TIMEOUT_MS = 15_000

/** One part of a repository that is inside the workspace. */
export interface RepoScope {
  /** The folder it arrived through. */
  mount: string
  /** Where that part sits inside the repository, `''` when it is the whole thing. */
  prefix: string
}

export type RepoRelation = 'folder' | 'above' | 'nested'

export interface WorkspaceRepo {
  /** Absolute toplevel — the id every later call names it by. */
  root: string
  /** What the panel calls it. */
  label: string
  branch: string | null
  relation: RepoRelation
  scopes: RepoScope[]
  /** Changed files, addressed the way the rest of the workspace addresses paths. */
  files: GitFileChange[]
  problem?: string
}

export interface WorkspaceGit {
  repos: WorkspaceRepo[]
  /** Writable folders under no version control. They still get checkpoints; there is simply
   * nothing to commit, and saying so beats an empty panel that looks broken. */
  unversioned: { mount: string }[]
  problems: string[]
}

async function git(cwd: string, args: string[]) {
  return execa('git', args, { cwd, reject: false, timeout: GIT_TIMEOUT_MS, windowsHide: true })
}

/** The repository this directory belongs to, or null. `--show-toplevel` answers the question
 * that matters — where the repository STARTS — which `--is-inside-work-tree` does not. */
async function toplevelOf(dir: string): Promise<string | null> {
  const result = await git(dir, ['rev-parse', '--show-toplevel'])
  if (result.exitCode !== 0) return null
  const out = result.stdout.trim()
  return out === '' ? null : resolve(out)
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && rel !== '' && !rel.includes(':'))
}

function toPrefix(toplevel: string, dir: string): string {
  const rel = relative(toplevel, dir)
  return rel === '' ? '' : rel.split(sep).join('/')
}

/**
 * How a repository is described once it is known where it sits.
 *
 * `above` earns the extra words: "part of monorepo" is the difference between a panel you can
 * trust and one that appears to be showing you a different project than the one you opened.
 */
function describe(
  relation: RepoRelation, toplevel: string, scopes: RepoScope[], workspace: Workspace,
): string {
  const names = scopes.map((s) => s.mount)
  switch (relation) {
    case 'folder':
      return names.join(' + ')
    case 'above':
      return `${names.join(' + ')} — part of ${toplevel.split(/[\\/]/).pop() ?? toplevel}`
    case 'nested':
      // The addressed path, not the folder name: two repositories inside one folder are two
      // sections, and labelling both of them `bundle` is a panel you cannot act on. Caught by
      // driving a workspace whose `bundle` folder held libA and libB.
      return workspace.display(toplevel)
  }
}

/**
 * Every repository this workspace touches, with the changes inside it that belong to the
 * workspace.
 *
 * A file that is in the repository but outside every folder is dropped: it is not part of
 * what you opened, and offering it for commit would be offering work you have not seen.
 * The root of a nested repository is dropped from its parent's listing too — git reports it
 * as one modified entry (a gitlink), which reads as "one changed file" for what is really a
 * whole separate project with its own section further down.
 */
export async function discoverRepos(workspace: Workspace): Promise<WorkspaceGit> {
  const byRoot = new Map<string, WorkspaceRepo>()
  const unversioned: { mount: string }[] = []
  const problems: string[] = []

  for (const mount of workspace.mounts) {
    if (mount.access === 'read') continue

    const own = await toplevelOf(mount.root)
    if (own !== null) {
      const relation: RepoRelation = own === resolve(mount.root) ? 'folder' : 'above'
      const existing = byRoot.get(own)
      if (existing) {
        // Two folders, one repository — one section, two scopes. Two sections would let a
        // commit from either quietly stage the other's files.
        existing.scopes.push({ mount: mount.name, prefix: toPrefix(own, mount.root) })
      } else {
        byRoot.set(own, {
          root: own,
          label: '',
          branch: null,
          relation,
          scopes: [{ mount: mount.name, prefix: toPrefix(own, mount.root) }],
          files: [],
        })
      }
    } else {
      unversioned.push({ mount: mount.name })
    }

    // Independent of the above: a folder can be a repository AND contain others, and a
    // folder that is under no version control at all is exactly where a pile of cloned
    // repositories tends to live.
    for (const nested of await findNestedRepos(mount.root)) {
      if (byRoot.has(nested)) continue
      byRoot.set(nested, {
        root: nested,
        label: '',
        branch: null,
        relation: 'nested',
        scopes: [{ mount: mount.name, prefix: '' }],
        files: [],
      })
    }
  }

  const roots = [...byRoot.keys()]
  for (const repo of byRoot.values()) {
    repo.label = describe(repo.relation, repo.root, repo.scopes, workspace)
    // Scoped to the subtrees that are in the workspace. `--porcelain` reports paths relative
    // to the repository root whatever the cwd is, which is what makes the translation below
    // one rule instead of one per scope.
    const pathspecs = repo.scopes.map((s) => (s.prefix === '' ? '.' : s.prefix))
    const result = await git(repo.root, [
      'status', '--porcelain=v1', '--branch', '--', ...pathspecs,
    ])
    if (result.exitCode !== 0) {
      repo.problem = result.stderr.trim() || 'git status failed'
      continue
    }
    const parsed = parsePorcelain(result.stdout)
    repo.branch = parsed.branch
    for (const file of parsed.files) {
      const abs = join(repo.root, file.path)
      // A repository nested INSIDE this one, which git reports here as a single gitlink
      // entry. Its own section has the real story.
      //
      // The containment test runs on the other repository, not only on the file: testing the
      // file alone also dropped every file of a nested repository from its OWN section,
      // because that repository's files are, of course, inside its parent. Caught by the test
      // for a repository vendored inside a repository, which came back empty.
      if (roots.some((r) => r !== repo.root && isInside(r, repo.root) && isInside(abs, r))) continue
      const mount = workspace.mountFor(abs)
      if (mount === undefined) continue // inside the repository, outside the workspace
      // A rename's old path travels along, workspace-addressed like the new one — the
      // unstage of a rename must name both halves. Dropped when the old name falls
      // outside the workspace (renamed INTO a mounted subtree): the caller cannot
      // address what it cannot see, and staging-wise that half is not its to touch.
      const { oldPath: rawOldPath, ...rest } = file
      const oldAbs = rawOldPath !== undefined ? join(repo.root, rawOldPath) : undefined
      repo.files.push({
        ...rest,
        path: workspace.display(abs),
        ...(oldAbs !== undefined && workspace.mountFor(oldAbs) !== undefined
          ? { oldPath: workspace.display(oldAbs) }
          : {}),
      })
    }
  }

  return { repos: [...byRoot.values()], unversioned, problems }
}

/**
 * What git is under one folder, in the words the folder manager shows.
 *
 * The four answers are genuinely different and a person choosing whether to attach a folder
 * wants to know which one they are getting — especially "part of something bigger", which is
 * the one that surprises people.
 */
export async function describeFolder(root: string): Promise<string> {
  const [toplevel, nested] = await Promise.all([toplevelOf(root), findNestedRepos(root)])
  const inside = nested.length === 0
    ? ''
    : ` · ${nested.length} repositor${nested.length === 1 ? 'y' : 'ies'} inside`
  if (toplevel === resolve(root)) return `git repository${inside}`
  if (toplevel !== null) return `part of ${toplevel.split(/[\\/]/).pop() ?? toplevel}${inside}`
  return nested.length === 0 ? 'not under version control' : `not a repository${inside}`
}

/**
 * The repository that owns one file, asked of git directly.
 *
 * One process instead of re-running the whole discovery: `git.diff` fires on every expanded
 * row, and a directory scan per click is not something a panel can afford. It is also more
 * precise — `--show-toplevel` from the file's own directory lands on the nested repository
 * that actually holds it, without any of the enclosing-unit reasoning.
 *
 * The walk up matters: for a file deleted TOGETHER WITH ITS DIRECTORY the parent no longer
 * exists, git cannot run there at all, and the answer used to be "not a repository" — which
 * made a whole-directory deletion impossible to stage or diff from the panel.
 */
export async function repoRootFor(absolutePath: string): Promise<string | null> {
  let dir = dirname(absolutePath)
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return toplevelOf(dir)
}

/**
 * Turns workspace-addressed paths back into what git in `repoRoot` calls them.
 *
 * A path that is not inside this repository is REFUSED rather than skipped: the caller is
 * committing, and quietly dropping one of the files someone selected produces a commit that
 * does not contain what its author believes it contains.
 */
export function toRepoPaths(
  workspace: Workspace, repoRoot: string, paths: readonly string[],
): { ok: true; paths: string[] } | { ok: false; problem: string } {
  const out: string[] = []
  for (const path of paths) {
    let abs: string
    try {
      abs = workspace.resolve(path)
    } catch (e) {
      return { ok: false, problem: (e as Error).message }
    }
    if (!isInside(abs, repoRoot)) {
      return { ok: false, problem: `${path} is not in this repository; commit it from its own section` }
    }
    out.push(relative(repoRoot, abs).split(sep).join('/'))
  }
  return { ok: true, paths: out }
}
