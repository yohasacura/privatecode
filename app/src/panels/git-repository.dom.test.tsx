// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { GitCommitRow, GitRefs, GitRepoView } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import type { GitView } from '../lib/git-views'
import { GitRepositoryView } from './git-repository'

/**
 * The repository window, against a scripted host: branches on the left, the graph with
 * its Incoming/Outgoing sections, the commit details on a click, and the actions that
 * reach git through the menus and dialogs.
 */

const HEAD = { branch: 'main', detached: false, unborn: false, oid: 'c3', upstream: 'origin/main', ahead: 1, behind: 1, upstreamGone: false }
const REPO: GitRepoView = { root: 'D:\\proj', label: 'proj', branch: 'main', relation: 'folder', suggestion: '', head: HEAD, stashes: 0, operation: null, files: [] }
const REFS: GitRefs = {
  local: [
    { name: 'main', sha: 'c3', short: 'c3', subject: 'third', date: '2026-09-04T10:00:00Z', current: true, upstream: 'origin/main', ahead: 1, behind: 1 },
    { name: 'feature', sha: 'f1', short: 'f1', subject: 'feature work', date: '2026-09-04T09:00:00Z', current: false },
  ],
  remote: [{ name: 'origin/main', sha: 'r1', short: 'r1', subject: 'theirs', date: '2026-09-04T10:30:00Z', current: false, remote: 'origin' }],
  tags: [{ name: 'v1', sha: 'c1', short: 'c1', subject: 'first', date: '2026-09-01T10:00:00Z', annotated: false }],
}
const commit = (sha: string, parents: string[], subject: string, refs: GitCommitRow['refs'] = []): GitCommitRow => ({
  sha, short: sha, parents, subject, authorName: 'test', authorEmail: 'test@test', authorDate: '2026-09-04T10:00:00Z', committerDate: '2026-09-04T10:00:00Z', refs,
})
const HISTORY = [commit('c3', ['c2'], 'third', [{ name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'local' }]), commit('c2', ['c1'], 'second'), commit('c1', [], 'first', [{ name: 'v1', kind: 'tag' }])]

function fakeClient(handlers: Partial<Record<string, (params: unknown) => unknown>> = {}): ProtocolClient & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params])
      const h = handlers[method]
      if (h !== undefined) return h(params)
      if (method === 'git.status') return { repos: [REPO], unversioned: [] }
      if (method === 'git.refs') return REFS
      if (method === 'git.log') {
        const p = params as { range?: string }
        if (p.range === 'HEAD..origin/main') return { commits: [commit('r1', ['c2'], 'theirs')] }
        if (p.range === 'origin/main..HEAD') return { commits: [HISTORY[0]] }
        return { commits: HISTORY }
      }
      if (method === 'git.commitDetails') {
        return { details: { sha: 'c2', short: 'c2', parents: ['c1'], subject: 'second', body: 'more words', authorName: 'test', authorEmail: 'test@test', authorDate: '2026-09-04T10:00:00Z', committerName: 'test', committerDate: '2026-09-04T10:00:00Z', refs: [], base: 'c1', files: [{ path: 'src/app.ts', status: 'M', additions: 3, deletions: 1, binary: false }] } }
      }
      if (method === 'git.diffBetween') return { diff: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n' }
      return { ok: true }
    }),
    on: () => () => {},
  } as unknown as ProtocolClient & { calls: Array<[string, unknown]> }
}

const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve() }) }
let host: HTMLDivElement | null = null
afterEach(() => { if (host) { render(null, host); host.remove(); host = null } })

async function mount(client: ProtocolClient, onOpenView: (v: GitView) => void = () => {}): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => { render(<GitRepositoryView client={client} root={'D:\\proj'} label="proj" reloadKey={0} onOpenFile={() => {}} onOpenView={onOpenView} />, host!) })
  await flush()
  await flush()
  return host
}

