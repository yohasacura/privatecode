import { describe, expect, test } from 'vitest'
import { dayLabel, groupByDay } from './day-groups'

const now = new Date(2026, 8, 2, 18, 30) // Wednesday 2 September 2026

describe('day labels', () => {
  test('today, yesterday, the weekday inside a week, then the date', () => {
    expect(dayLabel(new Date(2026, 8, 2, 9), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 8, 1, 23, 59), now)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 7, 31), now)).toBe(new Date(2026, 7, 31).toLocaleDateString(undefined, { weekday: 'long' }))
    expect(dayLabel(new Date(2026, 7, 20), now)).toBe(new Date(2026, 7, 20).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }))
    expect(dayLabel(new Date(2025, 11, 24), now)).toContain('2025')
  })
})

describe('grouping', () => {
  test('sorts newest first and keeps one group per day, in order', () => {
    const items = [
      { id: 'a', at: '2026-09-01T10:00:00' },
      { id: 'b', at: '2026-09-02T12:00:00' },
      { id: 'c', at: '2026-09-02T08:00:00' },
      { id: 'd', at: 'not a date' },
    ]
    const groups = groupByDay(items, (i) => i.at, now)
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Today', ['b', 'c']],
      ['Yesterday', ['a']],
      ['Undated', ['d']],
    ])
  })

  test('an empty list is no groups', () => {
    expect(groupByDay([], () => '', now)).toEqual([])
  })
})
