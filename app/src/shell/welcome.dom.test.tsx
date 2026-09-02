// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { AgentDown } from './agent-down'
import { Welcome, type WelcomeProps } from './welcome'

/**
 * The first screen's states, each driven by the props and by a fake host answering
 * `server.probe`: a folder that is gone, a server that is not there, a server that is,
 * and the Open button that follows all of it.
 */

let host: HTMLDivElement
afterEach(() => { render(null, host); host.remove(); vi.useRealTimers() })

function fakeClient(probe: (url: string) => Promise<{ reachable: boolean; model?: string; contextLength?: number; reason?: string }>): ProtocolClient {
  return {
    call: vi.fn(async (method: string, params: unknown) => {
      if (method === 'server.probe') return probe((params as { serverUrl: string }).serverUrl)
      throw new Error(`unexpected ${method}`)
    }),
  } as unknown as ProtocolClient
}

function mount(overrides: Partial<WelcomeProps> = {}): { el: HTMLDivElement; props: WelcomeProps } {
  host = document.createElement('div')
  document.body.appendChild(host)
  const props: WelcomeProps = {
    client: fakeClient(async () => ({ reachable: true, model: 'KAT-Coder', contextLength: 196_608 })),
    phase: { kind: 'welcome', error: null },
    isDevBridge: true,
    version: '0.3.2',
    recents: ['D:\\Projects\\black-port', 'D:\\Old\\gone'],
    missing: ['D:\\Old\\gone'],
    workspace: '',
    onWorkspaceChange: vi.fn(),
    server: 'http://127.0.0.1:8080',
    onServerChange: vi.fn(),
    onBrowse: vi.fn(),
    onForget: vi.fn(),
    onOpen: vi.fn(),
    ...overrides,
  }
  act(() => { render(<Welcome {...props} />, host) })
  return { el: host, props }
}

const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

describe('the welcome screen', () => {
  test('while booting, says so and asks for nothing', () => {
    const { el } = mount({ phase: { kind: 'boot' } })
    expect(el.textContent).toContain('starting the agent')
    expect(el.querySelector('#ws-input')).toBeNull()
  })

  test('a recent folder that is gone says so on its row and can be forgotten', () => {
    const { el, props } = mount()
    const gone = [...el.querySelectorAll('li')].find((li) => li.textContent?.includes('gone'))!
    expect(gone.textContent).toContain('not found')
    act(() => { gone.querySelector<HTMLButtonElement>('[aria-label^="Forget"]')!.click() })
    expect(props.onForget).toHaveBeenCalledWith('D:\\Old\\gone')
  })

  test('choosing a missing folder marks the field and keeps Open disabled', async () => {
    vi.useFakeTimers()
    const { el } = mount({ workspace: 'D:\\Old\\gone' })
    expect(el.querySelector<HTMLInputElement>('#ws-input')!.getAttribute('aria-invalid')).toBe('true')
    expect(el.textContent).toContain('no longer exists')
    await act(async () => { vi.advanceTimersByTime(500); await Promise.resolve() })
    await flush()
    const open = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Open workspace')!
    expect(open.disabled).toBe(true)
  })

  test('the server is probed after a pause, and a reachable one enables Open with what it serves', async () => {
    vi.useFakeTimers()
    const { el, props } = mount({ workspace: 'D:\\Projects\\black-port' })
    expect(el.textContent).toContain('checking')
    await act(async () => { vi.advanceTimersByTime(500); await Promise.resolve() })
    await flush()
    expect(el.textContent).toContain('reachable — KAT-Coder, 196.6k token context')
    const open = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Open workspace')!
    expect(open.disabled).toBe(false)
    act(() => { open.click() })
    expect(props.onOpen).toHaveBeenCalledWith('D:\\Projects\\black-port', 'http://127.0.0.1:8080')
  })

  test('an unreachable server says why, in red, and Open stays disabled', async () => {
    vi.useFakeTimers()
    const { el } = mount({
      workspace: 'D:\\Projects\\black-port',
      client: fakeClient(async () => ({ reachable: false, reason: 'nothing is listening at 127.0.0.1:8080' })),
    })
    await act(async () => { vi.advanceTimersByTime(500); await Promise.resolve() })
    await flush()
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('nothing is listening at 127.0.0.1:8080')
    expect(el.querySelector<HTMLInputElement>('#srv-input')!.getAttribute('aria-invalid')).toBe('true')
    const open = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Open workspace')!
    expect(open.disabled).toBe(true)
  })

  test('a failed open is shown as an alert above the fields', () => {
    const { el } = mount({ phase: { kind: 'welcome', error: 'workspace directory not found' } })
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('workspace directory not found')
  })
})

describe('the agent-down screen', () => {
  test('shows the reason and what the agent printed, and the dev bridge gets words rather than a button', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    act(() => { render(<AgentDown reason="the agent process exited with code 1" stderr={['boom', 'at x']} isDevBridge />, host) })
    expect(host.textContent).toContain('the agent process exited with code 1')
    expect(host.querySelector('pre')?.textContent).toContain('boom')
    expect(host.textContent).toContain('npm run host:dev')
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Restart'))).toBe(false)
  })

  test('outside the bridge there is a Restart button', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    act(() => { render(<AgentDown reason="it was killed" stderr={[]} isDevBridge={false} />, host) })
    expect(host.textContent).toContain('left no output')
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Restart the agent'))).toBe(true)
  })
})
