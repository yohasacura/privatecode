import { execa } from 'execa'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  amendLast, applyHunk, blameFile, checkoutDetached, cherryPick, commitDetails, compareRevisions, createBranch,
  createTag, deleteBranch, deleteTag, diffBetween, discardChanges, fetchRemote, ignorePattern, listRefs,
  listRemotes, listStashes, mergeBranch, operationStep, parseDecorations, parsePorcelainV2, pullRemote,
  pushRemote, readConfig, readLog, readOperation, readStatus, rebaseOnto, remoteAdd, remoteRemove,
  remoteSetUrl, renameBranch, resetTo, revertCommit, setUpstream, squashCommits, stashApply, stashDrop,
  stashPush, stashShow, switchBranch, writeConfig,
} from '../src/host/git-repo.js'

/**
 * The repository, for the window — driven against real git throughout, because every
 * function here is a reading of what git prints and a test against a mock would test the
 * mock. Each case starts from a fresh repository with one commit; the network cases talk
 * to a bare repository in the same temp folder, which is a remote in every way that
 * matters to `push` and `pull` except the wire.
 */

let root: string
let scratch: string

async function run(cwd: string, args: string[]): Promise<string> {
  const r = await execa('git', args, { cwd, env: { GIT_EDITOR: 'true' } })
  return r.stdout
}
const write = (rel: string, body: string): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), body, 'utf8')
}
const commit = async (rel: string, body: string, message: string): Promise<string> => {
  write(rel, body)
  await run(root, ['add', '-A'])
  await run(root, ['commit', '--quiet', '-m', message])
  return run(root, ['rev-parse', 'HEAD'])
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'pc-gitrepo-'))
  root = join(scratch, 'work')
  mkdirSync(root)
  await run(root, ['init', '--quiet', '--initial-branch=main'])
  await run(root, ['config', 'user.name', 'test'])
  await run(root, ['config', 'user.email', 'test@test'])
  // The machine may have autocrlf on; the bytes these tests compare are the repository's.
  await run(root, ['config', 'core.autocrlf', 'false'])
  await commit('README.md', 'one\n', 'initial')
})
afterEach(() => { rmSync(scratch, { recursive: true, force: true }) })

/** A bare "origin" beside the work tree, with main pushed and tracking set up. */
async function withRemote(): Promise<string> {
  const bare = join(scratch, 'origin.git')
  await run(scratch, ['init', '--quiet', '--bare', bare])
  await run(root, ['remote', 'add', 'origin', bare])
  await run(root, ['push', '--quiet', '-u', 'origin', 'main'])
  return bare
}

/** A second clone that advances the remote, so the first one falls behind. */
async function someoneElsePushes(bare: string, rel: string, body: string, message: string): Promise<void> {
  const other = join(scratch, 'other')
  await run(scratch, ['clone', '--quiet', bare, other])
  await run(other, ['config', 'user.name', 'other'])
  await run(other, ['config', 'user.email', 'other@test'])
  writeFileSync(join(other, rel), body, 'utf8')
  await run(other, ['add', '-A'])
  await run(other, ['commit', '--quiet', '-m', message])
  await run(other, ['push', '--quiet'])
  rmSync(other, { recursive: true, force: true })
}

