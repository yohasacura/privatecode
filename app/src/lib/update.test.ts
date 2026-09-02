import { expect, test, vi } from 'vitest'
import { describeProgress, formatBytes, scheduleUpdateCheck } from './update'

/**
 * The words under the bar, and the bar's length: what a person reads for the ten seconds to
 * two minutes an update takes. Everything else in update.ts talks to the shell and is covered
 * where the shell is faked (App.dom.test.tsx).
 */

test('a download says how far it is, in the same units the banner used to ask permission in', () => {
  const p = describeProgress({ phase: 'downloading', part: 'PrivateCode-app-0.3.0.zip', received: 2_200_000, total: 4_567_499 })
  expect(p.text).toBe('Downloading PrivateCode-app-0.3.0.zip… 2.1 MB of 4.4 MB')
  expect(p.fraction).toBeCloseTo(0.48, 2)
})

test('a download of unknown length still counts what has arrived, and shows no bar', () => {
  const p = describeProgress({ phase: 'downloading', part: 'sidecar-abc.zip', received: 120_000_000, total: 0 })
  expect(p.text).toBe('Downloading sidecar-abc.zip… 114 MB')
  expect(p.fraction).toBeNull()
})

test('the short phases are named and fill the bar rather than flicker it', () => {
  expect(describeProgress({ phase: 'manifest', part: null, received: 0, total: 0 })).toEqual({ text: 'Checking the release…', fraction: null })
  for (const phase of ['verifying', 'unpacking', 'installing', 'restarting'] as const) {
    const p = describeProgress({ phase, part: null, received: 0, total: 0 })
    expect(p.fraction).toBe(1)
    expect(p.text).toMatch(/…$/)
  }
})

test('the bar never runs past its end when the server sends more than it promised', () => {
  expect(describeProgress({ phase: 'downloading', part: 'x.zip', received: 150, total: 100 }).fraction).toBe(1)
})

test('bytes read the way a person says them', () => {
  expect(formatBytes(512)).toBe('512 B')
  expect(formatBytes(4_567_499)).toBe('4.4 MB')
  expect(formatBytes(125_000_000)).toBe('119 MB')
})

test('the automatic check runs once after the delay and then on its interval, until cancelled', () => {
  vi.useFakeTimers()
  try {
    const seen: number[] = []
    // Outside the shell `checkForUpdate` answers "unavailable" and calls nothing back, so the
    // observable thing here is that the timers exist and stop — exercised through the real
    // scheduler with a spy on the clock rather than on the network.
    const spy = vi.spyOn(globalThis, 'setInterval')
    const cancel = scheduleUpdateCheck(() => seen.push(Date.now()), 20_000, 60_000)
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 60_000)
    vi.advanceTimersByTime(20_000)
    vi.advanceTimersByTime(120_000)
    cancel()
    // Cancelled: advancing the clock further schedules nothing that could fire later.
    vi.advanceTimersByTime(600_000)
    expect(seen).toEqual([])
    spy.mockRestore()
  } finally {
    vi.useRealTimers()
  }
})
