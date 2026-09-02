// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { Palette, type PaletteAction, type PaletteContext } from './palette'

/** The palette (docs/UI-REDESIGN-2026-09.md §8): what it lists, what it refuses and why. */

let host: HTMLElement
let picked: PaletteAction[]
let closed: number

function stubClient(): ProtocolClient {
  return {
    call: vi.fn(async (method: string) => {
      if (method === 'fs.find') return { entries: [{ path: 'src/a.ts', dir: false }, { path: 'src', dir: true }] }
      if (method === 'sessions.list') return { sessions: [{ id: 's1', title: 'Rename the thing', updatedAt: '' }] }
      if (method === 'sessions.search') return { hits: [] }
      return {}
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}

function draw(context: PaletteContext): void {
  act(() => {
    render(
      <Palette client={stubClient()} context={context} onClose={() => { closed++ }} onPick={(a) => picked.push(a)} />,
      host,
    )
  })
}

function type(text: string): void {
  act(() => {
    const el = document.querySelector<HTMLInputElement>('[data-palette] input')!
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); picked = []; closed = 0 })
afterEach(() => { render(null, host); host.remove(); document.body.innerHTML = '' })

describe('what it lists', () => {
  it('groups sessions, files, actions and settings, and opens files only', async () => {
    draw({ turnRunning: false, hasConversation: true })
    await settle()
    const groups = [...document.querySelectorAll('[data-palette] [role="group"]')].map((g) => g.getAttribute('aria-label'))
    expect(groups).toEqual(['Sessions', 'Files', 'Do', 'Settings'])
    const files = [...document.querySelectorAll('[data-palette] [role="group"][aria-label="Files"] [role="option"]')]
    expect(files.map((f) => f.textContent)).toEqual(['src/a.ts'])
  })

  it('a setting can be opened by name', async () => {
    draw({ turnRunning: false, hasConversation: true })
    type('appear')
    await settle()
    const entry = [...document.querySelectorAll<HTMLButtonElement>('[data-palette] [role="option"]')]
      .find((o) => o.textContent?.includes('Settings › Appearance'))!
    act(() => entry.click())
    expect(picked).toEqual([{ kind: 'settings', tab: 'appearance' }])
    expect(closed).toBe(1)
  })
})

describe('what it refuses', () => {
  it('lists a command that cannot run now, disabled, with the reason', async () => {
    draw({ turnRunning: true, hasConversation: false })
    await settle()
    const options = [...document.querySelectorAll<HTMLButtonElement>('[data-palette] [role="option"]')]
    const fresh = options.find((o) => o.textContent?.startsWith('New session'))!
    expect(fresh.hasAttribute('data-disabled')).toBe(true)
    expect(fresh.textContent).toContain('a turn is running')
    const copy = options.find((o) => o.textContent?.startsWith('Copy conversation'))!
    expect(copy.textContent).toContain('nothing has been said yet')
    act(() => fresh.click())
    expect(picked).toEqual([])
    expect(closed).toBe(0)
  })

  it('Escape closes it — unless a dialog is open above it', () => {
    draw({ turnRunning: false, hasConversation: true })
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    document.body.appendChild(modal)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(closed).toBe(0)
    modal.remove()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(closed).toBe(1)
  })
})