describe('porcelain v2', () => {
  test('parses the branch header, the counts and every entry kind', () => {
    const out = [
      '# branch.oid abc123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1', '# stash 3',
      '1 .M N... 100644 100644 100644 aaa bbb src/app.ts',
      '1 A. N... 000000 100644 100644 000 ccc new.txt',
      '2 R. N... 100644 100644 100644 ddd ddd R100 new name.txt', 'old name.txt',
      'u UU N... 100644 100644 100644 100644 e f g conflicted.txt',
      '? untracked.txt',
    ].join('\0') + '\0'
    const s = parsePorcelainV2(out)
    expect(s.head).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, detached: false, unborn: false })
    expect(s.stashes).toBe(3)
    expect(s.files.map((f) => [f.path, f.code, f.staged, f.untracked])).toEqual([
      ['src/app.ts', ' M', false, false],
      ['new.txt', 'A ', true, false],
      ['new name.txt', 'R ', true, false],
      ['conflicted.txt', 'UU', false, false],
      ['untracked.txt', '??', false, true],
    ])
    expect(s.files[2]?.oldPath).toBe('old name.txt')
    expect(s.conflicts).toEqual(['conflicted.txt'])
  })

  test('an unborn repository and a detached head are states, not errors', () => {
    expect(parsePorcelainV2('# branch.oid (initial)\0# branch.head main\0').head).toMatchObject({ unborn: true, branch: 'main', oid: null })
    expect(parsePorcelainV2('# branch.oid abc\0# branch.head (detached)\0').head).toMatchObject({ detached: true, branch: null })
  })

  test('reads the live repository the same way', async () => {
    write('README.md', 'changed\n')
    write('new.txt', 'new\n')
    const s = await readStatus(root)
    if ('problem' in s) throw new Error(s.problem)
    expect(s.head.branch).toBe('main')
    expect(s.files.map((f) => f.path).sort()).toEqual(['README.md', 'new.txt'])
  })
})

describe('refs and history', () => {
  test('branches, remote branches and tags come back with what the panel shows', async () => {
    const bare = await withRemote()
    // A clone carries `origin/HEAD`, whose short name is just `origin`: not a branch.
    await run(root, ['remote', 'set-head', 'origin', 'main'])
    await run(root, ['branch', 'feature'])
    await run(root, ['tag', 'v1'])
    await run(root, ['tag', '-a', '-m', 'release two', 'v2'])
    const refs = await listRefs(root)
    if ('problem' in refs) throw new Error(refs.problem)
    expect(refs.local.map((b) => b.name).sort()).toEqual(['feature', 'main'])
    expect(refs.local.find((b) => b.name === 'main')).toMatchObject({ current: true, upstream: 'origin/main', ahead: 0, behind: 0 })
    expect(refs.remote.map((b) => b.name)).toEqual(['origin/main'])
    expect(refs.remote[0]?.remote).toBe('origin')
    expect(refs.tags.map((t) => [t.name, t.annotated])).toEqual([['v1', false], ['v2', true]])
    // Both tags point at the same commit, the annotated one through its tag object.
    expect(refs.tags[0]?.sha).toBe(refs.tags[1]?.sha)
    expect(existsSync(bare)).toBe(true)
  })

  test('the log carries parents, decorations and the author, newest first', async () => {
    const second = await commit('a.txt', 'a\n', 'second commit')
    await run(root, ['tag', 'v1'])
    const { commits } = await readLog(root, { limit: 10 })
    expect(commits.map((c) => c.subject)).toEqual(['second commit', 'initial'])
    expect(commits[0]?.sha).toBe(second)
    expect(commits[0]?.parents).toEqual([commits[1]?.sha])
    expect(commits[0]?.refs).toEqual([{ name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'local' }, { name: 'v1', kind: 'tag' }])
    expect(commits[0]?.authorName).toBe('test')
    expect(commits[1]?.parents).toEqual([])
  })

  test('a range shows only what the other side has, and a sha prefix finds a commit', async () => {
    const bare = await withRemote()
    await someoneElsePushes(bare, 'theirs.txt', 'x\n', 'their work')
    await run(root, ['fetch', '--quiet'])
    const incoming = await readLog(root, { range: 'HEAD..origin/main' })
    expect(incoming.commits.map((c) => c.subject)).toEqual(['their work'])
    const outgoing = await readLog(root, { range: 'origin/main..HEAD' })
    expect(outgoing.commits).toEqual([])
    const bySha = await readLog(root, { search: incoming.commits[0]!.sha.slice(0, 8), range: 'origin/main' })
    expect(bySha.commits.map((c) => c.subject)).toEqual(['their work'])
  })

  test('decorations are split into labels the graph colours', () => {
    expect(parseDecorations('HEAD -> main, origin/main, tag: v1, feature')).toEqual([
      { name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'local' }, { name: 'origin/main', kind: 'remote' },
      { name: 'v1', kind: 'tag' }, { name: 'feature', kind: 'local' },
    ])
    expect(parseDecorations('')).toEqual([])
  })

  test('commit details list the files against the first parent, and the root against nothing', async () => {
    await commit('a.txt', 'a\nb\n', 'add a')
    await run(root, ['mv', 'a.txt', 'b.txt'])
    await run(root, ['commit', '--quiet', '-m', 'rename a'])
    const head = (await run(root, ['rev-parse', 'HEAD'])).trim()
    const d = await commitDetails(root, head)
    if ('problem' in d) throw new Error(d.problem)
    expect(d.subject).toBe('rename a')
    expect(d.files).toEqual([{ path: 'b.txt', status: 'R', oldPath: 'a.txt', additions: 0, deletions: 0, binary: false }])
    const first = (await run(root, ['rev-list', '--max-parents=0', 'HEAD'])).trim()
    const r = await commitDetails(root, first)
    if ('problem' in r) throw new Error(r.problem)
    expect(r.parents).toEqual([])
    expect(r.files).toEqual([{ path: 'README.md', status: 'A', additions: 1, deletions: 0, binary: false }])
    const diff = await diffBetween(root, r.base, r.sha, 'README.md')
    expect(diff.diff).toContain('+one')
  })

  test('comparing two revisions lists every file that differs', async () => {
    const before = (await run(root, ['rev-parse', 'HEAD'])).trim()
    await commit('x.txt', 'x\n', 'x')
    await commit('README.md', 'one\ntwo\n', 'more')
    const c = await compareRevisions(root, before, 'HEAD')
    expect(c.files.map((f) => [f.path, f.status, f.additions])).toEqual([['README.md', 'M', 1], ['x.txt', 'A', 1]])
  })
})

