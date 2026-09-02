// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { SettingsModal, type SettingsTab } from './status'

/** Settings (docs/UI-REDESIGN-2026-09.md §8): a dialog with a tab list on the left, and the
 * Appearance and Server tabs' controls wired to what App owns. */

let host: HTMLElement

function stubClient(): ProtocolClient {
  return {
    call: vi.fn(async (method: string) => {
      switch (method) {
        case 'config.get': return { recentWorkspaces: ['D:/ws'], serverUrl: 'http://127.0.0.1:8080' }
        case 'server.probe': return { reachable: true, model: 'KAT-Coder', contextLength: 196_608 }
        case 'permissions.list': return { layers: [], mode: 'normal', problems: [] }
        case 'skills.list': return { skills: [], problems: [], dirs: [] }
        case 'plugins.list': return { plugins: [], marketplaces: [], suggested: [], declared: [], problems: [], store: 'D:/appdata/PrivateCode/plugins' }
        case 'status': return {}
        case 'mcp.rawRead': return { json: '{}', path: 'D:/ws/.privatecode/settings.json' }
        default: return {}
      }
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}

const handlers = {
  theme: vi.fn(), motion: vi.fn(), ligatures: vi.fn(), updates: vi.fn(), close: vi.fn(),
}

function draw(initialTab: SettingsTab = 'server'): void {
  act(() => {
    render(
      <SettingsModal
        client={stubClient()}
        themeSetting="system"
        onThemeChange={handlers.theme}
        motionSetting="system"
        onMotionChange={handlers.motion}
        ligatures
        onLigaturesChange={handlers.ligatures}
        initialTab={initialTab}
        version="0.3.2"
        onCheckForUpdates={handlers.updates}
        onClose={handlers.close}
        onSessionSwitched={() => {}}
      />,
      host,
    )
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
}

beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); vi.clearAllMocks() })
afterEach(() => { render(null, host); host.remove(); document.body.innerHTML = '' })

describe('the dialog', () => {
  it('is a modal with eight sections in a vertical tab list, opening on the one asked for', () => {
    draw('appearance')
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')!
    expect(dialog).not.toBeNull()
    const list = dialog.querySelector('[role="tablist"]')!
    expect(list.getAttribute('aria-orientation')).toBe('vertical')
    expect([...list.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim()))
      .toEqual(['Server', 'Appearance', 'Permissions', 'Skills', 'Plugins', 'MCP servers', 'Data', 'About'])
    expect(dialog.querySelector('[data-settings-pane]')?.getAttribute('data-settings-pane')).toBe('appearance')
  })

  it('Escape closes it', () => {
    draw()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(handlers.close).toHaveBeenCalledOnce()
  })
})

describe('appearance', () => {
  it('hands each choice back to the owner of the setting', () => {
    draw('appearance')
    const pane = document.querySelector('[data-appearance]')!
    const radios = [...pane.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    act(() => radios.find((r) => r.textContent === 'Light')!.click())
    expect(handlers.theme).toHaveBeenCalledWith('light')
    act(() => radios.find((r) => r.textContent === 'Reduce')!.click())
    expect(handlers.motion).toHaveBeenCalledWith('reduce')
    act(() => pane.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    expect(handlers.ligatures).toHaveBeenCalledWith(false)
    // Compact density is promised, not offered.
    expect(radios.find((r) => r.textContent === 'Compact')?.disabled).toBe(true)
  })
})

describe('server', () => {
  it('probes the URL and says what answered', async () => {
    draw('server')
    // The probe waits for the typing to stop before it asks (400 ms).
    await act(async () => { await new Promise((r) => setTimeout(r, 500)) })
    await settle()
    expect(document.querySelector('[data-probe]')?.getAttribute('data-probe')).toBe('ok')
    expect(document.querySelector('[data-probe]')?.textContent).toContain('KAT-Coder')
    // The thousands separator is the locale's; the digits are not.
    expect(document.querySelector('[data-probe]')?.textContent).toMatch(/196.608 tokens of context/)
  })
})

describe('about', () => {
  it('names the version and offers the update check', () => {
    draw('about')
    const pane = document.querySelector('[data-about]')!
    expect(pane.textContent).toContain('Version 0.3.2')
    act(() => pane.querySelector<HTMLButtonElement>('[data-action="check-updates"]')!.click())
    expect(handlers.updates).toHaveBeenCalledOnce()
  })
})
