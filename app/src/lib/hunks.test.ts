import { describe, expect, test } from 'vitest'
import { hunksOf, splitDiff } from './hunks'

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  '-const a = 1',
  '+const a = 2',
  ' const b = 2',
  ' const c = 3',
  '@@ -10,2 +10,3 @@ function f() {',
  ' x()',
  '+y()',
  ' z()',
  'diff --git a/README.md b/README.md',
  'index 3333333..4444444 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/logo.png b/logo.png',
  'index 5555555..6666666 100644',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n')

describe('splitDiff', () => {
  test('cuts each file into its hunks, counting the lines each adds and removes', () => {
    const files = splitDiff(DIFF)
    expect(files.map((f) => [f.path, f.hunks.length, f.binary])).toEqual([['src/app.ts', 2, false], ['README.md', 1, false], ['logo.png', 0, true]])
    const [first, second] = files[0]!.hunks
    expect(first).toMatchObject({ header: '@@ -1,3 +1,3 @@', oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, added: 1, removed: 1 })
    expect(first?.text).toBe('@@ -1,3 +1,3 @@\n-const a = 1\n+const a = 2\n const b = 2\n const c = 3\n')
    expect(second).toMatchObject({ header: '@@ -10,2 +10,3 @@ function f() {', oldCount: 2, newCount: 3, added: 1, removed: 0 })
    expect(files[1]!.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 })
    expect(files[0]!.header).toContain('index 1111111..2222222')
  })

  test('hunksOf flattens a single-file diff, and an empty diff has none', () => {
    expect(hunksOf(DIFF)).toHaveLength(3)
    expect(hunksOf('')).toEqual([])
  })

  test('a new file diffed against /dev/null keeps its path from the +++ line', () => {
    const files = splitDiff('diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n')
    expect(files[0]).toMatchObject({ path: 'new.txt' })
    expect(files[0]!.hunks[0]).toMatchObject({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, added: 1 })
  })
})