describe('branches', () => {
  test('create, switch, rename and delete', async () => {
    expect(await createBranch(root, { name: 'feature', checkout: true })).toMatchObject({ ok: true })
    expect((await readStatus(root) as { head: { branch: string } }).head.branch).toBe('feature')
    expect(await renameBranch(root, 'feature', 'feature-2')).toMatchObject({ ok: true })
    expect(await switchBranch(root, 'main')).toMatchObject({ ok: true })
    expect(await deleteBranch(root, 'feature-2', false)).toMatchObject({ ok: true })
    const refs = await listRefs(root)
    if ('problem' in refs) throw new Error(refs.problem)
    expect(refs.local.map((b) => b.name)).toEqual(['main'])
  })

  test('a bad name is refused before git is asked, and an unmerged branch says why', async () => {
    expect(await createBranch(root, { name: 'bad name', checkout: false })).toMatchObject({ ok: false, problem: expect.stringContaining('not a valid branch name') })
    await createBranch(root, { name: 'work', checkout: true })
    await commit('w.txt', 'w\n', 'work commit')
    await switchBranch(root, 'main')
    const refused = await deleteBranch(root, 'work', false)
    expect(refused.ok).toBe(false)
    expect(refused.problem).toContain('not merged')
    expect(await deleteBranch(root, 'work', true)).toMatchObject({ ok: true })
  })

  test('switching to a remote branch creates a tracking local branch', async () => {
    const bare = await withRemote()
    await run(root, ['branch', 'feature'])
    await run(root, ['push', '--quiet', 'origin', 'feature'])
    await run(root, ['branch', '-D', 'feature'])
    expect(await switchBranch(root, 'origin/feature')).toMatchObject({ ok: true })
    const refs = await listRefs(root)
    if ('problem' in refs) throw new Error(refs.problem)
    expect(refs.local.find((b) => b.name === 'feature')).toMatchObject({ current: true, upstream: 'origin/feature' })
    expect(await setUpstream(root, 'feature', null)).toMatchObject({ ok: true })
    expect(await setUpstream(root, 'feature', 'origin/main')).toMatchObject({ ok: true })
    expect(existsSync(bare)).toBe(true)
  })

  test('a detached checkout is reported as such', async () => {
    const first = (await run(root, ['rev-parse', 'HEAD'])).trim()
    expect(await checkoutDetached(root, first)).toMatchObject({ ok: true })
    const s = await readStatus(root)
    if ('problem' in s) throw new Error(s.problem)
    expect(s.head.detached).toBe(true)
  })
})

