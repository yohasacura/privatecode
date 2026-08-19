import { execa } from 'execa'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { gitCommitStaged, gitDiff, gitStage, gitUnstage, stagedPaths, suggestCommitMessage } from '../src/host/git.js'
import { discoverRepos } from '../src/host/repos.js'
import { Workspace } from '../src/workspace.js'

/**
 * The working tree, for the window.
 *
 * Driven against real git throughout: everything here rests on what git actually prints —
 * porcelain's two-character status pair, a rename's `old -> new`, an untracked file having
 * no HEAD side to diff against — and a test against a mock would be a test of the mock.
 */

let root: string

async function run(args: string[]): Promise<void> {
  await execa('git', args, { cwd: root })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pc-git-'))
  await run(['init', '--quiet'])
  await run(['config', 'user.name', 'test'])
  await run(['config', 'user.email', 'test@test'])
  writeFileSync(join(root, 'kept.txt'), 'first\n', 'utf8')
  await run(['add', '-A'])
  await run(['commit', '--quiet', '-m', 'initial'])
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const write = (rel: string, body: string): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), body, 'utf8')
}

describe('reading the working tree', () => {
  const statusOf = async (dir: string) => (await discoverRepos(new Workspace(dir))).repos[0]

  test('a clean repository reports its branch and nothing else', async () => {
    const repo = await statusOf(root)
    expect(repo?.relation).toBe('folder')
    expect(repo?.branch).toMatch(/^(main|master)$/)
    expect(repo?.files).toEqual([])
  })

  test('modified, untracked and staged files are told apart', async () => {
    write('kept.txt', 'changed\n')
    write('new.txt', 'brand new\n')
    write('staged.txt', 'staged\n')
    await run(['add', 'staged.txt'])

    const byPath = new Map(((await statusOf(root))?.files ?? []).map((f) => [f.path, f]))
    expect(byPath.get('kept.txt')).toMatchObject({ staged: false, untracked: false })
    expect(byPath.get('new.txt')).toMatchObject({ untracked: true })
    expect(byPath.get('staged.txt')).toMatchObject({ staged: true, untracked: false })
  })

  test('a rename is reported by the path that exists on disk, carrying its old name', async () => {
    // Porcelain writes `R  old -> new`; the panel opens the new path, and the old one
    // travels along because unstaging a rename must name both halves.
    await run(['mv', 'kept.txt', 'moved.txt'])
    const files = (await statusOf(root))?.files ?? []
    const moved = files.find((f) => f.path === 'moved.txt')
    expect(moved).toBeDefined()
    expect(moved?.oldPath).toBe('kept.txt')
  })

  test('unstaging a rename with both names restores the whole thing', async () => {
    await run(['mv', 'kept.txt', 'moved.txt'])
    expect(await gitUnstage(root, ['moved.txt', 'kept.txt'])).toMatchObject({ ok: true })
    // Nothing staged any more: the old name is back in the index as HEAD has it, the new
    // name is plain untracked — not a staged deletion waiting inside the next commit.
    expect(await stagedPaths(root)).toEqual([])
  })

  test('a file deleted together with its directory can still be found a repository for', async () => {
    // `git rev-parse` cannot run from a directory that no longer exists; the walk up finds
    // the nearest surviving ancestor — without it a whole-directory deletion could be
    // neither staged nor diffed from the panel.
    const { repoRootFor } = await import('../src/host/repos.js')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'guide.md'), 'text\n', 'utf8')
    await run(['add', 'docs/guide.md'])
    await run(['commit', '--quiet', '-m', 'docs'])
    rmSync(join(root, 'docs'), { recursive: true, force: true })
    expect(await repoRootFor(join(root, 'docs', 'guide.md'))).toBe(root)
  })

  test('a directory that is not a repository is listed as unversioned, not as a failure', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'pc-nogit-'))
    try {
      const found = await discoverRepos(new Workspace(plain))
      expect(found.repos).toEqual([])
      expect(found.unversioned.map((u) => u.mount)).toHaveLength(1)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('diffing', () => {
  test('a modified file shows what changed against HEAD', async () => {
    write('kept.txt', 'second\n')
    const diff = await gitDiff(root, 'kept.txt', false)
    expect(diff).toContain('-first')
    expect(diff).toContain('+second')
  })

  test('an untracked file shows every line, not nothing', async () => {
    // `git diff HEAD` says nothing at all about an untracked file, which in a panel reads
    // as "no changes" for a file that is entirely new.
    write('new.txt', 'line one\nline two\n')
    const diff = await gitDiff(root, 'new.txt', true)
    expect(diff).toContain('+line one')
    expect(diff).toContain('+line two')
  })
})

describe('staging', () => {
  test('stage puts a file in the index and the status says so', async () => {
    write('kept.txt', 'changed\n')
    write('new.txt', 'brand new\n')

    expect(await gitStage(root, ['new.txt'])).toMatchObject({ ok: true })
    expect(await stagedPaths(root)).toEqual(['new.txt'])

    const byPath = new Map(((await discoverRepos(new Workspace(root))).repos[0]?.files ?? []).map((f) => [f.path, f]))
    expect(byPath.get('new.txt')).toMatchObject({ staged: true })
    expect(byPath.get('kept.txt')).toMatchObject({ staged: false })
  })

  test('unstage takes it back out and touches nothing on disk', async () => {
    write('kept.txt', 'changed\n')
    await gitStage(root, ['kept.txt'])
    expect(await gitUnstage(root, ['kept.txt'])).toMatchObject({ ok: true })
    expect(await stagedPaths(root)).toEqual([])
    // Still modified on disk — unstaging is an index operation, never a checkout.
    const files = (await discoverRepos(new Workspace(root))).repos[0]?.files ?? []
    expect(files.map((f) => f.path)).toEqual(['kept.txt'])
  })

  test('unstage works in a repository with no commits yet', async () => {
    // `git reset HEAD` has nothing to reset to before the first commit; the fallback
    // removes the index entry itself, which is the same end state.
    const fresh = mkdtempSync(join(tmpdir(), 'pc-git-unborn-'))
    try {
      await execa('git', ['init', '--quiet'], { cwd: fresh })
      writeFileSync(join(fresh, 'a.txt'), 'a\n', 'utf8')
      await execa('git', ['add', 'a.txt'], { cwd: fresh })
      expect(await gitUnstage(fresh, ['a.txt'])).toMatchObject({ ok: true })
      expect(await stagedPaths(fresh)).toEqual([])
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  test('an empty set is refused in both directions', async () => {
    expect(await gitStage(root, [])).toMatchObject({ ok: false })
    expect(await gitUnstage(root, [])).toMatchObject({ ok: false })
  })
})

describe('committing', () => {
  test('commits exactly what is staged, never the rest of the tree', async () => {
    write('kept.txt', 'changed\n')
    write('other.txt', 'not this one\n')
    await gitStage(root, ['kept.txt'])

    const result = await gitCommitStaged(root, 'update kept')
    expect(result.ok).toBe(true)
    expect(result.sha).toMatch(/^[0-9a-f]{7,}$/)

    // The file that was not staged is still sitting there uncommitted.
    const after = (await discoverRepos(new Workspace(root))).repos[0]
    expect(after?.files.map((f) => f.path)).toEqual(['other.txt'])
  })

  test('an empty message is refused', async () => {
    write('kept.txt', 'changed\n')
    await gitStage(root, ['kept.txt'])
    expect(await gitCommitStaged(root, '   ')).toMatchObject({ ok: false })
  })

  test('git\'s own refusal is reported, not swallowed', async () => {
    // Nothing staged: git itself declines, and the panel shows its words.
    const result = await gitCommitStaged(root, 'nothing to do')
    expect(result.ok).toBe(false)
    expect(result.problem).toBeTruthy()
  })
})

describe('the suggested message', () => {
  const file = (path: string, untracked = false) => ({ path, code: untracked ? '??' : ' M', staged: false, untracked })

  test('names the one file when there is one', () => {
    expect(suggestCommitMessage([file('src/a.ts')])).toBe('update src/a.ts')
    expect(suggestCommitMessage([file('src/new.ts', true)])).toBe('add src/new.ts')
  })

  test('counts them and names the directory when they share one', () => {
    expect(suggestCommitMessage([file('src/a.ts'), file('src/b.ts')])).toBe('update 2 files in src')
  })

  test('says nothing about where when they are spread out', () => {
    expect(suggestCommitMessage([file('src/a.ts'), file('test/b.ts')])).toBe('update 2 files')
  })

  test('nothing selected suggests nothing', () => {
    expect(suggestCommitMessage([])).toBe('')
  })
})
