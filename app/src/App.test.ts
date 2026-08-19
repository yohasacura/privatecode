import { describe, expect, it } from 'vitest'
import { withRecentFirst } from './App'

/**
 * The welcome screen's memory of where the window is.
 *
 * `workspaceInput` and `recents` used to be written at boot and by the welcome form and
 * nowhere else, so switching workspaces left both describing the workspace you had LEFT:
 * open A, switch to B, press Close workspace, and the start screen came back offering A —
 * which "Open workspace" then opened, and persisted as the one to auto-connect to next
 * launch. The user believes they are reopening the workspace they just closed.
 */
describe('withRecentFirst', () => {
  it('puts the workspace that was just opened at the head of the list', () => {
    expect(withRecentFirst(['D:\\a', 'D:\\b'], 'D:\\c')).toEqual(['D:\\c', 'D:\\a', 'D:\\b'])
  })

  it('promotes a workspace that was already in the list instead of repeating it', () => {
    expect(withRecentFirst(['D:\\a', 'D:\\b', 'D:\\c'], 'D:\\c'))
      .toEqual(['D:\\c', 'D:\\a', 'D:\\b'])
  })

  it('treats a path that differs only in case as the same folder', () => {
    // Windows is the target platform and the two paths that reach here come from a person
    // typing and from the folder picker, which disagree about the drive letter's case at
    // least. Listed twice, the older spelling is a button that reopens the same place while
    // claiming to be somewhere else.
    expect(withRecentFirst(['d:\\projects\\app', 'D:\\other'], 'D:\\Projects\\App'))
      .toEqual(['D:\\Projects\\App', 'D:\\other'])
  })

  it('works from nothing, which is every first launch', () => {
    expect(withRecentFirst([], 'D:\\a')).toEqual(['D:\\a'])
  })

  it('leaves the rest of the list in the order the host wrote it', () => {
    expect(withRecentFirst(['D:\\a', 'D:\\b', 'D:\\c', 'D:\\d'], 'D:\\c'))
      .toEqual(['D:\\c', 'D:\\a', 'D:\\b', 'D:\\d'])
  })
})
