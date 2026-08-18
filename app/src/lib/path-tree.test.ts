import { describe, expect, it } from 'vitest'
import { buildPathTree, decorateChanges } from './path-tree'

describe('buildPathTree', () => {
  const paths = (node: import('./path-tree').PathTreeNode<string>): string[] =>
    [...node.dirs.map((d) => `${d.name}[${d.totalFiles}]`), ...node.files.map((f) => f.name)]

  it('builds a real nested tree, files under the directories that hold them', () => {
    const tree = buildPathTree(
      ['a/x.ts', 'a/b/y.ts', 'z.ts'],
      (p) => p,
    )
    expect(paths(tree)).toEqual(['a[2]', 'z.ts'])
    const a = tree.dirs[0]!
    expect(a.files.map((f) => f.name)).toEqual(['x.ts'])
    expect(a.dirs[0]!.name).toBe('b')
    expect(a.dirs[0]!.files.map((f) => f.name)).toEqual(['y.ts'])
  })

  it('compresses single-child chains into one row, like a file explorer', () => {
    // The objection to trees in a 420px column is six indent levels with one child each;
    // compression spends depth only where the tree branches.
    const tree = buildPathTree(
      ['src/models/deal.js', 'src/models/client.js', 'tests/crm.test.js'],
      (p) => p,
    )
    expect(tree.dirs.map((d) => d.name)).toEqual(['src/models', 'tests'])
    expect(tree.dirs[0]!.fullDir).toBe('src/models')
    expect(tree.dirs[0]!.files.map((f) => f.name)).toEqual(['deal.js', 'client.js'])
  })

  it('keeps the caller\'s file order and sorts directories by name', () => {
    // A change list is newest-first and must stay that way; directories must not jump
    // between renders.
    const tree = buildPathTree(['d/new.ts', 'd/old.ts', 'b/x.ts', 'a/y.ts'], (p) => p)
    expect(tree.dirs.map((d) => d.name)).toEqual(['a', 'b', 'd'])
    expect(tree.dirs[2]!.files.map((f) => f.name)).toEqual(['new.ts', 'old.ts'])
  })

  it('a directory that both branches and holds files is not compressed past its files', () => {
    const tree = buildPathTree(['a/direct.ts', 'a/deep/leaf.ts'], (p) => p)
    const a = tree.dirs[0]!
    expect(a.name).toBe('a')
    expect(a.files.map((f) => f.name)).toEqual(['direct.ts'])
    expect(a.dirs.map((d) => d.name)).toEqual(['deep'])
    expect(a.totalFiles).toBe(2)
  })
})

describe('decorateChanges', () => {
  it('files carry their diff shape, every ancestor directory carries the count', () => {
    const { files, dirs } = decorateChanges([
      { openPath: 'src/models/deal.js', revisions: 2, stat: { added: 5, removed: 1 } },
      { openPath: 'src/crm.js', revisions: 1, lastFailed: true, stat: null },
      { openPath: 'root.md', revisions: 1, stat: { added: 1, removed: 0 } },
    ])
    expect(files.get('src/models/deal.js')).toEqual({ added: 5, removed: 1, revisions: 2, lastFailed: false })
    expect(files.get('src/crm.js')).toEqual({ added: 0, removed: 0, revisions: 1, lastFailed: true })
    expect(dirs.get('src')).toBe(2)
    expect(dirs.get('src/models')).toBe(1)
    expect(dirs.has('')).toBe(false)
  })
})