describe('merge, rebase and the operations in progress', () => {
  async function diverge(branch = 'feature'): Promise<void> {
    await createBranch(root, { name: branch, checkout: true })
    await commit('README.md', 'feature side\n', 'feature edit')
    await switchBranch(root, 'main')
    await commit('README.md', 'main side\n', 'main edit')
  }

  test('a clean merge succeeds and a conflicting one stops with the file marked', async () => {
    await createBranch(root, { name: 'feature', checkout: true })
    await commit('f.txt', 'f\n', 'feature file')
    await switchBranch(root, 'main')
    expect(await mergeBranch(root, 'feature')).toMatchObject({ ok: true })
    expect(existsSync(join(root, 'f.txt'))).toBe(true)

    await diverge('clash')
    const m = await mergeBranch(root, 'clash')
    expect(m).toMatchObject({ ok: false, conflict: true })
    expect(await readOperation(root)).toBe('merge')
    const s = await readStatus(root)
    if ('problem' in s) throw new Error(s.problem)
    expect(s.conflicts).toEqual(['README.md'])
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('<<<<<<<')
    expect(await operationStep(root, 'abort')).toMatchObject({ ok: true })
    expect(await readOperation(root)).toBeNull()
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('main side\n')
  })

  test('a resolved conflict continues into the merge commit', async () => {
    await diverge()
    await mergeBranch(root, 'feature')
    write('README.md', 'both sides\n')
    await run(root, ['add', 'README.md'])
    expect(await operationStep(root, 'continue')).toMatchObject({ ok: true })
    expect(await readOperation(root)).toBeNull()
    const { commits } = await readLog(root, { limit: 1 })
    expect(commits[0]?.parents).toHaveLength(2)
  })

  test('a rebase that conflicts can be aborted, and nothing is in progress afterwards', async () => {
    await diverge()
    await switchBranch(root, 'feature')
    const r = await rebaseOnto(root, 'main')
    expect(r).toMatchObject({ ok: false, conflict: true })
    expect(await readOperation(root)).toBe('rebase')
    expect(await operationStep(root, 'abort')).toMatchObject({ ok: true })
    expect(await readOperation(root)).toBeNull()
    expect(await operationStep(root, 'continue')).toMatchObject({ ok: false })
  })

  test('cherry-pick copies one commit, revert undoes one, and a merge commit is refused', async () => {
    await createBranch(root, { name: 'feature', checkout: true })
    const picked = (await commit('pick.txt', 'p\n', 'to pick')).trim()
    await switchBranch(root, 'main')
    expect(await cherryPick(root, [picked])).toMatchObject({ ok: true })
    expect(existsSync(join(root, 'pick.txt'))).toBe(true)
    const head = (await run(root, ['rev-parse', 'HEAD'])).trim()
    expect(await revertCommit(root, head)).toMatchObject({ ok: true })
    expect(existsSync(join(root, 'pick.txt'))).toBe(false)
    await mergeBranch(root, 'feature')
    await run(root, ['merge', '--quiet', '--no-ff', 'feature', '-m', 'merge feature']).catch(() => {})
    const merges = await run(root, ['rev-list', '--merges', '-n', '1', 'HEAD'])
    if (merges.trim() !== '') {
      const refused = await revertCommit(root, merges.trim())
      expect(refused.ok).toBe(false)
      expect(refused.problem).toContain('merge commit')
    }
  })

  test('reset moves the branch and keeps or drops the work as asked', async () => {
    const first = (await run(root, ['rev-parse', 'HEAD'])).trim()
    await commit('a.txt', 'a\n', 'a')
    expect(await resetTo(root, first, 'soft')).toMatchObject({ ok: true })
    let s = await readStatus(root)
    if ('problem' in s) throw new Error(s.problem)
    expect(s.files).toEqual([{ path: 'a.txt', code: 'A ', staged: true, untracked: false }])
    await run(root, ['commit', '--quiet', '-m', 'a again'])
    expect(await resetTo(root, first, 'hard')).toMatchObject({ ok: true })
    s = await readStatus(root)
    if ('problem' in s) throw new Error(s.problem)
    expect(s.files).toEqual([])
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
  })

  test('tags are created lightweight or annotated, and deleted', async () => {
    expect(await createTag(root, 'v1', undefined, undefined)).toMatchObject({ ok: true })
    expect(await createTag(root, 'v2', 'HEAD', 'the second')).toMatchObject({ ok: true })
    expect(await createTag(root, 'bad tag', undefined, undefined)).toMatchObject({ ok: false })
    let refs = await listRefs(root)
    if ('problem' in refs) throw new Error(refs.problem)
    expect(refs.tags.map((t) => t.name)).toEqual(['v1', 'v2'])
    expect(await deleteTag(root, 'v1')).toMatchObject({ ok: true })
    refs = await listRefs(root)
    if ('problem' in refs) throw new Error(refs.problem)
    expect(refs.tags.map((t) => t.name)).toEqual(['v2'])
  })

  test('amend rewrites the last message, and refuses once the commit is on the remote', async () => {
    expect(await amendLast(root, 'initial, reworded')).toMatchObject({ ok: true })
    expect((await readLog(root, { limit: 1 })).commits[0]?.subject).toBe('initial, reworded')
    await withRemote()
    const refused = await amendLast(root, 'again')
    expect(refused.ok).toBe(false)
    expect(refused.problem).toContain('already on origin/main')
  })

  test('squash folds the newest commits into one, and only those', async () => {
    const a = (await commit('a.txt', 'a\n', 'a')).trim()
    const b = (await commit('b.txt', 'b\n', 'b')).trim()
    const gap = await squashCommits(root, [a], 'x')
    expect(gap.ok).toBe(false)
    const first = (await run(root, ['rev-list', '--max-parents=0', 'HEAD'])).trim()
    const wrong = await squashCommits(root, [b, first], 'x')
    expect(wrong.ok).toBe(false)
    expect(wrong.problem).toContain('newest commits')
    expect(await squashCommits(root, [b, a], 'a and b together')).toMatchObject({ ok: true })
    const { commits } = await readLog(root)
    expect(commits.map((c) => c.subject)).toEqual(['a and b together', 'initial'])
    expect(existsSync(join(root, 'a.txt')) && existsSync(join(root, 'b.txt'))).toBe(true)
  })
})

