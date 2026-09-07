import { execa } from 'execa'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Mount } from '../src/mounts.js'
import { GitRpcError, gitHandlers } from '../src/host/git-rpc.js'
import { discoverRepos } from '../src/host/repos.js'
import { Workspace } from '../src/workspace.js'

/**
 * One workspace, five kinds of git under it, every operation addressed to the right one.
 *
 * The folders: `app` is a repository with another repository vendored inside it; `api` is
 * a subdirectory of a bigger repository (`mono`) mounted on its own; `work` is a plain
 * folder holding two cloned repositories; `notes` is under no version control. Each
 * scenario below is one thing a person does in such a workspace, checked at the level of
 * what git then says — a stash in one clone must not touch the other, Commit All from a
 * mounted subfolder must not sweep the rest of the monorepo in, a conflict in one
 * repository must not read as a conflict in the workspace.
 */

let base: string
const paths = {} as { app: string; lib: string; mono: string; api: string; work: string; one: string; two: string; notes: string }

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await execa('git', args, { cwd, env: { GIT_EDITOR: 'true' } })
  return r.stdout
}
async function repoAt(path: string, file = 'seed.txt'): Promise<string> {
  mkdirSync(path, { recursive: true })
  await git(path, ['init', '--quiet', '--initial-branch=main'])
  await git(path, ['config', 'user.name', 'test'])
  await git(path, ['config', 'user.email', 'test@test'])
  await git(path, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(path, file), 'seed\n', 'utf8')
  await git(path, ['add', '-A'])
  await git(path, ['commit', '--quiet', '-m', 'init'])
  return path
}
const write = (path: string, body: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body, 'utf8')
}
const mount = (name: string, root: string, primary = false): Mount => ({ name, root, access: 'write', primary })
const lower = (s: string | null | undefined): string => (s ?? '').toLowerCase()

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'pc-multi-'))
  paths.app = await repoAt(join(base, 'app'), 'main.txt')
  paths.lib = await repoAt(join(base, 'app', 'vendor', 'lib'), 'lib.txt')
  paths.mono = await repoAt(join(base, 'mono'), 'root.txt')
  write(join(paths.mono, 'packages', 'api', 'a.ts'), 'a\n')
  write(join(paths.mono, 'packages', 'web', 'w.ts'), 'w\n')
  await git(paths.mono, ['add', '-A'])
  await git(paths.mono, ['commit', '--quiet', '-m', 'packages'])
  paths.api = join(paths.mono, 'packages', 'api')
  paths.work = join(base, 'work')
  paths.one = await repoAt(join(paths.work, 'one'))
  paths.two = await repoAt(join(paths.work, 'two'))
  paths.notes = join(base, 'notes')
  mkdirSync(paths.notes)
  writeFileSync(join(paths.notes, 'todo.md'), '- x\n', 'utf8')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

function workspace(): Workspace {
  return new Workspace([
    mount('app', paths.app, true), mount('api', paths.api), mount('work', paths.work), mount('notes', paths.notes),
  ])
}
const handlers = () => gitHandlers(workspace)
const repoOf = async (root: string) => (await discoverRepos(workspace())).repos.find((r) => lower(r.root) === lower(root))

