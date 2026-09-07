// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { GitRepoView, GitStatusResult } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import type { GitView } from '../lib/git-views'
import { GitTab } from './git-tab'

/**
 * The Git tab, against a scripted host: the sections it draws from one `git.status`, the
 * calls its buttons make, and the questions it asks before anything destructive.
 */

const HEAD = { branch: 'main', detached: false, unborn: false, oid: 'abc123', upstream: 'origin/main', ahead: 1, behind: 2, upstreamGone: false }

function repo(overrides: Partial<GitRepoView> = {}): GitRepoView {
  return {
    root: 'D:\\proj', label: 'proj', branch: 'main', relation: 'folder', suggestion: '', head: HEAD, stashes: 0, operation: null,
    files: [
      { path: 'src/app.ts', repoPath: 'src/app.ts', code: ' M', staged: false, untracked: false },
      { path: 'src/new.ts', repoPath: 'src/new.ts', code: '??', staged: false, untracked: true },
      { path: 'README.md', repoPath: 'README.md', code: 'M ', staged: true, untracked: false },
    ],
    ...overrides,
  }
}

function fakeClient(status: GitStatusResult, handlers: Partial<Record<string, (params: unknown) => unknown>> = {}): ProtocolClient & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  const client = {
    calls,
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params])
      if (method === 'git.status') return status
      if (method === 'git.version') return { version: 'git version 2.54.0' }
      if (method === 'git.stashList') return { stashes: [] }
      const h = handlers[method]
      if (h === undefined) return { ok: true }
      return h(params)
    }),
    on: () => () => {},
  } as unknown as ProtocolClient & { calls: Array<[string, unknown]> }
  return client
}

const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }) }

let host: HTMLDivElement | null = null
afterEach(() => { if (host) { render(null, host); host.remove(); host = null } })

async function mount(client: ProtocolClient, extra: { onOpenFile?: (path: string, face?: 'file' | 'diff') => void; onOpenView?: (v: GitView) => void } = {}): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    render(<GitTab client={client} reloadKey={0} active={false} onOpenFile={extra.onOpenFile ?? (() => {})} onOpenView={extra.onOpenView ?? (() => {})} />, host!)
  })
  await flush()
  return host
}