describe('the remote', () => {
  test('push, fetch, pull — and the two refusals the panel turns into choices', async () => {
    const noRemote = await pushRemote(root)
    expect(noRemote.ok).toBe(false)
    const bare = await withRemote()
    await commit('local.txt', 'l\n', 'local work')
    expect(await pushRemote(root)).toMatchObject({ ok: true })
    await someoneElsePushes(bare, 'theirs.txt', 't\n', 'their work')
    await commit('mine.txt', 'm\n', 'my work')
    const rejected = await pushRemote(root)
    expect(rejected).toMatchObject({ ok: false, behindRemote: true })
    expect(await fetchRemote(root, { prune: true })).toMatchObject({ ok: true })
    const s = await readStatus(root)
    if ('problem' in s) throw new Error(s.problem)
    expect(s.head).toMatchObject({ ahead: 1, behind: 1 })
    expect(await pullRemote(root, { rebase: true })).toMatchObject({ ok: true })
    expect(await pushRemote(root)).toMatchObject({ ok: true })
    // A brand-new branch has no upstream: the push says so, and publishing fixes it.
    await createBranch(root, { name: 'topic', checkout: true })
    await commit('topic.txt', 't\n', 'topic')
    expect(await pushRemote(root)).toMatchObject({ ok: false, noUpstream: true })
    expect(await pushRemote(root, { setUpstream: true })).toMatchObject({ ok: true })
    const refs = await listRefs(root)
    if ('problem' in refs) throw new Error(refs.problem)
    expect(refs.local.find((b) => b.name === 'topic')?.upstream).toBe('origin/topic')
  })

  test('a pull that conflicts leaves the repository mid-merge with the file marked', async () => {
    const bare = await withRemote()
    await someoneElsePushes(bare, 'README.md', 'their line\n', 'their edit')
    await commit('README.md', 'my line\n', 'my edit')
    const p = await pullRemote(root)
    expect(p).toMatchObject({ ok: false, conflict: true })
    expect(await readOperation(root)).toBe('merge')
    await operationStep(root, 'abort')
  })

  test('remotes are listed, added, re-pointed and removed', async () => {
    expect(await listRemotes(root)).toEqual([])
    expect(await remoteAdd(root, 'origin', 'https://example.test/repo.git')).toMatchObject({ ok: true })
    expect(await remoteAdd(root, 'bad name', 'x')).toMatchObject({ ok: false })
    expect(await remoteSetUrl(root, 'origin', 'https://example.test/other.git')).toMatchObject({ ok: true })
    expect(await listRemotes(root)).toEqual([{ name: 'origin', fetchUrl: 'https://example.test/other.git', pushUrl: 'https://example.test/other.git' }])
    expect(await remoteRemove(root, 'origin')).toMatchObject({ ok: true })
    expect(await listRemotes(root)).toEqual([])
  })
})

