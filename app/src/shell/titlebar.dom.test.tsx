// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TitleBar } from './titlebar'

let host: HTMLDivElement
afterEach(() => { render(null, host); host.remove() })

function mount(overrides: Partial<Parameters<typeof TitleBar>[0]> = {}): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  act(() => {
    render(
      <TitleBar
        isDevBridge
        ready
        workspaceName="black-port"
        workspaceRoot="D:\\Projects\\black-port"
        folders={3}
        sessionTitle="Add a SavedAt property"
        connState="open"
        railShown
        railOpen
        onToggleRail={() => {}}
        contextShown
        contextOpen
        onToggleContext={() => {}}
        onSwitchWorkspace={() => {}}
        {...overrides}
      />,
      host,
    )
  })
  return host
}

describe('the title bar', () => {
  test('names the workspace with its extra folders, and the session', () => {
    const el = mount()
    expect(el.textContent).toContain('black-port')
    expect(el.textContent).toContain('+2')
    expect(el.textContent).toContain('Add a SavedAt property')
    expect(el.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('agent process: open')
  })

  test('has no window controls in the browser dev bridge', () => {
    const el = mount({ isDevBridge: true })
    expect(el.querySelector('[data-window-controls]')).toBeNull()
  })

  test('the panel toggles say what they do and refuse when the window has no room', () => {
    const onToggleRail = vi.fn()
    const el = mount({ onToggleRail, railShown: false, railOpen: true })
    const rail = el.querySelector<HTMLButtonElement>('[aria-label*="too narrow for the sessions"]')!
    expect(rail.disabled).toBe(true)
    const context = el.querySelector<HTMLButtonElement>('[aria-label="Workspace panel (Ctrl+J)"]')!
    expect(context.getAttribute('aria-pressed')).toBe('true')
    act(() => { rail.click() })
    expect(onToggleRail).not.toHaveBeenCalled()
  })

  test('the workspace button opens the switcher', () => {
    const onSwitchWorkspace = vi.fn()
    const el = mount({ onSwitchWorkspace })
    const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('black-port'))!
    act(() => { button.click() })
    expect(onSwitchWorkspace).toHaveBeenCalledTimes(1)
  })

  test('a closed connection is said in words', () => {
    const el = mount({ connState: 'closed', ready: false, sessionTitle: null })
    expect(el.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('agent process: closed')
    expect(el.textContent).not.toContain('black-port')
  })
})
