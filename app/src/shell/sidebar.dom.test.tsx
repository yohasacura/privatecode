// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { Sidebar } from './sidebar'

/**
 * The sidebar against a fake host: the day groups, the filter, the delete that asks first,
 * the list that cannot be loaded, and the adoption of a replacement session.
 */

let host: HTMLDivElement
afterEach(() => { render(null, host); host.remove() })

const today = new Date()
const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
const SESSIONS = [
  { id: 's1', title: 'Add a SavedAt property', createdAt: today.toISOString(), updatedAt: today.toISOString(), workspaceRoot: 'D:\\x', mode: 'normal' as const },
  { id: 's2', title: 'Explain the planner', createdAt: yesterday.toISOString(), updatedAt: yesterday.toISOString(), workspaceRoot: 'D:\\x', mode: 'plan' as const },
]

function fakeClient(handlers: Partial<Record<string, (params: unknown) => unknown>>): ProtocolClient {
  return {
    call: vi.fn(async (method: string, params: unknown) => {
      const h = handlers[method]
      if (h === undefined) throw new Error(`unexpected ${method}`)
      return h(params)
    }),
  } as unknown as ProtocolClient
}

const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

async function mount(client: ProtocolClient, extra: Partial<Parameters<typeof Sidebar>[0]> = {}): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    render(
      <Sidebar
        client={client}
        activeSessionId="s1"
        viewingSessionId={null}
        turnRunning={false}
        onSessionSwitched={() => {}}
        onView={() => {}}
        onOpenSettings={() => {}}
        reloadKey={0}
        {...extra}
      />,
      host,
    )
  })
  await flush()
  return host
}

describe('the sidebar', () => {
  test('lists sessions under their day, the active one marked', async () => {
    const el = await mount(fakeClient({ 'sessions.list': () => ({ sessions: SESSIONS }) }))
    const headings = [...el.querySelectorAll('h3')].map((h) => h.textContent)
    expect(headings).toEqual(['Today', 'Yesterday'])
    const active = el.querySelector('[aria-current="true"]')!
    expect(active.textContent).toContain('Add a SavedAt property')
    expect(active.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('the active session')
    expect(el.textContent).toContain('plan')
  })

  test('the filter narrows the list and says when nothing matches', async () => {
    const el = await mount(fakeClient({ 'sessions.list': () => ({ sessions: SESSIONS }) }))
    act(() => { el.querySelector<HTMLButtonElement>('[aria-label="Search sessions"]')!.click() })
    const input = el.querySelector<HTMLInputElement>('[aria-label="Filter sessions"]')!
    act(() => { input.value = 'planner'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect([...el.querySelectorAll('li')].map((li) => li.textContent)).toHaveLength(1)
    act(() => { input.value = 'zzz'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(el.textContent).toContain('No sessions match.')
  })

  test('deleting asks first, then removes, and adopts the replacement the host hands back', async () => {
    const onSessionSwitched = vi.fn()
    let list = SESSIONS
    const client = fakeClient({
      'sessions.list': () => ({ sessions: list }),
      'sessions.delete': (p) => {
        list = list.filter((s) => s.id !== (p as { id: string }).id)
        return {
          problems: [],
          replacedBy: { sessionId: 'fresh', mode: 'normal', gateMode: 'auto', contextLength: null, title: '', problems: [], items: [], contextUsed: { promptTokens: null, approxTokens: 0 } },
        }
      },
    })
    const el = await mount(client, { onSessionSwitched })
    const menu = el.querySelector<HTMLButtonElement>('[aria-label="Actions for Add a SavedAt property"]')!
    act(() => { menu.click() })
    const item = document.querySelector<HTMLElement>('[role="menuitem"]')!
    act(() => { item.click() })
    expect(el.textContent).toContain('This is the session you are in.')
    const del = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!
    await act(async () => { del.click(); await Promise.resolve(); await Promise.resolve() })
    await flush()
    expect(onSessionSwitched).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'fresh' }))
    expect(el.textContent).not.toContain('Add a SavedAt property')
  })

  test('a list that cannot be loaded is an error with a Retry, and the rest of the panel works', async () => {
    let fail = true
    const client = fakeClient({
      'sessions.list': () => { if (fail) throw new Error('store unreadable'); return { sessions: SESSIONS } },
    })
    const el = await mount(client)
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('store unreadable')
    fail = false
    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
    await act(async () => { retry.click(); await Promise.resolve(); await Promise.resolve() })
    await flush()
    expect(el.querySelector('[role="alert"]')).toBeNull()
    expect(el.textContent).toContain('Explain the planner')
  })
})
