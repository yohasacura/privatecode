import { describe, expect, test } from 'vitest'
import type { GitRepoView } from '@core/host/protocol'
import { ghostRows, gitMarks, letterOf } from './git-scm'

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
  relation: 'folder',
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
