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
