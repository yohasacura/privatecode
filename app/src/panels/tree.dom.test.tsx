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

/** The right-click on the rows: the file's actions, the folder's worth of staging, and
 * the Git items that ask the host where a clean file lives. */
async function drawWithGit(opts: {
  marks?: Map<string, import('../lib/git-scm').GitMark>
  gitActions?: import('./tree').GitRowActions
  onOpenView?: (v: import('../lib/git-views').GitView) => void
  locate?: (path: string) => { root: string | null; repoPath: string | null }
}): Promise<void> {
  client = {
    call: vi.fn(async (method: string, params: { path?: string }) => {
      if (method === 'fs.tree') return { entries: params.path === 'src' ? [{ name: 'x.ts', dir: false }] : [{ name: 'a.ts', dir: false }, { name: 'src', dir: true }] }
      if (method === 'git.locate') return opts.locate?.(params.path ?? '') ?? { root: null, repoPath: null }
      return {}
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
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
      reloadKey={0}
      find={null}
      {...(opts.marks !== undefined ? { git: opts.marks } : {})}
      {...(opts.gitActions !== undefined ? { gitActions: opts.gitActions } : {})}
      {...(opts.onOpenView !== undefined ? { onOpenView: opts.onOpenView } : {})}
    />,
    host,
  )
  await settle()
}
const rightClickRow = async (path: string): Promise<string[]> => {
  const row = host.querySelector(`[data-tree-row="${path}"]`)!
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40, button: 2 }))
  await settle(2)
  return [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim() ?? '')
}
const choose = async (label: string): Promise<void> => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.trim() === label) as HTMLElement | undefined
  expect(item, label).toBeDefined()
  item!.click()
  await settle(2)
}
const mark = (extra: Partial<import('../lib/git-scm').GitMark> = {}): import('../lib/git-scm').GitMark => ({
  letter: 'M', staged: false, dirty: true, untracked: false, repoRoot: 'D:/ws', repoPath: 'a.ts', ...extra,
})

test('a changed file\'s right-click: open, diff, its git actions, history and blame, the path', async () => {
  const stage = vi.fn()
  const discard = vi.fn()
  const views: unknown[] = []
  await drawWithGit({
    marks: new Map([['a.ts', mark()]]),
    gitActions: { busy: false, stage, unstage: vi.fn(), discard, ignore: vi.fn() },
    onOpenView: (v) => views.push(v),
  })
  const labels = await rightClickRow('a.ts')
  expect(labels).toEqual(['Open', 'View diff', 'Stage', 'Undo Changes…', 'View history', 'Blame (annotate)', 'Copy path'])
  await choose('Stage')
  expect(stage).toHaveBeenCalledWith('a.ts')
  await rightClickRow('a.ts')
  await choose('Undo Changes…')
  expect(discard).toHaveBeenCalledWith('a.ts')
  await rightClickRow('a.ts')
  await choose('View history')
  expect(views).toEqual([{ kind: 'history', root: 'D:/ws', repoPath: 'a.ts', path: 'a.ts' }])
})

test('an untracked file offers to ignore it, by name or by extension', async () => {
  const ignore = vi.fn()
  await drawWithGit({
    marks: new Map([['a.ts', mark({ letter: 'U', untracked: true, dirty: true })]]),
    gitActions: { busy: false, stage: vi.fn(), unstage: vi.fn(), ignore },
  })
  const labels = await rightClickRow('a.ts')
  expect(labels).toEqual(expect.arrayContaining(['Ignore this file', 'Ignore all *.ts files']))
  await choose('Ignore all *.ts files')
  expect(ignore).toHaveBeenCalledWith('a.ts', '*.ts')
})

test('a folder\'s right-click stages everything changed inside it, in one go', async () => {
  const stageMany = vi.fn()
  await drawWithGit({
    marks: new Map([['src/x.ts', mark({ repoPath: 'src/x.ts' })], ['a.ts', mark({ staged: true, dirty: false })]]),
    gitActions: { busy: false, stage: vi.fn(), unstage: vi.fn(), stageMany, unstageMany: vi.fn() },
  })
  const labels = await rightClickRow('src')
  expect(labels).toEqual(['Stage all inside (1)', 'Unstage all inside', 'Copy path'])
  await choose('Stage all inside (1)')
  expect(stageMany).toHaveBeenCalledWith(['src/x.ts'])
})

test('View history on a clean file asks the host which repository holds it', async () => {
  const views: unknown[] = []
  await drawWithGit({
    onOpenView: (v) => views.push(v),
    locate: (path) => ({ root: 'D:/ws/nested', repoPath: path }),
  })
  const labels = await rightClickRow('a.ts')
  expect(labels).toEqual(['Open', 'View history', 'Blame (annotate)', 'Copy path'])
  await choose('Blame (annotate)')
  await settle(2)
  expect(views).toEqual([{ kind: 'blame', root: 'D:/ws/nested', repoPath: 'a.ts', path: 'a.ts' }])
})
