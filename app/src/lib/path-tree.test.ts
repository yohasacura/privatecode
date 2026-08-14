import { describe, expect, it } from 'vitest'
import { commonPrefixOf, groupByDirectory } from './path-tree'

/**
 * What makes a change list readable in a 420px column: the part every row shares is said
 * once, and the rows carry the part that differs.
 */

const group = (paths: string[]) => groupByDirectory(paths, (p) => p)

describe('the shared prefix', () => {
  it('is whole segments, never half a name', () => {
    // `src/app` and `src/apple` share `src` — a character-wise prefix would say `src/app`
    // and produce headings like `le/thing.ts`.
    expect(commonPrefixOf(['src/app/a.ts', 'src/apple/b.ts'])).toBe('src')
  })

  it('is empty when the paths have nothing in common', () => {
    expect(commonPrefixOf(['src/a.ts', 'tests/b.ts'])).toBe('')
  })

  it('ignores the file names themselves', () => {
    // Two files in one directory share that directory, not the letters of their names.
    expect(commonPrefixOf(['src/thing.ts', 'src/thingamajig.ts'])).toBe('src')
  })

  it('is the whole directory when there is only one path', () => {
    expect(commonPrefixOf(['a/b/c/d.ts'])).toBe('a/b/c')
  })
})

describe('grouping', () => {
  it('lifts the shared prefix out and leaves what differs', () => {
    const { groups, commonPrefix } = group([
      'src/backend/App/Accounting/CreateAct.cs',
      'src/backend/App/Accounting/VoidAct.cs',
      'src/backend/Domain/Invoice.cs',
    ])
    expect(commonPrefix).toBe('src/backend')
    expect(groups.map((g) => g.dir)).toEqual(['App/Accounting', 'Domain'])
    expect(groups[0]!.items.map((i) => i.name)).toEqual(['CreateAct.cs', 'VoidAct.cs'])
  })

  it('keeps the caller order inside a group', () => {
    // A change list is newest-first and must stay that way; only the groups are sorted.
    const { groups } = group(['src/z.ts', 'src/a.ts'])
    expect(groups[0]!.items.map((i) => i.name)).toEqual(['z.ts', 'a.ts'])
  })

  it('collapses to one group when everything shares a directory', () => {
    // Nothing to separate: the whole path becomes the prefix and the rows are bare names.
    const { groups, commonPrefix } = group(['src/app/a.ts', 'src/app/b.ts'])
    expect(commonPrefix).toBe('src/app')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.dir).toBe('')
    expect(groups[0]!.items.map((i) => i.name)).toEqual(['a.ts', 'b.ts'])
  })

  it('handles a file at the workspace root', () => {
    const { groups, commonPrefix } = group(['README.md', 'src/a.ts'])
    expect(commonPrefix).toBe('')
    expect(groups.map((g) => g.dir)).toEqual(['', 'src'])
  })

  it('keeps the full directory for a tooltip, since the short one can be ambiguous', () => {
    const { groups } = group(['a/x/f.ts', 'b/x/g.ts'])
    expect(groups.map((g) => g.fullDir)).toEqual(['a/x', 'b/x'])
  })

  it('an empty list is an empty grouping, not a crash', () => {
    expect(group([]).groups).toEqual([])
    expect(group([]).commonPrefix).toBe('')
  })
})
