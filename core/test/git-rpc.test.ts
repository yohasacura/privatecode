import { execa } from 'execa'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { allowedRoot, checkedPaths, gitHandlers, isGitMethod } from '../src/host/git-rpc.js'
import { Workspace, canonicalize } from '../src/workspace.js'

/** The spelling git and the host agree on. A GitHub runner's `%TEMP%` is `RUNNER~1`, an
 * 8.3 alias; git answers with the long name, and so does every root the host returns. */
const canon = (p: string): string => canonicalize(p).toLowerCase()

/**
 * The wire for the repository operations: the root check that keeps a request inside the
 * workspace's own repositories, the path check that keeps it inside the workspace's own
 * folders, and a few handlers end to end against real git — enough to show the table is
 * wired, since every operation behind it has its own test in git-repo.test.ts.
 */

let scratch: string
let root: string

async function run(cwd: string, args: string[]): Promise<string> {
  return (await execa('git', args, { cwd, env: { GIT_EDITOR: 'true' } })).stdout
}
const write = (rel: string, body: string): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), body, 'utf8')
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'pc-gitrpc-'))
  root = join(scratch, 'repo')
  mkdirSync(root)
  await run(root, ['init', '--quiet', '--initial-branch=main'])
  await run(root, ['config', 'user.name', 'test'])
  await run(root, ['config', 'user.email', 'test@test'])
  await run(root, ['config', 'core.autocrlf', 'false'])
  write('README.md', 'one\n')
  await run(root, ['add', '-A'])
  await run(root, ['commit', '--quiet', '-m', 'initial'])
})
afterEach(() => { rmSync(scratch, { recursive: true, force: true }) })

describe('the root check', () => {
  test('the folder\'s own repository is allowed, spelled any way', async () => {
    const ws = new Workspace(root)
    expect(await allowedRoot(ws, root)).toBe(await allowedRoot(ws, root.toUpperCase()))
  })

  test('a repository above a mounted subfolder, and one nested inside, are allowed', async () => {
    mkdirSync(join(root, 'sub'))
    write('sub/file.txt', 'x\n')
    const above = new Workspace(join(root, 'sub'))
    expect((await allowedRoot(above, root)).toLowerCase()).toBe(canon(root))

    const nested = join(root, 'vendor', 'lib')
    mkdirSync(nested, { recursive: true })
    await run(nested, ['init', '--quiet'])
    const ws = new Workspace(root)
    expect((await allowedRoot(ws, nested)).toLowerCase()).toBe(canon(nested))
  })

  test('any other directory is refused, repository or not', async () => {
    const elsewhere = join(scratch, 'elsewhere')
    mkdirSync(elsewhere)
    await run(elsewhere, ['init', '--quiet'])
    const ws = new Workspace(root)
    await expect(allowedRoot(ws, elsewhere)).rejects.toThrow('not part of this workspace')
    await expect(allowedRoot(ws, 'relative/path')).rejects.toThrow('absolute path')
    await expect(allowedRoot(ws, join(scratch, 'missing'))).rejects.toThrow('does not exist')
  })
})

describe('the path check', () => {
  test('keeps paths inside the repository and the workspace', () => {
    const ws = new Workspace(root)
    expect(checkedPaths(ws, root, ['a.txt', 'src\\b.ts'])).toEqual(['a.txt', 'src/b.ts'])
    expect(() => checkedPaths(ws, root, ['../out.txt'])).toThrow('not a path inside')
    expect(() => checkedPaths(ws, root, [join(scratch, 'x')])).toThrow('not a path inside')
    expect(() => checkedPaths(ws, root, [])).toThrow('no paths')
  })

  test('a path in the repository but outside the mounted folder is refused', () => {
    mkdirSync(join(root, 'sub'))
    const ws = new Workspace(join(root, 'sub'))
    expect(checkedPaths(ws, root, ['sub/inside.txt'])).toEqual(['sub/inside.txt'])
    expect(() => checkedPaths(ws, root, ['outside.txt'])).toThrow('outside this workspace')
  })
})

