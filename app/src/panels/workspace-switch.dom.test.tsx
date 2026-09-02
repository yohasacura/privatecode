// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { WorkspaceSwitch } from './workspace-switch'

/** The switcher (docs/UI-REDESIGN-2026-09.md §8): a recent is a button, the one that is
 * open and the one that is gone are not. */

let host: HTMLElement
let calls: { method: string; params: unknown }[]
let closed: number

function stubClient(): ProtocolClient {
  return {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'config.get') {
        return { recentWorkspaces: ['D:/open', 'D:/other', 'D:/gone'], missingWorkspaces: ['D:/gone'], serverUrl: 'http://127.0.0.1:1' }
      }
      if (method === 'init') {
        return {
          sessionId: 's2', mode: 'normal', gateMode: 'auto', contextLength: null, title: '', problems: [], items: [],
          workspaceName: 'other', folderCount: 1, contextUsed: { promptTokens: null, approxTokens: 0 },
        }
      }
      return {}
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); calls = []; closed = 0 })
afterEach(() => { render(null, host); host.remove(); document.body.innerHTML = '' })

describe('the switcher', () => {
  it('offers the recents, marks the open one and the missing one, and opens on a click', async () => {
    const switched = vi.fn()
    act(() => {
      render(
        <WorkspaceSwitch client={stubClient()} isDevBridge currentRoot="d:/open" onClose={() => { closed++ }} onSessionSwitched={switched} />,
        host,
      )
    })
    await settle()
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[data-recent]')]
    expect(rows.map((r) => r.dataset['recent'])).toEqual(['D:/open', 'D:/other', 'D:/gone'])
    expect(rows[0]?.disabled).toBe(true)
    expect(rows[0]?.textContent).toContain('current')
    expect(rows[2]?.disabled).toBe(true)
    expect(rows[2]?.textContent).toContain('missing')
    act(() => rows[1]!.click())
    await settle()
    expect(calls.find((c) => c.method === 'init')?.params).toMatchObject({ workspaceRoot: 'D:/other' })
    expect(switched).toHaveBeenCalledOnce()
    expect(switched.mock.calls[0]?.[0]).toMatchObject({ workspaceRoot: 'D:/other', workspaceName: 'other' })
  })

  it('is a modal that Escape closes without the key travelling on', () => {
    act(() => {
      render(
        <WorkspaceSwitch client={stubClient()} isDevBridge={false} currentRoot="" onClose={() => { closed++ }} onSessionSwitched={() => {}} />,
        host,
      )
    })
    let travelled = 0
    const bubble = (): void => { travelled++ }
    window.addEventListener('keydown', bubble)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    window.removeEventListener('keydown', bubble)
    expect(closed).toBe(1)
    expect(travelled).toBe(0)
  })
})