describe('the Git tab', () => {
  test('draws the branch, the sync state and the three lists from one status', async () => {
    const client = fakeClient({ repos: [repo()], unversioned: [] })
    const el = await mount(client)
    expect(el.querySelector('[data-action="branch-picker"]')?.textContent).toContain('main')
    expect(el.querySelector('[data-action="open-repository"]')?.textContent).toContain('↑1 ↓2 1 outgoing / 2 incoming')
    const rows = [...el.querySelectorAll('[data-git-row]')].map((r) => `${r.getAttribute('data-section')}:${r.getAttribute('data-git-row')}`)
    expect(rows).toEqual(['staged:README.md', 'change:src/app.ts', 'change:src/new.ts'])
    // Something is staged, so the primary button commits the index.
    expect(el.querySelector('[data-action="commit"]')?.textContent).toContain('Commit Staged (1)')
  })

  test('stage, unstage and commit reach the host with repository-relative paths', async () => {
    const client = fakeClient({ repos: [repo()], unversioned: [] }, { 'git.commitIndex': () => ({ ok: true, sha: 'def456' }) })
    const el = await mount(client)
    const stage = el.querySelector('[data-git-row="src/app.ts"] button[aria-label="Stage"]') as HTMLButtonElement
    await act(async () => { stage.click() })
    await flush()
    expect(client.calls.find(([m]) => m === 'git.stagePaths')?.[1]).toEqual({ root: 'D:\\proj', paths: ['src/app.ts'] })
    const unstage = el.querySelector('[data-git-row="README.md"] button[aria-label="Unstage"]') as HTMLButtonElement
    await act(async () => { unstage.click() })
    await flush()
    expect(client.calls.find(([m]) => m === 'git.unstagePaths')?.[1]).toEqual({ root: 'D:\\proj', paths: ['README.md'] })

    const box = el.querySelector('textarea[aria-label="Commit message"]') as HTMLTextAreaElement
    await act(async () => {
      box.value = 'first change'
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const commit = el.querySelector('[data-action="commit"]') as HTMLButtonElement
    expect(commit.disabled).toBe(false)
    await act(async () => { commit.click() })
    await flush()
    expect(client.calls.find(([m]) => m === 'git.commitIndex')?.[1]).toEqual({ root: 'D:\\proj', message: 'first change', all: false, amend: false })
  })

  test('commit all is the primary action when nothing is staged, and needs a message', async () => {
    const files = repo().files.filter((f) => !f.staged)
    const client = fakeClient({ repos: [repo({ files })], unversioned: [] })
    const el = await mount(client)
    const commit = el.querySelector('[data-action="commit"]') as HTMLButtonElement
    expect(commit.textContent).toContain('Commit All')
    expect(commit.disabled).toBe(true)
  })

  test('undo changes asks first, then discards', async () => {
    const client = fakeClient({ repos: [repo()], unversioned: [] })
    const el = await mount(client)
    const undo = el.querySelector('[data-git-row="src/app.ts"] button[aria-label="Undo changes"]') as HTMLButtonElement
    await act(async () => { undo.click() })
    await flush()
    expect(client.calls.some(([m]) => m === 'git.discard')).toBe(false)
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Undo changes to src/app.ts?')
    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent?.trim() === 'Undo changes') as HTMLButtonElement
    await act(async () => { confirm.click() })
    await flush()
    expect(client.calls.find(([m]) => m === 'git.discard')?.[1]).toEqual({ root: 'D:\\proj', paths: ['src/app.ts'] })
  })

  test('a merge in progress shows the conflicts, blocks the commit and offers Continue/Abort', async () => {
    const files = [{ path: 'src/app.ts', repoPath: 'src/app.ts', code: 'UU', staged: false, untracked: false }]
    const client = fakeClient({ repos: [repo({ files, operation: 'merge' })], unversioned: [] })
    const el = await mount(client)
    expect(el.textContent).toContain('Merge in progress')
    expect(el.querySelector('[data-git-row="src/app.ts"]')?.getAttribute('data-section')).toBe('conflict')
    expect((el.querySelector('[data-action="continue"]') as HTMLButtonElement).disabled).toBe(true)
    expect((el.querySelector('[data-action="commit"]') as HTMLButtonElement).disabled).toBe(true)
    const abort = el.querySelector('[data-action="abort"]') as HTMLButtonElement
    await act(async () => { abort.click() })
    await flush()
    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent?.trim() === 'Abort') as HTMLButtonElement
    await act(async () => { confirm.click() })
    await flush()
    expect(client.calls.find(([m]) => m === 'git.operation')?.[1]).toEqual({ root: 'D:\\proj', action: 'abort' })
  })

  test('a push refused as behind opens the Pull then Push question', async () => {
    const client = fakeClient({ repos: [repo()], unversioned: [] }, {
      'git.push': () => ({ ok: false, problem: 'rejected', behindRemote: true }),
      'git.pull': () => ({ ok: true }),
    })
    const el = await mount(client)
    const push = el.querySelector('button[aria-label="Push"]') as HTMLButtonElement
    await act(async () => { push.click() })
    await flush()
    expect(document.querySelector('[data-dialog="push-behind"]')).not.toBeNull()
    const go = document.querySelector('[data-action="pull-then-push"]') as HTMLButtonElement
    await act(async () => { go.click() })
    await flush()
    const order = client.calls.map(([m]) => m).filter((m) => m === 'git.pull' || m === 'git.push')
    expect(order).toEqual(['git.push', 'git.pull', 'git.push'])
  })

  test('a folder under no version control offers to create a repository', async () => {
    const client = fakeClient({ repos: [], unversioned: [{ mount: 'proj' }] })
    const el = await mount(client)
    expect(el.textContent).toContain('Not under version control')
    const create = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Create Git repository')) as HTMLButtonElement
    await act(async () => { create.click() })
    await flush()
    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent?.trim() === 'Create repository') as HTMLButtonElement
    await act(async () => { confirm.click() })
    await flush()
    expect(client.calls.find(([m]) => m === 'git.init')?.[1]).toEqual({ mount: 'proj' })
  })

  test('the branch picker lists refs and checks one out', async () => {
    const client = fakeClient({ repos: [repo()], unversioned: [] }, {
      'git.refs': () => ({
        local: [{ name: 'main', sha: 'a', short: 'a', subject: '', date: '', current: true }, { name: 'feature', sha: 'b', short: 'b', subject: '', date: '', current: false }],
        remote: [{ name: 'origin/main', sha: 'a', short: 'a', subject: '', date: '', current: false, remote: 'origin' }],
        tags: [],
      }),
    })
    const el = await mount(client)
    const picker = el.querySelector('[data-action="branch-picker"]') as HTMLButtonElement
    await act(async () => { picker.click() })
    await flush()
    await flush()
    const feature = document.querySelector('[data-branch="feature"]') as HTMLButtonElement
    expect(feature).not.toBeNull()
    await act(async () => { feature.click() })
    await flush()
    expect(client.calls.find(([m]) => m === 'git.switch')?.[1]).toEqual({ root: 'D:\\proj', name: 'feature' })
  })

  test('opening the repository window and a conflict file hands the view to the app', async () => {
    const files = [{ path: 'src/app.ts', repoPath: 'src/app.ts', code: 'UU', staged: false, untracked: false }]
    const client = fakeClient({ repos: [repo({ files, operation: 'merge' })], unversioned: [] })
    const views: GitView[] = []
    const el = await mount(client, { onOpenView: (v) => views.push(v) })
    await act(async () => { (el.querySelector('[data-action="open-repository"]') as HTMLButtonElement).click() })
    await act(async () => { (el.querySelector('[data-git-row="src/app.ts"] button[aria-label="Open merge editor"]') as HTMLButtonElement).click() })
    expect(views).toEqual([
      { kind: 'repo', root: 'D:\\proj', label: 'proj' },
      { kind: 'merge', root: 'D:\\proj', repoPath: 'src/app.ts', path: 'src/app.ts' },
    ])
  })
})
