import { describe, expect, test } from 'vitest'
import type { GitRepoView } from '@core/host/protocol'
import { describeMark, ghostRows, gitMarks, letterOf } from './git-scm'

/** A HEAD the git view carries; these tests are about the files, not the branch. */
const NO_HEAD = { branch: 'main', detached: false, unborn: false, oid: null, upstream: null, ahead: 0, behind: 0, upstreamGone: false }

/**
 * Git as the tree wears it: porcelain pairs → one letter, staged/dirty flags, and ghost
 * rows for the files a disk listing cannot contain.
 */

describe('letterOf', () => {
  test('the ordinary states get their editor letters', () => {
    expect(letterOf('??')).toBe('U')
    expect(letterOf(' M')).toBe('M')
    expect(letterOf('M ')).toBe('M')
    expect(letterOf('A ')).toBe('A')
    expect(letterOf(' D')).toBe('D')
    expect(letterOf('D ')).toBe('D')
    expect(letterOf('R ')).toBe('R')
  })

  test('staged-then-edited-again reads as modified, not as two states', () => {
    expect(letterOf('MM')).toBe('M')
    expect(letterOf('AM')).toBe('M')
  })

  test('conflicts are loud, never routine', () => {
    expect(letterOf('UU')).toBe('!')
    expect(letterOf('AA')).toBe('!')
    expect(letterOf('DD')).toBe('!')
  })
})

const repo = (files: { path: string; code: string }[]): GitRepoView => ({
  root: 'C:/repo',
  label: 'repo',
  branch: 'main',
  relation: 'folder', head: NO_HEAD, stashes: 0, operation: null,
  suggestion: '',
  files: files.map((f) => ({
    path: f.path,
    code: f.code,
    staged: f.code[0] !== ' ' && f.code[0] !== '?',
    untracked: f.code === '??',
  })),
})

describe('gitMarks', () => {
  test('staged and dirty are told apart, and MM is both', () => {
    const marks = gitMarks([repo([
      { path: 'a.ts', code: 'M ' },
      { path: 'b.ts', code: ' M' },
      { path: 'c.ts', code: 'MM' },
      { path: 'd.ts', code: '??' },
    ])])
    expect(marks.get('a.ts')).toMatchObject({ staged: true, dirty: false })
    expect(marks.get('b.ts')).toMatchObject({ staged: false, dirty: true })
    expect(marks.get('c.ts')).toMatchObject({ staged: true, dirty: true })
    expect(marks.get('d.ts')).toMatchObject({ staged: false, dirty: true, untracked: true })
  })

  test('every mark carries the repository it answers to', () => {
    const marks = gitMarks([repo([{ path: 'src/a.ts', code: ' M' }])])
    expect(marks.get('src/a.ts')?.repoRoot).toBe('C:/repo')
  })

  // Every conflict pair has a non-space index column, so the host hands them over as
  // `staged: true` (the `repo` helper above reproduces that parse exactly). The tree
  // highlights a staged row as "chosen for the commit" while the commit box refuses to
  // count a conflict — the mark is where the two are reconciled.
  test('a conflict is never staged, whatever the index column says', () => {
    const marks = gitMarks([repo([
      { path: 'both.ts', code: 'UU' },
      { path: 'added.ts', code: 'AA' },
      { path: 'gone.ts', code: 'DD' },
      { path: 'theirs.ts', code: 'DU' },
      { path: 'ours.ts', code: 'UD' },
    ])])
    for (const path of ['both.ts', 'added.ts', 'gone.ts', 'theirs.ts', 'ours.ts']) {
      expect(marks.get(path)).toMatchObject({ letter: '!', staged: false })
    }
  })
})

describe('describeMark', () => {
  test('the ordinary states name their side of the index', () => {
    const marks = gitMarks([repo([
      { path: 'a.ts', code: 'M ' },
      { path: 'b.ts', code: ' M' },
      { path: 'c.ts', code: 'MM' },
    ])])
    expect(describeMark(marks.get('a.ts')!)).toBe('modified · staged for the next commit')
    expect(describeMark(marks.get('b.ts')!)).toBe('modified · not staged')
    expect(describeMark(marks.get('c.ts')!)).toContain('staged, then edited again')
  })

  test('a conflict is described without a staging verdict', () => {
    const marks = gitMarks([repo([{ path: 'both.ts', code: 'UU' }])])
    expect(describeMark(marks.get('both.ts')!)).toBe('CONFLICT — resolve it before committing')
    expect(describeMark(marks.get('both.ts')!)).not.toContain('staged')
  })
})

describe('ghostRows', () => {
  test('git deletions and session deletions group by parent, deduplicated', () => {
    const marks = gitMarks([repo([
      { path: 'src/gone.ts', code: ' D' },
      { path: 'src/kept.ts', code: ' M' },
    ])])
    const ghosts = ghostRows(marks, ['src/gone.ts', 'root-gone.md'])
    expect(ghosts.get('src')?.map((g) => g.name)).toEqual(['gone.ts'])
    expect(ghosts.get('')?.map((g) => g.name)).toEqual(['root-gone.md'])
  })

  test('a modified file is never a ghost', () => {
    const marks = gitMarks([repo([{ path: 'a.ts', code: ' M' }])])
    expect(ghostRows(marks, []).size).toBe(0)
  })
})

describe('the two spellings of a path', () => {
  test('a mark carries git\'s own spelling when the host gave one — a nested repository\'s files differ by the folder prefix', () => {
    const nested: GitRepoView = {
      root: 'C:/ws/work/one', label: 'work/one', branch: 'main', relation: 'nested', head: NO_HEAD, stashes: 0, operation: null, suggestion: '',
      files: [{ path: 'work/one/seed.txt', repoPath: 'seed.txt', code: ' M', staged: false, untracked: false }],
    }
    const marks = gitMarks([nested])
    expect(marks.get('work/one/seed.txt')).toMatchObject({ repoRoot: 'C:/ws/work/one', repoPath: 'seed.txt' })
  })
})
