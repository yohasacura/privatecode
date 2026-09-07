import { describe, expect, test } from 'vitest'
import { allResolved, hasMarkers, parseConflicts, resolveText } from './conflicts'

const FILE = [
  'line 1',
  '<<<<<<< HEAD',
  'ours A',
  'ours B',
  '=======',
  'theirs A',
  '>>>>>>> feature',
  'middle',
  '<<<<<<< HEAD',
  'second ours',
  '||||||| base',
  'the base',
  '=======',
  'second theirs',
  '>>>>>>> feature',
  'last',
  '',
].join('\n')

describe('parseConflicts', () => {
  test('finds every block with its sides, labels and the plain text between', () => {
    const p = parseConflicts(FILE)
    expect(p.conflicts).toHaveLength(2)
    expect(p.segments.map((s) => s.kind)).toEqual(['text', 'conflict', 'text', 'conflict', 'text'])
    expect(p.conflicts[0]).toMatchObject({ ours: ['ours A', 'ours B'], theirs: ['theirs A'], base: null, oursLabel: 'HEAD', theirsLabel: 'feature' })
    expect(p.conflicts[1]).toMatchObject({ ours: ['second ours'], theirs: ['second theirs'], base: ['the base'] })
    expect(p.eol).toBe('\n')
    expect(p.trailingNewline).toBe(true)
  })

  test('a marker that never closes is content, and CRLF is kept', () => {
    const p = parseConflicts('a\r\n<<<<<<< HEAD\r\nb\r\n')
    expect(p.conflicts).toEqual([])
    expect(p.segments).toEqual([{ kind: 'text', lines: ['a', '<<<<<<< HEAD', 'b'] }])
    expect(p.eol).toBe('\r\n')
    expect(resolveText(p, new Map())).toBe('a\r\n<<<<<<< HEAD\r\nb\r\n')
  })
})

describe('resolveText', () => {
  test('rebuilds the file from the choices, in either order or with both', () => {
    const p = parseConflicts(FILE)
    expect(allResolved(p, new Map())).toBe(false)
    const choices = new Map([[0, 'both' as const], [1, 'theirs' as const]])
    expect(allResolved(p, choices)).toBe(true)
    expect(resolveText(p, choices)).toBe(['line 1', 'ours A', 'ours B', 'theirs A', 'middle', 'second theirs', 'last', ''].join('\n'))
    expect(resolveText(p, new Map([[0, 'both-reversed' as const], [1, 'ours' as const]])))
      .toBe(['line 1', 'theirs A', 'ours A', 'ours B', 'middle', 'second ours', 'last', ''].join('\n'))
  })

  test('a hand-edited block wins over its checkbox, and drops the markers', () => {
    const p = parseConflicts(FILE)
    const custom = new Map([[0, ['merged by hand']]])
    const choices = new Map([[1, 'ours' as const]])
    expect(allResolved(p, choices, custom)).toBe(true)
    const text = resolveText(p, choices, custom)
    expect(text).toContain('merged by hand')
    expect(hasMarkers(text)).toBe(false)
    expect(hasMarkers(FILE)).toBe(true)
  })
})
