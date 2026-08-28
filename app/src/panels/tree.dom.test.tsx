// @vitest-environment happy-dom
import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { TreePanel } from './tree'

/**
 * The external-change refresh, pinned where it can actually fail.
 *
 * The defect: switch branch in another editor and PrivateCode kept showing the old file
 * list until the app was restarted. The tree only ever re-read a directory that one of
 * ITS OWN write tools had touched, so nothing external could reach it. `reloadKey` is the
 * signal now, and these tests fail if it is dropped from the dependency array — the exact
 * shape of the original bug.
 */

let host: HTMLElement
let calls: string[]
let client: ProtocolClient

/** Only `fs.tree` matters here; everything else the panel might reach for is inert. */
function stubClient(): ProtocolClient {
  return {
    call: vi.fn(async (method: string, params: { path?: string }) => {
      if (method !== 'fs.tree') return {}
      calls.push(params.path ?? '')
      return { entries: [{ name: 'a.ts', dir: false }, { name: 'src', dir: true }] }
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}

function draw(reloadKey: number): void {
  render(
    <TreePanel
      client={client}
      toolItems={[]}
      onOpenFile={() => {}}
      workspaceRoot="D:/ws"
      decor={undefined}
      mounts={[]}
      filterChanged={false}
      reviewedPaths={new Set()}
      onOpenDiff={() => {}}
      reloadKey={reloadKey}
    />,
    host,
  )
}

/**
 * Real timer ticks, not microtasks: Preact defers `useEffect` to after paint, which
 * happy-dom services from a timer, so a `Promise.resolve()` chain returns before any
 * effect has run. Same helper as `App.dom.test.tsx`, same reason.
 */
async function settle(ticks = 4): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 20))
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  calls = []
  client = stubClient()
})
afterEach(() => {
  render(null, host)
  host.remove()
})

test('the first render fetches the root exactly once', async () => {
  draw(0)
  await settle()
  // The guard that makes the refresh effect skip its first run. Without it every mount
  // pays two round trips for the same directory.
  expect(calls).toEqual([''])
})

test('bumping reloadKey re-reads the directories already on screen', async () => {
  draw(0)
  await settle()
  calls = []

  draw(1)
  await settle()

  // The root is loaded, so the root is re-read. This is the assertion that fails when
  // `reloadKey` is not wired: an external branch switch produced no fetch at all.
  expect(calls).toContain('')
})

test('an unchanged reloadKey on re-render does not re-fetch', async () => {
  draw(3)
  await settle()
  calls = []

  // A parent re-rendering for an unrelated reason (a streamed token, a hover) must not
  // spawn a tree refresh — the panel re-renders constantly during a turn.
  draw(3)
  await settle()

  expect(calls).toEqual([])
})
