import { execa } from 'execa'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { gitCommit, gitDiff, suggestCommitMessage } from '../src/host/git.js'
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

  test('a rename is reported by the path that exists on disk', async () => {
    // Porcelain writes `R  old -> new`, and the panel opens what it lists.
    await run(['mv', 'kept.txt', 'moved.txt'])
    const files = (await statusOf(root))?.files ?? []
    expect(files.map((f) => f.path)).toContain('moved.txt')
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

describe('committing', () => {
  test('commits exactly the files named', async () => {
    write('kept.txt', 'changed\n')
    write('other.txt', 'not this one\n')

    const result = await gitCommit(root, 'update kept', ['kept.txt'])
    expect(result.ok).toBe(true)
    expect(result.sha).toMatch(/^[0-9a-f]{7,}$/)

    // The file that was not named is still sitting there uncommitted.
    const after = (await discoverRepos(new Workspace(root))).repos[0]
    expect(after?.files.map((f) => f.path)).toEqual(['other.txt'])
  })

  test('an empty selection is refused, never widened to everything', async () => {
    // A window that committed the whole tree because the list happened to be on screen
    // would eventually catch a file someone was in the middle of.
    write('kept.txt', 'changed\n')
    expect(await gitCommit(root, 'msg', [])).toMatchObject({ ok: false })
    expect((await discoverRepos(new Workspace(root))).repos[0]?.files).toHaveLength(1)
  })

  test('an empty message is refused', async () => {
    write('kept.txt', 'changed\n')
    expect(await gitCommit(root, '   ', ['kept.txt'])).toMatchObject({ ok: false })
  })

  test('git\'s own refusal is reported, not swallowed', async () => {
    const result = await gitCommit(root, 'nothing to do', ['kept.txt'])
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
