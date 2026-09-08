// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { GitRepoView, GitStatusResult } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import type { GitView } from '../lib/git-views'
import { GIT_REPO_EVENT, SHOW_GIT_EVENT, gitTabMemory } from '../lib/git-views'
import { GitTab, forgetGitTabState, repoOptionLabel } from './git-tab'

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
afterEach(() => { if (host) { render(null, host); host.remove(); host = null }; forgetGitTabState() })

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

const rightClick = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40, button: 2 })) })
  await flush()
}
const menuLabels = (): string[] => [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim() ?? '')
const pick = async (label: string): Promise<void> => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.trim() === label) as HTMLElement | undefined
  expect(item, label).toBeDefined()
  await act(async () => { item!.click() })
  await flush()
}
const escape = async (): Promise<void> => {
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
}

describe('the right-click', () => {
  test('a file row opens the same actions the … button has; the Changes header opens the list\'s', async () => {
    const client = fakeClient({ repos: [repo()], unversioned: [] })
    const el = await mount(client)
    await rightClick(el.querySelector('[data-git-row="src/app.ts"]')!)
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('File actions')
    expect(menuLabels()).toEqual(expect.arrayContaining(['Open file', 'View diff', 'Stage', 'Undo Changes…', 'View history', 'Blame (annotate)', 'Copy path']))
    await pick('Stage')
    expect(client.calls.find(([m]) => m === 'git.stagePaths')?.[1]).toEqual({ root: 'D:\\proj', paths: ['src/app.ts'] })

    await rightClick(el.querySelector('[data-section-title="Changes"]')!)
    expect(menuLabels()).toEqual(expect.arrayContaining(['Stage all', 'Undo all changes…', 'Commit All', 'Stash All…']))
    await pick('Stage all')
    expect(client.calls.filter(([m]) => m === 'git.stagePaths').pop()?.[1]).toEqual({ root: 'D:\\proj', paths: ['src/app.ts', 'src/new.ts'] })

    // The header carries the network buttons and the … menu.
    await rightClick(el.querySelector('[data-action="branch-picker"]')!.parentElement!.parentElement!)
    expect(menuLabels()).toEqual(expect.arrayContaining(['Fetch', 'Pull', 'Push', 'Sync', 'Open Git Repository', 'New Branch…']))
    await escape()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})

const LIB: GitRepoView = {
  root: 'D:\\lib', label: 'lib', branch: 'dev', relation: 'nested', suggestion: '', stashes: 0, operation: 'merge',
  head: { ...HEAD, branch: 'dev', upstream: null, ahead: 0, behind: 0 },
  files: [{ path: 'lib/core.ts', repoPath: 'core.ts', code: 'UU', staged: false, untracked: false }],
}

describe('several repositories', () => {
  test('the picker names each with its state; switching re-addresses every call and tells the status bar', async () => {
    const client = fakeClient({ repos: [repo(), LIB], unversioned: [] })
    const told: string[] = []
    const listen = (e: Event): void => { told.push((e as CustomEvent<{ root: string }>).detail.root) }
    window.addEventListener(GIT_REPO_EVENT, listen)
    try {
      const el = await mount(client)
      const picker = el.querySelector('[data-repo-picker]') as HTMLSelectElement
      expect([...picker.options].map((o) => o.textContent)).toEqual(['proj · main · 3 changes', 'lib · dev · 1 change · Merge in progress'])
      expect(repoOptionLabel(LIB)).toBe('lib · dev · 1 change · Merge in progress')
      expect(told).toEqual(['D:\\proj'])

      await act(async () => { picker.value = 'D:\\lib'; picker.dispatchEvent(new Event('change', { bubbles: true })) })
      await flush()
      expect(told).toEqual(['D:\\proj', 'D:\\lib'])
      expect(el.querySelector('[data-action="branch-picker"]')?.textContent).toContain('dev')
      expect(el.textContent).toContain('Merge in progress')
      const rows = [...el.querySelectorAll('[data-git-row]')].map((r) => `${r.getAttribute('data-section')}:${r.getAttribute('data-git-row')}`)
      expect(rows).toEqual(['conflict:lib/core.ts'])
      // Keep Current on the conflict goes to lib, with git's spelling of the path.
      await rightClick(el.querySelector('[data-git-row="lib/core.ts"]')!)
      await pick('Keep Current (ours)')
      expect(client.calls.find(([m]) => m === 'git.keepSide')?.[1]).toEqual({ root: 'D:\\lib', path: 'core.ts', side: 'ours' })
    } finally {
      window.removeEventListener(GIT_REPO_EVENT, listen)
    }
  })

  test('the chosen repository and each one\'s unsent message survive a remount; "show Git" can name the repository', async () => {
    const client = fakeClient({ repos: [repo(), LIB], unversioned: [] })
    let el = await mount(client)
    const type = async (text: string): Promise<void> => {
      const box = el.querySelector('textarea[aria-label="Commit message"]') as HTMLTextAreaElement
      await act(async () => { box.value = text; box.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    await type('for proj')
    const picker = (): HTMLSelectElement => el.querySelector('[data-repo-picker]') as HTMLSelectElement
    await act(async () => { picker().value = 'D:\\lib'; picker().dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    expect((el.querySelector('textarea[aria-label="Commit message"]') as HTMLTextAreaElement).value).toBe('')
    await type('for lib')
    expect(gitTabMemory.root).toBe('D:\\lib')

    // Away to another inspector tab and back: the tab unmounts and mounts again.
    render(null, host!)
    el = await mount(client)
    expect(picker().value).toBe('D:\\lib')
    expect((el.querySelector('textarea[aria-label="Commit message"]') as HTMLTextAreaElement).value).toBe('for lib')

    await act(async () => { window.dispatchEvent(new CustomEvent(SHOW_GIT_EVENT, { detail: { root: 'D:\\proj' } })) })
    await flush()
    expect(picker().value).toBe('D:\\proj')
    expect((el.querySelector('textarea[aria-label="Commit message"]') as HTMLTextAreaElement).value).toBe('for proj')
  })
})

describe('a bounded listing', () => {
  test('says how many files are not listed, where the flood lives, and offers the ignore line', async () => {
    const client = fakeClient({
      repos: [repo({ omitted: 18_350, hotspots: [{ dir: 'src/App/obj', count: 12_000, pattern: 'obj/', junk: true }, { dir: 'node_modules', count: 6_000, pattern: 'node_modules/', junk: true }, { dir: 'gen', count: 900, pattern: '/gen/', junk: false }] })],
      unversioned: [],
    }, { 'git.ignore': () => ({ ok: true }) })
    const el = await mount(client)
    const note = el.querySelector('[data-omitted]')!
    expect(note.getAttribute('data-omitted')).toBe('18350')
    expect(note.textContent).toContain('src/App/obj/')
    expect(note.textContent).toContain('node_modules/')
    // The person's own directory is named, never offered to ignore.
    expect(note.textContent).toContain('gen/')
    expect([...note.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Ignore').length).toBe(2)
    const ignore = [...note.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Ignore')!
    await act(async () => { ignore.click() })
    await flush()
    expect(client.calls.some(([m, p]) => m === 'git.ignore' && (p as { pattern: string }).pattern === 'obj/')).toBe(true)
  })

  test('a small repository carries no such note', async () => {
    const el = await mount(fakeClient({ repos: [repo()], unversioned: [] }))
    expect(el.querySelector('[data-omitted]')).toBeNull()
  })
})

describe('coming back to the tab', () => {
  test('draws the last known state at once and refreshes quietly, instead of "reading the repository…"', async () => {
    const client = fakeClient({ repos: [repo()], unversioned: [] })
    let el = await mount(client)
    expect(el.querySelector('[data-commit-box]')).not.toBeNull()

    // Away to another inspector tab and back — with a status that now takes forever.
    render(null, host!)
    const slow = fakeClient({ repos: [repo()], unversioned: [] })
    const original = slow.call
    ;(slow as { call: unknown }).call = vi.fn((method: string, params: unknown) => (method === 'git.status' ? new Promise(() => {}) : original(method as never, params as never)))
    el = await mount(slow)
    expect(el.textContent).not.toContain('reading the repository')
    expect(el.querySelector('[data-commit-box]')).not.toBeNull()
    expect(el.textContent).toContain('app.ts')
  })
})
