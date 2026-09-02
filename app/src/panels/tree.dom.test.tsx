// @vitest-environment happy-dom
import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { TreePanel } from './tree'

/**
 * The external-change refresh, pinned where it can actually fail, and the tree's two
 * edges from docs/UI-REDESIGN-2026-09.md §7: a folder that cannot be read, and find.
 *
 * The refresh defect: switch branch in another editor and PrivateCode kept showing the old
 * file list until the app was restarted. The tree only ever re-read a directory that one of
 * ITS OWN write tools had touched, so nothing external could reach it. `reloadKey` is the
 * signal now, and these tests fail if it is dropped from the dependency array — the exact
 * shape of the original bug.
 */

let host: HTMLElement
let calls: string[]
let client: ProtocolClient
let opened: string[]

/** Only `fs.tree` matters here; everything else the panel might reach for is inert. */
function stubClient(): ProtocolClient {
  return {
    call: vi.fn(async (method: string, params: { path?: string; query?: string }) => {
      if (method === 'fs.find') {
        return { entries: [{ path: `src/${params.query ?? ''}.ts`, dir: false }, { path: 'src', dir: true }] }
      }
      if (method !== 'fs.tree') return {}
      calls.push(params.path ?? '')
      return { entries: [{ name: 'a.ts', dir: false }, { name: 'src', dir: true }] }
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}

function draw(reloadKey: number, find: string | null = null): void {
  render(
    <TreePanel
      client={client}
      toolItems={[]}
      onOpenFile={(p) => opened.push(p)}
      workspaceRoot="D:/ws"
      decor={undefined}
      mounts={[]}
      filterChanged={false}
      reviewedPaths={new Set()}
      onOpenDiff={() => {}}
      reloadKey={reloadKey}
      find={find}
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
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 40))
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  calls = []
  opened = []
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

test('a folder that cannot be read says "access denied" and offers the same fetch again', async () => {
  client = {
    call: vi.fn(async (method: string, params: { path?: string }) => {
      if (method !== 'fs.tree') return {}
      if ((params.path ?? '') === '') return { entries: [{ name: 'secret', dir: true }] }
      throw new Error('EACCES: permission denied, scandir D:/ws/secret')
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
  draw(0)
  await settle()
  const row = host.querySelector<HTMLButtonElement>('[data-tree-row="secret"]')!
  row.click()
  await settle()
  const err = host.querySelector('[data-tree-error]')!
  expect(err.textContent).toContain('access denied')
  expect(err.getAttribute('title') ?? err.querySelector('[title]')?.getAttribute('title')).toContain('EACCES')
  expect(err.querySelector('button')?.textContent).toBe('Retry')
})

test('find asks the host’s index, and a hit opens the file', async () => {
  draw(0, 'snap')
  await settle()
  const rows = [...host.querySelectorAll<HTMLButtonElement>('[data-tree-find] [data-tree-row]')]
  expect(rows.map((r) => r.dataset['treeRow'])).toEqual(['src/snap.ts', 'src'])
  rows[0]!.click()
  expect(opened).toEqual(['src/snap.ts'])
  // The tree itself is not on screen while a find is: the rows ARE the answer.
  expect(host.querySelector('[data-tree]')).toBeNull()
})
