// @vitest-environment happy-dom
import { expect, test } from 'vitest'
import { stashUpdateFailure, takeUpdateFailure } from './update'

/**
 * The failure an update carries across the window's reload — a DOM test because it lives in
 * `sessionStorage`, which the node environment update.test.ts runs in does not have.
 */

test('a failure stashed before a reload is read back once, then gone', () => {
  const update = { currentVersion: '0.4.1', newVersion: '0.4.1', downloadBytes: 148_843_375, notesUrl: 'https://example.invalid/v0.4.1', sidecarOnly: true }
  stashUpdateFailure(update, 'could not move the old sidecar aside: Access is denied. (os error 5)')
  expect(takeUpdateFailure()).toEqual({ update, error: 'could not move the old sidecar aside: Access is denied. (os error 5)' })
  // Consumed: the next load of the window is an ordinary one.
  expect(takeUpdateFailure()).toBeNull()
})

test('a stash that is not what this code wrote is ignored rather than trusted', () => {
  sessionStorage.setItem('privatecode.update-failure', '{"update":{"newVersion":1},"error":"x"}')
  expect(takeUpdateFailure()).toBeNull()
  sessionStorage.setItem('privatecode.update-failure', 'not json')
  expect(takeUpdateFailure()).toBeNull()
  expect(sessionStorage.getItem('privatecode.update-failure')).toBeNull()
})
