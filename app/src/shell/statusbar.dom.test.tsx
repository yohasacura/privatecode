// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { GitRepoView } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { GIT_REPO_EVENT, SHOW_GIT_EVENT, gitTabMemory, type GitView } from '../lib/git-views'
import type { ChatState } from '../lib/state'
import { StatusBar } from './statusbar'

/**
 * The branch chip with several repositories in the workspace: it names the one it shows,
 * follows the Git tab, and its right-click lists them all.
 */

const HEAD = { branch: 'main', detached: false, unborn: false, oid: 'a1', upstream: 'origin/main', ahead: 1, behind: 0, upstreamGone: false }
const PROJ: GitRepoView = { root: 'D:\\proj', label: 'proj', branch: 'main', relation: 'folder', suggestion: '', head: HEAD, stashes: 0, operation: null, files: [{ path: 'a.ts', repoPath: 'a.ts', code: ' M', staged: false, untracked: false }] }
const LIB: GitRepoView = { root: 'D:\\lib', label: 'lib', branch: 'dev', relation: 'nested', suggestion: '', head: { ...HEAD, branch: 'dev', upstream: null, ahead: 0 }, stashes: 0, operation: 'rebase', files: [] }

function fakeClient(repos: GitRepoView[]): ProtocolClient {
  return {
    call: vi.fn(async (method: string) => {
      if (method === 'git.status') return { repos, unversioned: [] }
      if (method === 'status') return { serverUp: true, model: 'm', contextLength: 1000 }
      return {}
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}
const chatState = { turnRunning: false, session: null, items: [], lastStepDone: undefined, lastCompaction: undefined } as unknown as ChatState
const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve() }) }

let host: HTMLDivElement | null = null
afterEach(() => { if (host) { render(null, host); host.remove(); host = null }; gitTabMemory.root = null })

async function mount(repos: GitRepoView[], onOpenView?: (v: GitView) => void): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => { render(<StatusBar client={fakeClient(repos)} chatState={chatState} {...(onOpenView !== undefined ? { onOpenView } : {})} />, host!) })
  await flush()
  return host
}

describe('the branch chip', () => {
  test('with one repository: the branch alone; with several: the name too, and how many more', async () => {
    let el = await mount([PROJ])
    let chip = el.querySelector('[data-status="git"]')!
    expect(chip.textContent).toContain('main')
    expect(chip.querySelector('[data-git-label]')).toBeNull()
    render(null, host!)
    el = await mount([PROJ, LIB])
    chip = el.querySelector('[data-status="git"]')!
    expect(chip.querySelector('[data-git-label]')?.textContent).toBe('proj')
    expect(chip.textContent).toContain('+1')
    expect(chip.getAttribute('data-git-root')).toBe('D:\\proj')
  })

  test('follows the repository the Git tab shows', async () => {
    const el = await mount([PROJ, LIB])
    await act(async () => { window.dispatchEvent(new CustomEvent(GIT_REPO_EVENT, { detail: { root: 'D:\\lib' } })) })
    const chip = el.querySelector('[data-status="git"]')!
    expect(chip.getAttribute('data-git-root')).toBe('D:\\lib')
    expect(chip.textContent).toContain('dev')
    expect(chip.textContent).toContain('rebase')
  })

  test('a click shows the Git tab on its repository; the right-click lists every repository and opens the window', async () => {
    const shown: (string | null)[] = []
    const listen = (e: Event): void => { shown.push((e as CustomEvent<{ root?: string }>).detail?.root ?? null) }
    window.addEventListener(SHOW_GIT_EVENT, listen)
    const views: GitView[] = []
    try {
      const el = await mount([PROJ, LIB], (v) => views.push(v))
      const chip = el.querySelector('[data-status="git"]') as HTMLButtonElement
      await act(async () => { chip.click() })
      expect(shown).toEqual(['D:\\proj'])

      await act(async () => { chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 700, button: 2 })) })
      await flush()
      const labels = [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim())
      expect(labels).toEqual([
        'Open the Git tab',
        'Open the Git Repository window',
        'proj — main · ↑1 · 1 change',
        'lib — dev · Rebase in progress',
      ])
      const lib = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.includes('lib —')) as HTMLElement
      await act(async () => { lib.click() })
      await flush()
      expect(shown).toEqual(['D:\\proj', 'D:\\lib'])
      expect(gitTabMemory.root).toBe('D:\\lib')
      expect(el.querySelector('[data-status="git"]')?.getAttribute('data-git-root')).toBe('D:\\lib')

      await act(async () => { chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 700, button: 2 })) })
      await flush()
      const window_ = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.includes('Repository window')) as HTMLElement
      await act(async () => { window_.click() })
      expect(views).toEqual([{ kind: 'repo', root: 'D:\\lib', label: 'lib' }])
    } finally {
      window.removeEventListener(SHOW_GIT_EVENT, listen)
    }
  })
})
