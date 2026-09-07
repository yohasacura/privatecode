import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { execa } from 'execa'
import type { Workspace } from '../workspace.js'
import { canonicalize } from '../workspace.js'
import { gitStage, gitUnstage } from './git.js'
import type { GitMethodMap } from './git-protocol.js'
import * as repo from './git-repo.js'
import { repoRootFor, resolvePanelPath, toplevelOf } from './repos.js'

/**
 * The `git.*` methods beyond the tree's own — one function per wire method, each of them
 * three lines of shape: verify the root, verify the paths, ask git.
 *
 * The root check is the whole security story. A request names its repository by the
 * absolute toplevel `git.status` reported, and a name typed into the wire could be any
 * directory on the machine; so a root is honoured only when it is a repository this
 * workspace touches — the toplevel of one of its writable folders, or a repository nested
 * inside one. Read-only folders are outside by definition: nothing in this file can be
 * addressed to them. Paths are repository-relative and refused when they climb out or
 * when they land in a folder the workspace does not hold, which is the same rule
 * `git.commit` applies to the index.
 */

export class GitRpcError extends Error {}

/** A root this workspace may operate on, canonicalised — or a refusal. */
export async function allowedRoot(workspace: Workspace, root: unknown): Promise<string> {
  if (typeof root !== 'string' || root.trim() === '' || !isAbsolute(root)) throw new GitRpcError('a repository root is an absolute path')
  if (!existsSync(root)) throw new GitRpcError(`${root} does not exist`)
  const wanted = canonicalize(resolve(root))
  for (const mount of workspace.mounts) {
    if (mount.access === 'read') continue
    const mountRoot = canonicalize(resolve(mount.root))
    // The folder's own repository, which may sit ABOVE the folder (a mounted subtree).
    const top = await toplevelOf(mountRoot)
    if (top !== null && canonicalize(top) === wanted) return wanted
    // A repository nested inside the folder.
    if (wanted !== mountRoot && wanted.startsWith(mountRoot + sep) && existsSync(join(wanted, '.git'))) return wanted
  }
  throw new GitRpcError('that repository is not part of this workspace')
}

/** Repository-relative paths, checked to stay inside the repository and the workspace. */
export function checkedPaths(workspace: Workspace, root: string, paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new GitRpcError('no paths')
  const out: string[] = []
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) throw new GitRpcError('a path is a non-empty string')
    if (isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) throw new GitRpcError(`${raw} is not a path inside the repository`)
    const abs = join(root, raw)
    const mount = workspace.mountFor(abs)
    if (mount === undefined || mount.access === 'read') throw new GitRpcError(`${raw} is outside this workspace's folders`)
    out.push(raw.split(sep).join('/'))
  }
  return out
}

type Handlers = { [M in keyof GitMethodMap]: (params: GitMethodMap[M]['params']) => Promise<GitMethodMap[M]['result']> }

async function gitShow(root: string, rev: string, path: string): Promise<{ text: string; problem?: string }> {
  const r = await execa('git', ['show', `${rev}:${path}`], { cwd: root, reject: false, timeout: 30_000, windowsHide: true, encoding: 'utf8', stripFinalNewline: false })
  if (r.exitCode !== 0) return { text: '', problem: r.stderr.trim() || `no ${path} at ${rev}` }
  return { text: r.stdout }
}

/** Where a rev's short name comes from when the marker only shows a sha. */
async function nameOf(root: string, rev: string): Promise<string> {
  const named = await execa('git', ['name-rev', '--name-only', '--refs=refs/heads/*', '--refs=refs/remotes/*', rev], { cwd: root, reject: false, windowsHide: true })
  const name = named.exitCode === 0 ? named.stdout.trim() : ''
  if (name !== '' && name !== 'undefined' && !/~|\^/.test(name)) return name
  const short = await execa('git', ['rev-parse', '--short', rev], { cwd: root, reject: false, windowsHide: true })
  return short.exitCode === 0 ? short.stdout.trim() : rev
}

