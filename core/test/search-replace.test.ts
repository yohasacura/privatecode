import { expect, test } from 'vitest'
import { applySearchReplace } from '../src/edit/search-replace.js'

const SRC = [
  'function greet(name) {',
  '  return "hello " + name;',
  '}',
  '',
  'function farewell(name) {',
  '  return "bye " + name;',
  '}',
  '',
].join('\n')

test('replaces a unique exact match', () => {
  const out = applySearchReplace(SRC, '  return "bye " + name;', '  return `bye ${name}`;')
  expect(out.ok).toBe(true)
  if (!out.ok) return
  expect(out.matchedExactly).toBe(true)
  expect(out.text).toContain('return `bye ${name}`;')
  expect(out.text).toContain('return "hello " + name;')
})

// Measured: every non-empty anchor the model produced matched byte-for-byte
// (docs/SPIKE-EDIT-PROBE.md). Whitespace tolerance is a safety net, not the main path.
test('falls back to whitespace-tolerant matching and reports it', () => {
  const out = applySearchReplace(SRC, 'return   "bye "   + name;', 'return BYE;')
  expect(out.ok).toBe(true)
  if (!out.ok) return
  expect(out.matchedExactly).toBe(false)
  expect(out.text).toContain('return BYE;')
})

// Measured: 2 of 5 runs on a trivial file emitted an empty search_text, which is
// schema-valid and would silently no-op.
test('rejects an empty anchor', () => {
  const out = applySearchReplace(SRC, '   ', 'x')
  expect(out.ok).toBe(false)
  if (out.ok) return
  expect(out.reason).toBe('empty')
})

test('rejects an anchor that appears more than once', () => {
  const out = applySearchReplace(SRC, '(name) {', '(who) {')
  expect(out.ok).toBe(false)
  if (out.ok) return
  expect(out.reason).toBe('ambiguous')
  expect(out.hint).toMatch(/2 places/)
})

test('reports the closest line when the anchor is not found', () => {
  const out = applySearchReplace(SRC, '  return "howdy " + name;', 'x')
  expect(out.ok).toBe(false)
  if (out.ok) return
  expect(out.reason).toBe('not_found')
  expect(out.hint).toContain('hello')
})

// Defect 1: source.replace(search, replace) treats `replace` as a replacement *pattern*,
// not literal text, even though `search` is a plain string. $&, $$, $` and $' must all be
// inserted verbatim, not expanded.
test('inserts $& in the replacement literally instead of expanding it to the matched text', () => {
  const out = applySearchReplace('OLD\n', 'OLD', 'NEW $& END')
  expect(out.ok).toBe(true)
  if (!out.ok) return
  expect(out.matchedExactly).toBe(true)
  expect(out.text).toBe('NEW $& END\n')
})

test('inserts $$ in the replacement literally instead of collapsing it to one dollar sign', () => {
  const out = applySearchReplace('run(cmd)\n', 'run(cmd)', 'echo $$')
  expect(out.ok).toBe(true)
  if (!out.ok) return
  expect(out.text).toBe('echo $$\n')
})

test('inserts $` in the replacement literally instead of splicing in the file prefix', () => {
  const out = applySearchReplace('prefix-text\nOLD\n', 'OLD', 'before $` after')
  expect(out.ok).toBe(true)
  if (!out.ok) return
  expect(out.text).toBe('prefix-text\nbefore $` after\n')
})

test("inserts $' in the replacement literally instead of splicing in trailing file content", () => {
  const out = applySearchReplace("OLD\nsuffix-text\n", 'OLD', "after $' end")
  expect(out.ok).toBe(true)
  if (!out.ok) return
  expect(out.text).toBe("after $' end\nsuffix-text\n")
})

// Defect 2: countOccurrences advances by the needle's length, so overlapping occurrences
// (e.g. the two overlapping "==" inside "===") are undercounted to 1 and the exact-match
// path silently applies an ambiguous anchor.
test('counts overlapping occurrences so a short ambiguous anchor is rejected, not silently applied', () => {
  const out = applySearchReplace('if (a === b) { x = 1; }\n', '==', 'IS_EQ')
  expect(out.ok).toBe(false)
  if (out.ok) return
  expect(out.reason).toBe('ambiguous')
})

