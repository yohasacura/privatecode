import { describe, expect, it } from 'vitest'
import { formatDuration } from './format'

describe('formatDuration', () => {
  it('whole seconds under a minute', () => {
    expect(formatDuration(500)).toBe('0.5s')
    expect(formatDuration(42_000)).toBe('42s')
  })

  it('never renders sixty seconds — the live "1m 60s" bug', () => {
    // 119.6s: floor(1.99m)=1 next to round(59.6s)=60 read "1m 60s" on a running step.
    // Rounding to whole seconds FIRST makes the pair carry, to "2m 00s".
    expect(formatDuration(119_600)).toBe('2m 00s')
    expect(formatDuration(59_600)).toBe('1m 00s')
    expect(formatDuration(60_000)).toBe('1m 00s')
    expect(formatDuration(89_400)).toBe('1m 29s')
  })

  it('hours drop seconds', () => {
    expect(formatDuration(3_600_000)).toBe('1h 00m')
  })
})
