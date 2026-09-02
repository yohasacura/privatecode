import { describe, expect, it } from 'vitest'
import { affectedDirectories } from './tree'

describe('affectedDirectories (tree-refresh path parser)', () => {
  it('names the parent directory of an Edit path', () => {
    expect(affectedDirectories('Edit', JSON.stringify({ path: 'src/lib/foo.ts' }))).toEqual(['src/lib'])
  })

  it('names the workspace root ("") for a top-level Write path', () => {
    expect(affectedDirectories('Write', JSON.stringify({ path: 'README.md' }))).toEqual([''])
  })

  it('names the parent directory of a delete_file path', () => {
    expect(affectedDirectories('delete_file', JSON.stringify({ path: 'old/stale.ts' }))).toEqual(['old'])
  })

  it('names both parent directories for a cross-directory move_file', () => {
    const dirs = affectedDirectories('move_file', JSON.stringify({ from: 'a/x.ts', to: 'b/y.ts' }))
    expect(new Set(dirs)).toEqual(new Set(['a', 'b']))
  })

  it('deduplicates to one directory for a rename within the same directory', () => {
    expect(affectedDirectories('move_file', JSON.stringify({ from: 'a/x.ts', to: 'a/y.ts' }))).toEqual(['a'])
  })

  it('tolerates backslash-separated paths', () => {
    expect(affectedDirectories('Edit', JSON.stringify({ path: 'src\\lib\\foo.ts' }))).toEqual(['src/lib'])
  })

  it('returns nothing for a read-only tool', () => {
    expect(affectedDirectories('Read', JSON.stringify({ path: 'a.ts' }))).toEqual([])
  })

  it('returns nothing for malformed JSON rather than throwing', () => {
    expect(affectedDirectories('Edit', '{not json')).toEqual([])
  })

  it('returns nothing when the expected field is missing or the wrong type', () => {
    expect(affectedDirectories('Edit', JSON.stringify({ notPath: 'a.ts' }))).toEqual([])
    expect(affectedDirectories('Edit', JSON.stringify({ path: 42 }))).toEqual([])
  })
})