// Defect 3: the not-found hint used to score similarity against the anchor's first line only,
// so two blocks sharing an identical opener tie and the hint always points at the first one,
// even when the anchor's near-miss body is inside the second block.
test('scores the not-found hint against the whole window, not just the first line, when openers repeat', () => {
  const src = [
    'if (config.enabled) {',
    '  doSomething();',
    '}',
    '',
    'if (config.enabled) {',
    '  doSomethingElse();',
    '  more();',
    '}',
    '',
  ].join('\n')
  const anchor = [
    'if (config.enabled) {',
    '  doSomethingEls();', // typo: near-miss for the *second* block's body
    '  more();',
    '}',
  ].join('\n')
  const out = applySearchReplace(src, anchor, 'x')
  expect(out.ok).toBe(false)
  if (out.ok) return
  expect(out.reason).toBe('not_found')
  expect(out.hint).toContain('line 5')
  expect(out.hint).not.toContain('line 1:')
})

test('the whitespace-tolerant path keeps the FILE\'s indentation, not the model\'s', () => {
  // This branch is entered BECAUSE the model's whitespace did not match, so its replacement's
  // indentation is the half already known to be wrong. Writing it back verbatim re-indents
  // the block — cosmetic in C#, a change of meaning in Python or YAML, and it lands exactly
  // when the model was least sure about layout.
  const py = [
    'def allocate(year):',
    '    row = db.query("select last")',
    '    nxt = row.last + 1',
    '    return nxt',
  ].join('\n')

  // The model quotes it unindented (so the exact match misses) and replaces it unindented.
  const out = applySearchReplace(
    py,
    'row = db.query("select last")\nnxt = row.last + 1',
    'row = db.query("select last for update")\nnxt = row.last + 1',
  )

  expect(out.ok).toBe(true)
  if (!out.ok) return
  expect(out.matchedExactly).toBe(false)
  // Four spaces, exactly as the file had them — not column zero.
  expect(out.text.split('\n')).toEqual([
    'def allocate(year):',
    '    row = db.query("select last for update")',
    '    nxt = row.last + 1',
    '    return nxt',
  ])
})

test('and a nested block inside the replacement keeps its own shape', () => {
  const src = [
    'def outer():',
    '    if ready:',
    '        go()',
  ].join('\n')

  const out = applySearchReplace(src, 'if ready:\n  go()', 'if ready:\n    go()\n    log()')

  expect(out.ok).toBe(true)
  if (!out.ok) return
  // The block moves to the file's indentation as a whole; its internal step is preserved.
  expect(out.text.split('\n')).toEqual([
    'def outer():',
    '    if ready:',
    '        go()',
    '        log()',
  ])
})

/**
 * A replacement that OPENS with a newline.
 *
 * `reindent` took the block's own indentation from `lines[0]`, and a leading blank line has
 * none — so the `had === ''` branch prepended the file's indent to EVERY line, including the
 * ones that were already right. A correctly-indented four-space replacement came back at
 * eight, `ok: true`, and python refused the file with "IndentationError: unindent does not
 * match any outer indentation level". The anchor has to be the first line that carries
 * indentation information, which a blank line does not.
 */
test('a replacement that starts with a newline is not shifted a level deeper', () => {
  const src = 'def f(x):\n    if  x:\n        go()\n    return 1\n'
  const out = applySearchReplace(src, '    if x:\n        go()', '\n    if y:\n        go()')
  expect(out.ok).toBe(true)
  // The fallback matched on whitespace, so it did reindent -- to the file's four, not eight.
  if (out.ok) {
    expect(out.matchedExactly).toBe(false)
    expect(out.text).toBe('def f(x):\n\n    if y:\n        go()\n    return 1\n')
  }
})

test('the ordinary shift still happens: a block moves to the indentation it landed in', () => {
  const src = 'def f(x):\n        if  x:\n            go()\n'
  const out = applySearchReplace(src, '    if x:\n        go()', '    if y:\n        go()')
  expect(out.ok).toBe(true)
  if (out.ok) expect(out.text).toBe('def f(x):\n        if y:\n            go()\n')
})

test('a replacement that is nothing but blank lines is left exactly as written', () => {
  const out = applySearchReplace('a\n  b\n', '  b', '\n\n')
  expect(out.ok).toBe(true)
  if (out.ok) expect(out.text).toBe('a\n\n\n\n')
})
