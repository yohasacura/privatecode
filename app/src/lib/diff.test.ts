import { describe, expect, it } from 'vitest'
import { diffStat } from './diff'

/**
 * File headers are identified STRUCTURALLY — a `--- ` line, then a `+++ ` line, then an
 * `@@` hunk (or renderDiff's parenthesised no-change note) — never by prefix alone and
 * never by fixed position. Prefix matching swallowed real changes (`-- SQL comment`
 * deleted renders `--- SQL comment`; `++i;` added renders `+++i;`); a fixed index broke
 * raw `git diff`, whose header pair sits after `diff --git`/`index` lines.
 */
describe('diffStat', () => {
  it('skips the tool-diff header pair and counts the body', () => {
    const content = '--- a.sql\n+++ a.sql\n@@ line 3 @@\n-old line\n+new line'
    expect(diffStat(content)).toEqual({ added: 1, removed: 1 })
  })

  it('a deleted -- comment and an added ++i are changes, not headers', () => {
    const content = '--- a.sql\n+++ a.sql\n@@ line 1 @@\n--- drop this SQL comment\n+++i;'
    expect(diffStat(content)).toEqual({ added: 1, removed: 1 })
  })

  it('finds the header pair of a raw git diff wherever it sits', () => {
    const content = [
      'diff --git a/x.ts b/x.ts',
      'index 111..222 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,2 @@',
      '-gone',
      '+here',
    ].join('\n')
    expect(diffStat(content)).toEqual({ added: 1, removed: 1 })
  })

  it('headerless search→replace content is all body — nothing is mistaken for a header', () => {
    // The approval card's rendering has no headers at all; a deletion of a `-- x` line at
    // row 0 must not vanish as one.
    const content = '--- deleted comment\n+++ added line'
    expect(diffStat(content)).toEqual({ added: 1, removed: 1 })
  })

  it('the no-change note still hides its header pair', () => {
    const content = '--- a.ts\n+++ a.ts\n(no change: the replacement produced text identical to the original)'
    expect(diffStat(content)).toEqual({ added: 0, removed: 0 })
  })
})