describe('stashes', () => {
  test('push, list, show, apply with the index restored, pop and drop', async () => {
    // A staged EDIT, not a staged new file: git re-adds a new file to the index on any
    // apply (it has no other way to track it), so only an edit tells --index apart.
    write('README.md', 'staged edit\n')
    await run(root, ['add', 'README.md'])
    write('README.md', 'staged edit\nand more\n')
    write('staged.txt', 's\n')
    await run(root, ['add', 'staged.txt'])
    expect(await stashPush(root, { message: 'half done' })).toMatchObject({ ok: true })
    let list = await listStashes(root)
    expect(list.stashes).toHaveLength(1)
    expect(list.stashes[0]).toMatchObject({ index: 0, message: expect.stringContaining('half done') })
    const shown = await stashShow(root, 0)
    expect(shown.files.map((f) => f.path).sort()).toEqual(['README.md', 'staged.txt'])
    expect(shown.diff).toContain('+and more')
    expect(await stashApply(root, 0, { pop: false, restoreIndex: true })).toMatchObject({ ok: true })
    let s = await readStatus(root)
    if ('problem' in s) throw new Error(s.problem)
    expect(s.files.find((f) => f.path === 'README.md')?.code).toBe('MM')
    expect(s.stashes).toBe(1)
    await run(root, ['stash', 'push', '--quiet'])
    expect(await stashApply(root, 0, { pop: true, restoreIndex: false })).toMatchObject({ ok: true })
    s = await readStatus(root)
    if ('problem' in s) throw new Error(s.problem)
    expect(s.files.find((f) => f.path === 'README.md')?.code).toBe(' M')
    expect(await stashDrop(root, 0)).toMatchObject({ ok: true })
    list = await listStashes(root)
    expect(list.stashes).toEqual([])
    expect(await stashPush(root, { keepIndex: true })).toMatchObject({ ok: true })
  })

  test('a clean tree has nothing to stash, and says so', async () => {
    await run(root, ['stash', 'push', '--quiet', '--include-untracked']).catch(() => {})
    await run(root, ['checkout', '--', '.'])
    const r = await stashPush(root, {})
    expect(r.ok).toBe(false)
    expect(r.problem).toContain('nothing to stash')
  })
})

