import { describe, expect, it } from 'vitest'
import { decisionsAreNews, notify, shouldAnnounce } from './notify'

/**
 * The rules about when NOT to interrupt.
 *
 * These are the part with a wrong answer available. A notification for something you are
 * already watching trains you to dismiss them on sight, and after that the one at 02:00 does
 * not work either.
 */

describe('when something is worth interrupting for', () => {
  it('not while you are looking at the window', () => {
    expect(shouldAnnounce({ focused: true, tauri: true })).toBe(false)
  })

  it('yes when the window is behind something else', () => {
    expect(shouldAnnounce({ focused: false, tauri: true })).toBe(true)
  })

  it('never outside the desktop shell, where there is nothing to notify with', () => {
    // The dev bridge is a plain browser tab: no Tauri, no taskbar to flash.
    expect(shouldAnnounce({ focused: false, tauri: false })).toBe(false)
  })
})

describe('a change in parked decisions', () => {
  it('is news when the count rises', () => {
    expect(decisionsAreNews(0, 1)).toBe(true)
    expect(decisionsAreNews(2, 5)).toBe(true)
  })

  it('is not news when it falls, because that was you answering them', () => {
    expect(decisionsAreNews(3, 2)).toBe(false)
    expect(decisionsAreNews(1, 0)).toBe(false)
  })

  it('is not news when it has not moved', () => {
    // The event fires on both edges by design, so a repeat must be silent.
    expect(decisionsAreNews(4, 4)).toBe(false)
  })
})

describe('failing to notify', () => {
  it('is never able to throw at the caller', async () => {
    // Every call site is `void notify(...)` inside an event handler. A rejected promise
    // there is an unhandled rejection in the renderer, over something as unimportant as a
    // refused notification permission.
    await expect(notify('title', 'body')).resolves.toBe(false)
  })
})