describe('the Git Repository window', () => {
  test('lists local branches, remotes and tags, and draws the history with its sync sections', async () => {
    const el = await mount(fakeClient())
    const branches = [...el.querySelectorAll('[data-branch]')].map((b) => b.getAttribute('data-branch'))
    expect(branches).toEqual(['main', 'feature', 'origin/main'])
    expect(el.querySelector('[data-git-branches]')?.textContent).toContain('Tags')
    const text = el.querySelector('[data-git-graph]')?.textContent ?? ''
    expect(text).toContain('Incoming')
    expect(text).toContain('Outgoing')
    expect(text).toContain('Local History')
    const rows = [...el.querySelectorAll('[data-commit]')].map((r) => r.getAttribute('data-commit'))
    expect(rows).toEqual(['r1', 'c3', 'c3', 'c2', 'c1'])
    // The graph is drawn for the history rows: one svg per row.
    expect(el.querySelectorAll('[data-git-graph] svg[data-graph]').length).toBe(3)
  })

  test('selecting a commit shows its details and a file diff; two selected offer Compare', async () => {
    const views: GitView[] = []
    const client = fakeClient()
    const el = await mount(client, (v) => views.push(v))
    const row = [...el.querySelectorAll('[data-commit="c2"]')].pop() as HTMLElement
    await act(async () => { row.click() })
    await flush()
    await flush()
    expect(el.querySelector('[data-git-details]')?.textContent).toContain('second')
    expect(el.querySelector('[data-git-details]')?.textContent).toContain('more words')
    const file = el.querySelector('[data-commit-file="src/app.ts"]') as HTMLButtonElement
    await act(async () => { file.click() })
    await flush()
    await flush()
    expect(client.calls.find(([m]) => m === 'git.diffBetween')?.[1]).toEqual({ root: 'D:\\proj', from: 'c1', to: 'c2', path: 'src/app.ts' })
    expect(el.querySelector('[data-git-details]')?.textContent).toContain('new')

    // Ctrl-click a second commit, then Compare Commits from the menu.
    const first = [...el.querySelectorAll('[data-commit="c1"]')].pop() as HTMLElement
    await act(async () => { first.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })) })
    await flush()
    const menu = first.querySelector('button[aria-label="Commit actions"]') as HTMLButtonElement
    await act(async () => { menu.click() })
    await flush()
    const compare = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.includes('Compare Commits')) as HTMLElement
    expect(compare).toBeDefined()
    await act(async () => { compare.click() })
    await flush()
    expect(views[0]).toMatchObject({ kind: 'compare', root: 'D:\\proj', from: 'c1', to: 'c2' })
  })

  test('a branch is checked out from its menu and merged after a confirmation', async () => {
    const client = fakeClient()
    const el = await mount(client)
    const feature = el.querySelector('[data-branch="feature"]') as HTMLElement
    const menu = feature.querySelector('button[aria-label="Branch actions"]') as HTMLButtonElement
    await act(async () => { menu.click() })
    await flush()
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim())
    expect(items).toEqual(expect.arrayContaining(['View history', 'Checkout', "Merge 'feature' into 'main'", "Rebase 'main' onto 'feature'", 'Compare with current branch', 'Push', 'Rename…', 'Delete…']))
    const merge = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.includes('Merge ')) as HTMLElement
    await act(async () => { merge.click() })
    await flush()
    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent?.trim() === 'Merge') as HTMLButtonElement
    await act(async () => { confirm.click() })
    await flush()
    await flush()
    expect(client.calls.find(([m]) => m === 'git.merge')?.[1]).toEqual({ root: 'D:\\proj', branch: 'feature' })
  })

  test('reset asks which kind, then resets to the commit', async () => {
    const client = fakeClient()
    const el = await mount(client)
    const row = [...el.querySelectorAll('[data-commit="c1"]')].pop() as HTMLElement
    const menu = row.querySelector('button[aria-label="Commit actions"]') as HTMLButtonElement
    await act(async () => { menu.click() })
    await flush()
    const reset = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.trim() === 'Reset…') as HTMLElement
    await act(async () => { reset.click() })
    await flush()
    const hard = [...document.querySelectorAll('[data-dialog="reset"] input')].pop() as HTMLInputElement
    await act(async () => { hard.click() })
    const go = document.querySelector('[data-action="reset"]') as HTMLButtonElement
    await act(async () => { go.click() })
    await flush()
    await flush()
    expect(client.calls.find(([m]) => m === 'git.reset')?.[1]).toEqual({ root: 'D:\\proj', sha: 'c1', mode: 'hard' })
  })

  test('the new-branch dialog creates a branch from the chosen base', async () => {
    const client = fakeClient()
    const el = await mount(client)
    await act(async () => { (el.querySelector('[data-action="new-branch"]') as HTMLButtonElement).click() })
    await flush()
    const input = document.querySelector('[data-dialog="new-branch"] input') as HTMLInputElement
    await act(async () => { input.value = 'topic/x'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { (document.querySelector('[data-action="create-branch"]') as HTMLButtonElement).click() })
    await flush()
    await flush()
    expect(client.calls.find(([m]) => m === 'git.branchCreate')?.[1]).toEqual({ root: 'D:\\proj', name: 'topic/x', base: 'main', checkout: true, track: false })
  })
})