describe('the working tree', () => {
  test('discard puts a tracked file back and deletes an untracked one', async () => {
    write('README.md', 'edited\n')
    await run(root, ['add', 'README.md'])
    write('README.md', 'edited twice\n')
    write('junk.txt', 'junk\n')
    expect(await discardChanges(root, ['README.md', 'junk.txt'])).toMatchObject({ ok: true })
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('one\n')
    expect(existsSync(join(root, 'junk.txt'))).toBe(false)
  })

  test('ignore appends once and never twice', () => {
    expect(ignorePattern(root, 'build/')).toMatchObject({ ok: true })
    expect(ignorePattern(root, 'build/')).toMatchObject({ ok: true, output: 'already ignored' })
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('build/\n')
  })

  test('one hunk is staged, unstaged and undone on its own', async () => {
    await commit('code.txt', 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n', 'code')
    write('code.txt', 'LINE1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nLINE10\n')
    const diff = await run(root, ['diff', 'HEAD', '--', 'code.txt'])
    const hunks = diff.split(/^(?=@@ )/m).filter((h) => h.startsWith('@@ '))
    expect(hunks).toHaveLength(2)
    expect(await applyHunk(root, 'code.txt', hunks[0]!, 'stage')).toMatchObject({ ok: true })
    let s = await readStatus(root)
    if ('problem' in s) throw new Error(s.problem)
    expect(s.files.find((f) => f.path === 'code.txt')?.code).toBe('MM')
    expect(await run(root, ['diff', '--cached', '--', 'code.txt'])).toContain('+LINE1')
    expect(await applyHunk(root, 'code.txt', hunks[0]!, 'unstage')).toMatchObject({ ok: true })
    s = await readStatus(root)
    if ('problem' in s) throw new Error(s.problem)
    expect(s.files.find((f) => f.path === 'code.txt')?.code).toBe(' M')
    expect(await applyHunk(root, 'code.txt', hunks[1]!, 'undo')).toMatchObject({ ok: true })
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toContain('line10\n')
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toContain('LINE1\n')
    expect(await applyHunk(root, 'code.txt', 'not a hunk', 'stage')).toMatchObject({ ok: false })
  })

  test('blame names the commit behind each line', async () => {
    await commit('b.txt', 'first\n', 'b one')
    await commit('b.txt', 'first\nsecond\n', 'b two')
    const { lines } = await blameFile(root, 'b.txt')
    expect(lines.map((l) => [l.line, l.summary, l.text])).toEqual([[1, 'b one', 'first'], [2, 'b two', 'second']])
    expect(lines[0]?.author).toBe('test')
    expect(lines[0]?.short).toHaveLength(7)
  })
})

describe('configuration', () => {
  test('the repository-level settings are read and written without touching the global ones', async () => {
    const before = await readConfig(root)
    expect(before.local['user.name']).toBe('test')
    expect(before.effective['user.email']).toBe('test@test')
    expect(await writeConfig(root, 'local', 'pull.rebase', 'true')).toMatchObject({ ok: true })
    expect(await writeConfig(root, 'local', 'fetch.prune', 'true')).toMatchObject({ ok: true })
    const after = await readConfig(root)
    expect(after.local['pull.rebase']).toBe('true')
    expect(after.effective['fetch.prune']).toBe('true')
    expect(await writeConfig(root, 'local', 'pull.rebase', null)).toMatchObject({ ok: true })
    expect(await writeConfig(root, 'local', 'pull.rebase', null)).toMatchObject({ ok: true })
    expect((await readConfig(root)).local['pull.rebase']).toBeUndefined()
    expect(await writeConfig(root, 'local', 'core.editor' as never, 'x')).toMatchObject({ ok: false })
    expect(after.hasIgnoreFile).toBe(false)
  })
})