export function gitHandlers(workspace: () => Workspace): Handlers {
  const rootOf = (p: { root: string }) => allowedRoot(workspace(), p.root)
  const one = (p: { root: string; path: string }, root: string) => checkedPaths(workspace(), root, [p.path])[0]!

  return {
    'git.refs': async (p) => {
      const root = await rootOf(p)
      const refs = await repo.listRefs(root)
      return 'problem' in refs ? { problem: refs.problem } : refs
    },
    'git.log': async (p) => {
      const root = await rootOf(p)
      const { root: _root, ...opts } = p
      if (opts.paths !== undefined) opts.paths = checkedPaths(workspace(), root, opts.paths)
      return repo.readLog(root, opts)
    },
    'git.commitDetails': async (p) => {
      const root = await rootOf(p)
      const d = await repo.commitDetails(root, p.sha)
      return 'problem' in d ? { problem: d.problem } : { details: d }
    },
    'git.diffBetween': async (p) => {
      const root = await rootOf(p)
      return repo.diffBetween(root, p.from, p.to, p.path !== undefined ? one({ root, path: p.path }, root) : undefined)
    },
    'git.compare': async (p) => {
      const root = await rootOf(p)
      const c = await repo.compareRevisions(root, p.from, p.to)
      const [ahead, behind] = await Promise.all([repo.countRange(root, p.from, p.to), repo.countRange(root, p.to, p.from)])
      return { files: c.files, ahead, behind, ...(c.problem !== undefined ? { problem: c.problem } : {}) }
    },
    'git.showFile': async (p) => {
      const root = await rootOf(p)
      return gitShow(root, p.rev, one(p, root))
    },
    'git.switch': async (p) => repo.switchBranch(await rootOf(p), p.name),
    'git.checkoutDetached': async (p) => repo.checkoutDetached(await rootOf(p), p.sha),
    'git.branchCreate': async (p) => repo.createBranch(await rootOf(p), {
      name: p.name, checkout: p.checkout, ...(p.base !== undefined ? { base: p.base } : {}), ...(p.track !== undefined ? { track: p.track } : {}),
    }),
    'git.branchDelete': async (p) => {
      const root = await rootOf(p)
      return p.remote !== undefined ? repo.deleteRemoteBranch(root, p.remote, p.name) : repo.deleteBranch(root, p.name, p.force === true)
    },
    'git.branchRename': async (p) => repo.renameBranch(await rootOf(p), p.name, p.newName),
    'git.setUpstream': async (p) => repo.setUpstream(await rootOf(p), p.branch, p.upstream),
    'git.merge': async (p) => repo.mergeBranch(await rootOf(p), p.branch, { ...(p.noCommit !== undefined ? { noCommit: p.noCommit } : {}) }),
    'git.rebase': async (p) => repo.rebaseOnto(await rootOf(p), p.onto),
    'git.operation': async (p) => repo.operationStep(await rootOf(p), p.action),
    'git.cherryPick': async (p) => repo.cherryPick(await rootOf(p), p.shas),
    'git.revert': async (p) => repo.revertCommit(await rootOf(p), p.sha),
    'git.reset': async (p) => repo.resetTo(await rootOf(p), p.sha, p.mode),
    'git.tagCreate': async (p) => repo.createTag(await rootOf(p), p.name, p.at, p.message),
    'git.tagDelete': async (p) => repo.deleteTag(await rootOf(p), p.name),
    'git.amend': async (p) => repo.amendLast(await rootOf(p), p.message),
    'git.squash': async (p) => repo.squashCommits(await rootOf(p), p.shas, p.message),
    'git.commitIndex': async (p) => {
      const root = await rootOf(p)
      if (p.message.trim() === '' && p.amend !== true) return { ok: false, problem: 'a commit needs a message' }
      if (p.all === true) {
        // Everything the panel lists — and only that: the workspace's own subtrees, so a
        // mounted subdirectory of a monorepo never sweeps the rest of it into the commit.
        const specs = workspace().mounts
          .filter((m) => m.access !== 'read')
          .map((m) => canonicalize(resolve(m.root)))
          .filter((m) => m === root || m.startsWith(root + sep))
          .map((m) => (m === root ? '.' : m.slice(root.length + 1).split(sep).join('/')))
        const add = await execa('git', ['add', '-A', '--', ...(specs.length > 0 ? specs : ['.'])], { cwd: root, reject: false, windowsHide: true })
        if (add.exitCode !== 0) return { ok: false, problem: add.stderr.trim() || 'git add failed' }
      }
      if (p.amend === true) {
        const r = await repo.amendLast(root, p.message.trim() === '' ? undefined : p.message)
        if (!r.ok) return { ok: false, problem: r.problem ?? 'git commit --amend failed' }
      } else {
        const commit = await execa('git', ['commit', '-m', p.message], { cwd: root, reject: false, timeout: 30_000, windowsHide: true, env: { GIT_EDITOR: 'true', LC_ALL: 'C' } })
        if (commit.exitCode !== 0) return { ok: false, problem: (commit.stderr.trim() || commit.stdout.trim()) || 'git commit failed' }
      }
      const head = await execa('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, reject: false, windowsHide: true })
      return { ok: true, ...(head.exitCode === 0 ? { sha: head.stdout.trim() } : {}) }
    },
    'git.stagePaths': async (p) => { const root = await rootOf(p); return gitStage(root, checkedPaths(workspace(), root, p.paths)) },
    'git.unstagePaths': async (p) => { const root = await rootOf(p); return gitUnstage(root, checkedPaths(workspace(), root, p.paths)) },
    'git.discard': async (p) => { const root = await rootOf(p); return repo.discardChanges(root, checkedPaths(workspace(), root, p.paths)) },
    'git.fetch': async (p) => repo.fetchRemote(await rootOf(p), { ...(p.remote !== undefined ? { remote: p.remote } : {}), ...(p.prune !== undefined ? { prune: p.prune } : {}) }),
    'git.pull': async (p) => repo.pullRemote(await rootOf(p), { ...(p.rebase !== undefined ? { rebase: p.rebase } : {}) }),
    'git.push': async (p) => {
      const { root: _root, ...opts } = p
      return repo.pushRemote(await rootOf(p), opts)
    },
    'git.sync': async (p) => {
      const root = await rootOf(p)
      const pulled = await repo.pullRemote(root, { ...(p.rebase !== undefined ? { rebase: p.rebase } : {}) })
      if (!pulled.ok) return pulled
      const pushed = await repo.pushRemote(root)
      return pushed.ok ? { ok: true, output: [pulled.output, pushed.output].filter((s) => s).join('\n') } : pushed
    },
    'git.stashList': async (p) => repo.listStashes(await rootOf(p)),
    'git.stashPush': async (p) => {
      const { root: _root, ...opts } = p
      return repo.stashPush(await rootOf(p), opts)
    },
    'git.stashApply': async (p) => repo.stashApply(await rootOf(p), p.index, { pop: p.pop, restoreIndex: p.restoreIndex }),
    'git.stashDrop': async (p) => repo.stashDrop(await rootOf(p), p.index),
    'git.stashShow': async (p) => repo.stashShow(await rootOf(p), p.index),
    'git.ignore': async (p) => repo.ignorePattern(await rootOf(p), p.pattern),
    'git.hunk': async (p) => { const root = await rootOf(p); return repo.applyHunk(root, one(p, root), p.hunk, p.mode) },
    'git.blame': async (p) => { const root = await rootOf(p); return repo.blameFile(root, one(p, root)) },
    'git.remotes': async (p) => ({ remotes: await repo.listRemotes(await rootOf(p)) }),
    'git.remoteAdd': async (p) => repo.remoteAdd(await rootOf(p), p.name, p.url),
    'git.remoteSetUrl': async (p) => repo.remoteSetUrl(await rootOf(p), p.name, p.url),
    'git.remoteRename': async (p) => repo.remoteRename(await rootOf(p), p.name, p.newName),
    'git.remoteRemove': async (p) => repo.remoteRemove(await rootOf(p), p.name),
    'git.config': async (p) => repo.readConfig(await rootOf(p)),
    'git.configSet': async (p) => repo.writeConfig(await rootOf(p), p.scope, p.key, p.value),
    'git.init': async (p) => {
      const ws = workspace()
      const mount = ws.mounts.find((m) => m.name === p.mount || canonicalize(resolve(m.root)) === canonicalize(resolve(p.mount)))
      if (mount === undefined) throw new GitRpcError(`"${p.mount}" is not a folder of this workspace`)
      if (mount.access === 'read') throw new GitRpcError(`"${mount.name}" is attached read-only`)
      if (await toplevelOf(mount.root) !== null) return { ok: false, problem: `${mount.name} is already inside a git repository` }
      return repo.initRepository(mount.root, p.defaultBranch)
    },
    'git.version': async () => ({ version: await repo.gitVersion() }),
    'git.conflict': async (p) => {
      const root = await rootOf(p)
      const path = one(p, root)
      const [base, ours, theirs] = await Promise.all([gitShow(root, ':1', path), gitShow(root, ':2', path), gitShow(root, ':3', path)])
      let working = ''
      try { working = readFileSync(join(root, path), 'utf8') } catch { /* deleted on one side */ }
      const operation = await repo.readOperation(root)
      const status = await repo.readStatus(root)
      const branch = 'problem' in status ? null : status.head.branch
      let oursLabel = branch ?? 'HEAD'
      let theirsLabel = 'incoming'
      if (operation === 'merge') theirsLabel = await nameOf(root, 'MERGE_HEAD')
      else if (operation === 'rebase') {
        // While rebasing, "ours" is the branch being rebased ONTO and "theirs" is the commit
        // being replayed — git's naming, kept here so the columns match what `checkout
        // --ours` would do.
        const gitDir = (await execa('git', ['rev-parse', '--git-dir'], { cwd: root, reject: false, windowsHide: true })).stdout.trim()
        const ontoFile = join(root, gitDir, 'rebase-merge', 'onto')
        const onto = existsSync(ontoFile) ? readFileSync(ontoFile, 'utf8').trim() : 'HEAD'
        oursLabel = `${await nameOf(root, onto)} (rebasing onto)`
        theirsLabel = `${await nameOf(root, 'REBASE_HEAD')} (being replayed)`
      } else if (operation === 'cherry-pick') theirsLabel = `${await nameOf(root, 'CHERRY_PICK_HEAD')} (cherry-pick)`
      else if (operation === 'revert') theirsLabel = `revert of ${await nameOf(root, 'REVERT_HEAD')}`
      const problem = [base, ours, theirs].every((s) => s.problem !== undefined) ? `${path} is not conflicted` : undefined
      return {
        base: base.text, ours: ours.text, theirs: theirs.text, working, oursLabel, theirsLabel, operation,
        ...(problem !== undefined ? { problem } : {}),
      }
    },
    'git.resolve': async (p) => {
      const root = await rootOf(p)
      const path = one(p, root)
      if (/^(<{7}|={7}|>{7})( |$)/m.test(p.text)) return { ok: false, problem: 'conflict markers are still in the text' }
      writeFileSync(join(root, path), p.text, 'utf8')
      return gitStage(root, [path])
    },
    'git.keepSide': async (p) => {
      const root = await rootOf(p)
      const path = one(p, root)
      const r = await execa('git', ['checkout', `--${p.side}`, '--', path], { cwd: root, reject: false, windowsHide: true })
      if (r.exitCode !== 0) return { ok: false, problem: r.stderr.trim() || 'git checkout failed' }
      return gitStage(root, [path])
    },
    // The two spellings of one file, translated by the side that knows both. The window
    // addresses files the workspace's way (the tree, the editor tabs) and git its own way
    // (a commit's file list, a blame), and for a nested repository or a mounted subfolder
    // the two differ by exactly the prefix neither side can see alone.
    'git.locate': async (p) => {
      const ws = workspace()
      const none = { root: null, repoPath: null }
      if (typeof p.path !== 'string' || p.path === '') return none
      let abs: string
      try { abs = resolvePanelPath(ws, p.path) } catch { return none }
      const found = await repoRootFor(abs)
      if (found === null) return none
      // Only a repository the workspace touches — the rule every other method applies.
      let root: string
      try { root = await allowedRoot(ws, found) } catch { return none }
      return { root, repoPath: relative(root, canonicalize(abs)).split(sep).join('/') }
    },
    'git.address': async (p) => {
      const root = await rootOf(p)
      const ws = workspace()
      if (!Array.isArray(p.paths)) throw new GitRpcError('no paths')
      return {
        paths: p.paths.map((raw) => {
          if (typeof raw !== 'string' || raw === '' || isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) return null
          const abs = join(root, raw)
          const mount = ws.mountFor(abs)
          return mount === undefined || mount.access === 'read' ? null : ws.display(abs)
        }),
      }
    },
  }
}

export function isGitMethod(method: string): method is keyof GitMethodMap {
  return method.startsWith('git.')
}