describe('a workspace with several repositories', () => {
  test('every repository is its own section, labelled by where it is, and the plain folders are named as such', async () => {
    const found = await discoverRepos(workspace())
    const byLabel = new Map(found.repos.map((r) => [r.label, r]))
    expect([...byLabel.keys()].sort()).toEqual(['api — part of mono', 'app', 'app/vendor/lib', 'work/one', 'work/two'])
    expect(byLabel.get('app')?.relation).toBe('folder')
    expect(byLabel.get('app/vendor/lib')?.relation).toBe('nested')
    expect(byLabel.get('api — part of mono')?.relation).toBe('above')
    expect(byLabel.get('work/one')?.relation).toBe('nested')
    expect(found.unversioned.map((u) => u.mount).sort()).toEqual(['notes', 'work'])
  })

  test('a change in the vendored repository is that repository\'s, not one gitlink in its parent', async () => {
    write(join(paths.lib, 'lib.txt'), 'changed\n')
    write(join(paths.app, 'main.txt'), 'changed\n')
    const app = await repoOf(paths.app)
    const lib = await repoOf(paths.lib)
    expect(app?.files.map((f) => f.path)).toEqual(['app/main.txt'])
    expect(lib?.files.map((f) => `${f.path} = ${f.repoPath}`)).toEqual(['app/vendor/lib/lib.txt = lib.txt'])

    // Stage and commit in the vendored repository only, by git's spelling of the path.
    const h = handlers()
    expect(await h['git.stagePaths']({ root: paths.lib, paths: ['lib.txt'] })).toMatchObject({ ok: true })
    expect(await h['git.commitIndex']({ root: paths.lib, message: 'lib change', all: false })).toMatchObject({ ok: true })
    expect((await repoOf(paths.lib))?.files).toEqual([])
    expect((await repoOf(paths.app))?.files.map((f) => f.path)).toEqual(['app/main.txt'])
    expect(await git(paths.lib, ['log', '--format=%s', '-1'])).toBe('lib change')
    expect(await git(paths.app, ['log', '--format=%s', '-1'])).toBe('init')
  })

  test('Commit All from a mounted subfolder commits that subtree and nothing else of the monorepo', async () => {
    write(join(paths.mono, 'packages', 'api', 'a.ts'), 'a2\n')
    write(join(paths.mono, 'packages', 'web', 'w.ts'), 'w2\n')
    const api = await repoOf(paths.mono)
    // The panel lists only what is inside the workspace.
    expect(api?.files.map((f) => `${f.path} = ${f.repoPath}`)).toEqual(['api/a.ts = packages/api/a.ts'])

    const h = handlers()
    expect(await h['git.commitIndex']({ root: paths.mono, message: 'api only', all: true })).toMatchObject({ ok: true })
    expect((await git(paths.mono, ['show', '--stat', '--format=', 'HEAD'])).includes('packages/api/a.ts')).toBe(true)
    expect((await git(paths.mono, ['show', '--stat', '--format=', 'HEAD'])).includes('web')).toBe(false)
    expect(await git(paths.mono, ['status', '--porcelain'])).toBe(' M packages/web/w.ts')

    // The two spellings, both ways.
    expect(await h['git.locate']({ path: 'api/a.ts' })).toMatchObject({ repoPath: 'packages/api/a.ts' })
    expect(lower((await h['git.locate']({ path: 'api/a.ts' })).root)).toBe(lower(paths.mono))
    expect((await h['git.address']({ root: paths.mono, paths: ['packages/api/a.ts', 'packages/web/w.ts'] })).paths).toEqual(['api/a.ts', null])
  })

  test('a stash in one clone leaves the clone beside it alone', async () => {
    write(join(paths.one, 'seed.txt'), 'one changed\n')
    write(join(paths.two, 'seed.txt'), 'two changed\n')
    const h = handlers()
    expect(await h['git.stashPush']({ root: paths.one, message: 'wip one', keepIndex: false, includeUntracked: true })).toMatchObject({ ok: true })
    expect((await repoOf(paths.one))?.files).toEqual([])
    expect((await repoOf(paths.two))?.files.map((f) => f.path)).toEqual(['work/two/seed.txt'])
    expect((await h['git.stashList']({ root: paths.one })).stashes).toHaveLength(1)
    expect((await h['git.stashList']({ root: paths.two })).stashes).toHaveLength(0)
    expect((await repoOf(paths.one))?.stashes).toBe(1)
    expect((await repoOf(paths.two))?.stashes).toBe(0)
  })

  test('a merge that stops on conflicts in one clone is that clone\'s state alone, and is finished there', async () => {
    await git(paths.two, ['checkout', '--quiet', '-b', 'topic'])
    write(join(paths.two, 'seed.txt'), 'topic\n')
    await git(paths.two, ['commit', '--quiet', '-am', 'topic'])
    await git(paths.two, ['checkout', '--quiet', 'main'])
    write(join(paths.two, 'seed.txt'), 'main\n')
    await git(paths.two, ['commit', '--quiet', '-am', 'main'])

    const h = handlers()
    const merged = await h['git.merge']({ root: paths.two, branch: 'topic' })
    expect(merged.ok).toBe(false)
    expect(merged.conflict).toBe(true)
    const two = await repoOf(paths.two)
    const one = await repoOf(paths.one)
    expect(two?.operation).toBe('merge')
    expect(two?.files.map((f) => f.code)).toEqual(['UU'])
    expect(one?.operation).toBeNull()
    expect(one?.files).toEqual([])

    const sides = await h['git.conflict']({ root: paths.two, path: 'seed.txt' })
    expect(sides.ours.trim()).toBe('main')
    expect(sides.theirs.trim()).toBe('topic')
    expect(await h['git.keepSide']({ root: paths.two, path: 'seed.txt', side: 'theirs' })).toMatchObject({ ok: true })
    expect(await h['git.operation']({ root: paths.two, action: 'continue' })).toMatchObject({ ok: true })
    expect((await repoOf(paths.two))?.operation).toBeNull()
    expect(await git(paths.two, ['log', '--format=%s', '-1'])).toMatch(/Merge branch 'topic'/)
  })

  test('a folder under no version control becomes a repository from the panel and takes its place among the others', async () => {
    const h = handlers()
    expect(await h['git.init']({ mount: 'notes' })).toMatchObject({ ok: true })
    const found = await discoverRepos(workspace())
    expect(found.unversioned.map((u) => u.mount)).toEqual(['work'])
    const notes = found.repos.find((r) => r.label === 'notes')
    expect(notes?.relation).toBe('folder')
    expect(notes?.head.unborn).toBe(true)
    expect(notes?.files.map((f) => f.path)).toEqual(['notes/todo.md'])
    // And `work` itself cannot be made one: its clones are inside it, but it is a plain folder
    // — allowed, since nothing above it is a repository.
    expect(await h['git.init']({ mount: 'work' })).toMatchObject({ ok: true })
    // Whereas a folder already inside a repository is refused.
    expect(await h['git.init']({ mount: 'api' })).toMatchObject({ ok: false })
  })

  test('a repository the workspace does not touch is refused by name, wherever it is', async () => {
    const outside = await repoAt(join(base, 'elsewhere'))
    const h = handlers()
    await expect(h['git.refs']({ root: outside })).rejects.toBeInstanceOf(GitRpcError)
    // A subfolder of a repository is not a root either.
    await expect(h['git.refs']({ root: paths.api })).rejects.toBeInstanceOf(GitRpcError)
    // Every root the workspace does hold is accepted, spelled as discovery spelled it.
    for (const root of [paths.app, paths.lib, paths.mono, paths.one, paths.two]) {
      expect('problem' in (await h['git.refs']({ root }))).toBe(false)
    }
  })
})
