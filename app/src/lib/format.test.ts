import { describe, expect, it } from 'vitest'
import { formatDuration, formatProgress } from './format'

describe('formatProgress', () => {
  it('reads prefill as a fraction, with what the cache saved', () => {
    expect(formatProgress({ prompt: { processed: 12_400, total: 18_100, cache: 9_700 } }))
      .toBe('reading 12.4k / 18.1k · 9.7k cached')
  })

  it('spells a zero cache out, because zero is the loudest reading there is', () => {
    // Nothing reused means the whole prompt is being re-read — on this machine the
    // difference between half a second and half a minute. A bare `0` is skimmed past.
    expect(formatProgress({ prompt: { processed: 200, total: 92_000, cache: 0 } }))
      .toBe('reading 200 / 92.0k · none cached')
  })

  it('clamps a processed count that overshoots its total', () => {
    // The two come from different counters on the server, and "19.0k / 18.1k" reads as a
    // bug in the app rather than as the last batch of a finished prefill.
    expect(formatProgress({ prompt: { processed: 19_000, total: 18_100, cache: 0 } }))
      .toBe('reading 18.1k / 18.1k · none cached')
  })

  it('reads generation as tokens and a rate', () => {
    expect(formatProgress({ generated: { tokens: 1_240, perSecond: 61.4 } })).toBe('1.2k tokens · 61 tok/s')
    expect(formatProgress({ generated: { tokens: 7 } })).toBe('7 tokens')
  })

  it('says nothing when there is nothing measured to say', () => {
    expect(formatProgress({})).toBeNull()
    expect(formatProgress({ generated: { tokens: 0 } })).toBeNull()
    expect(formatProgress({ prompt: { processed: 0, total: 0, cache: 0 } })).toBeNull()
  })
})

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