describe('the handlers, end to end', () => {
  test('every wire method is a git method and has a handler', () => {
    const table = gitHandlers(() => new Workspace(root))
    for (const name of Object.keys(table)) expect(isGitMethod(name)).toBe(true)
    expect(isGitMethod('sessions.list')).toBe(false)
    expect(Object.keys(table).length).toBeGreaterThan(40)
  })

  test('commit all stages what the panel lists, then commits; the log and refs follow', async () => {
    const h = gitHandlers(() => new Workspace(root))
    write('README.md', 'two\n')
    write('new.txt', 'n\n')
    const r = await h['git.commitIndex']({ root, message: 'commit all', all: true })
    expect(r).toMatchObject({ ok: true })
    const log = await h['git.log']({ root, limit: 5 })
    expect(log.commits.map((c) => c.subject)).toEqual(['commit all', 'initial'])
    const refs = await h['git.refs']({ root })
    expect(refs.local?.map((b) => b.name)).toEqual(['main'])
    const details = await h['git.commitDetails']({ root, sha: log.commits[0]!.sha })
    expect(details.details?.files.map((f) => f.path).sort()).toEqual(['README.md', 'new.txt'])
    expect(await h['git.commitIndex']({ root, message: '   ' })).toMatchObject({ ok: false })
  })

  test('a conflict is served in three sides and resolved from the editor', async () => {
    const h = gitHandlers(() => new Workspace(root))
    await h['git.branchCreate']({ root, name: 'feature', checkout: true })
    write('README.md', 'feature\n')
    await run(root, ['commit', '--quiet', '-am', 'feature'])
    await h['git.switch']({ root, name: 'main' })
    write('README.md', 'main\n')
    await run(root, ['commit', '--quiet', '-am', 'main'])
    expect(await h['git.merge']({ root, branch: 'feature' })).toMatchObject({ ok: false, conflict: true })

    const sides = await h['git.conflict']({ root, path: 'README.md' })
    expect(sides).toMatchObject({ base: 'one\n', ours: 'main\n', theirs: 'feature\n', operation: 'merge', oursLabel: 'main', theirsLabel: 'feature' })
    expect(sides.working).toContain('<<<<<<<')
    expect(await h['git.resolve']({ root, path: 'README.md', text: '<<<<<<< HEAD\nstill\n' })).toMatchObject({ ok: false })
    expect(await h['git.resolve']({ root, path: 'README.md', text: 'main and feature\n' })).toMatchObject({ ok: true })
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('main and feature\n')
    expect(await h['git.operation']({ root, action: 'continue' })).toMatchObject({ ok: true })
    const log = await h['git.log']({ root, limit: 1 })
    expect(log.commits[0]?.parents).toHaveLength(2)
  })

  test('keeping one side resolves without the editor', async () => {
    const h = gitHandlers(() => new Workspace(root))
    await h['git.branchCreate']({ root, name: 'feature', checkout: true })
    write('README.md', 'feature\n')
    await run(root, ['commit', '--quiet', '-am', 'feature'])
    await h['git.switch']({ root, name: 'main' })
    write('README.md', 'main\n')
    await run(root, ['commit', '--quiet', '-am', 'main'])
    await h['git.merge']({ root, branch: 'feature' })
    expect(await h['git.keepSide']({ root, path: 'README.md', side: 'theirs' })).toMatchObject({ ok: true })
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('feature\n')
    await h['git.operation']({ root, action: 'abort' })
  })

  test('init turns an unversioned folder into a repository, once', async () => {
    const plain = join(scratch, 'plain')
    mkdirSync(plain)
    const h = gitHandlers(() => new Workspace(plain))
    expect(await h['git.init']({ mount: plain, defaultBranch: 'trunk' })).toMatchObject({ ok: true })
    expect(existsSync(join(plain, '.git'))).toBe(true)
    expect(await h['git.init']({ mount: plain })).toMatchObject({ ok: false })
    await expect(h['git.init']({ mount: 'nowhere' })).rejects.toThrow('not a folder')
    const version = await h['git.version']({})
    expect(version.version).toMatch(/^git version/)
  })

  test('stash, ignore and blame reach git through the table', async () => {
    const h = gitHandlers(() => new Workspace(root))
    write('README.md', 'changed\n')
    expect(await h['git.stashPush']({ root, message: 'wip' })).toMatchObject({ ok: true })
    expect((await h['git.stashList']({ root })).stashes).toHaveLength(1)
    expect((await h['git.stashShow']({ root, index: 0 })).files.map((f) => f.path)).toEqual(['README.md'])
    expect(await h['git.stashApply']({ root, index: 0, pop: true, restoreIndex: false })).toMatchObject({ ok: true })
    expect(await h['git.ignore']({ root, pattern: 'dist/' })).toMatchObject({ ok: true })
    expect((await h['git.blame']({ root, path: 'README.md' })).lines).toHaveLength(1)
    expect(await h['git.discard']({ root, paths: ['README.md'] })).toMatchObject({ ok: true })
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('one\n')
  })
})

describe('the two spellings of a path', () => {
  test('git.locate names the repository a workspace path is in; git.address goes the other way', async () => {
    const nested = join(root, 'vendor', 'lib')
    mkdirSync(nested, { recursive: true })
    await run(nested, ['init', '--quiet', '--initial-branch=main'])
    writeFileSync(join(nested, 'lib.txt'), 'x\n', 'utf8')
    const ws = new Workspace(root)
    const h = gitHandlers(() => ws)

    // A file of the nested repository: the workspace spelling carries the folder prefix,
    // git's does not.
    const located = await h['git.locate']({ path: 'vendor/lib/lib.txt' })
    expect(located.root?.toLowerCase()).toBe(canon(nested))
    expect(located.repoPath).toBe('lib.txt')
    const back = await h['git.address']({ root: nested, paths: ['lib.txt', '../README.md', 'C:\\elsewhere.txt'] })
    expect(back.paths).toEqual(['vendor/lib/lib.txt', null, null])

    // A file of the folder's own repository.
    expect(await h['git.locate']({ path: 'README.md' })).toMatchObject({ repoPath: 'README.md' })
    expect((await h['git.address']({ root, paths: ['README.md'] })).paths).toEqual(['README.md'])

    // A file that does not exist yet is still in the repository its folder is in — the
    // way a deleted file's ghost row still has a history.
    expect(await h['git.locate']({ path: 'nowhere.txt' })).toMatchObject({ repoPath: 'nowhere.txt' })
    // Outside the workspace, or under no repository at all: nothing, not an error.
    expect(await h['git.locate']({ path: '../elsewhere.txt' })).toEqual({ root: null, repoPath: null })
    const plain = mkdtempSync(join(tmpdir(), 'pc-plain-'))
    try {
      const loose = new Workspace(plain)
      expect(await gitHandlers(() => loose)['git.locate']({ path: 'a.txt' })).toEqual({ root: null, repoPath: null })
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
