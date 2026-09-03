// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { Plugins } from './plugins'

/** Settings → Plugins (docs/PLUGINS-2026-09.md, phase D): every button is a `/plugin …` line. */

let host: HTMLElement
let commands: string[]

function stubClient(): ProtocolClient {
  return {
    call: vi.fn(async (method: string, params: Record<string, unknown>) => {
      switch (method) {
        case 'plugins.list': return {
          plugins: [{
            id: 'alpha@fixture', name: 'alpha', marketplace: 'fixture', version: '1.0.0', enabled: true, scopes: ['user'],
            installPath: 'D:/store/cache/fixture/alpha/1.0.0', description: 'The full plugin',
            skills: ['greet'], commands: ['hello'], agents: ['reviewer'], hooks: ['PreToolUse ×1'], mcpServers: ['memory'], problems: [], decidedBy: 'D:/user/settings.json',
          }],
          marketplaces: [{ name: 'fixture', source: 'D:/mkt', fetched: true, plugins: 3, bundled: false }],
          suggested: [{ name: 'superpowers-marketplace', source: 'obra/superpowers-marketplace', why: 'curated' }],
          declared: [{ id: 'ghost@fixture', from: 'D:/ws/.claude/settings.json' }],
          problems: ['gamma@fixture: something is off'],
          store: 'D:/store',
        }
        case 'plugins.catalog': return {
          entries: [
            { id: 'alpha@fixture', name: 'alpha', marketplace: 'fixture', description: 'The full plugin', version: '1.0.0', source: './alpha', keywords: [], installed: true, enabled: true },
            { id: 'beta@fixture', name: 'beta', marketplace: 'fixture', description: 'One skill', version: '0.1.0', category: 'docs', source: 'beta', keywords: ['skill'], installed: false, enabled: false },
          ],
          problems: [],
        }
        case 'plugins.command':
          commands.push(params['line'] as string)
          return { ok: true, text: `✔ ran ${params['line'] as string}`, changed: true }
        default: return {}
      }
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

function button(text: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (found === undefined) throw new Error(`no button "${text}"`)
  return found
}

function draw(): void {
  act(() => { render(<Plugins client={stubClient()} />, host) })
}

beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); commands = [] })
afterEach(() => { render(null, host); host.remove(); document.body.innerHTML = '' })

describe('Installed', () => {
  it('lists what is installed, what it adds, and turns a plugin off with the same command the composer takes', async () => {
    draw()
    await settle()
    const installed = document.querySelector('[data-plugins-installed]')!
    expect(installed.textContent).toContain('alpha@fixture')
    expect(installed.textContent).toContain('1.0.0')
    expect(installed.textContent).toContain('enabled')
    expect(installed.textContent).toContain('ghost@fixture is enabled but not installed')
    expect(document.querySelector('[data-plugins-problems]')?.textContent).toContain('gamma@fixture: something is off')
    act(() => { button('Disable', installed).click() })
    await settle()
    expect(commands).toEqual(['/plugin disable alpha@fixture'])
    expect(document.querySelector('[data-plugins-report]')?.textContent).toBe('✔ ran /plugin disable alpha@fixture')
    act(() => { button('Install ghost@fixture', installed).click() })
    await settle()
    expect(commands[commands.length - 1]).toBe('/plugin install ghost@fixture')
  })
})

describe('Discover', () => {
  it('shows the catalogs and installs with the chosen scope', async () => {
    draw()
    await settle()
    act(() => { button('Discover').click() })
    await settle()
    const discover = document.querySelector('[data-plugins-discover]')!
    expect(discover.textContent).toContain('beta@fixture')
    expect(discover.textContent).toContain('installed · enabled')
    act(() => { button('Project').click() })
    await settle()
    act(() => { button('Install', discover).click() })
    await settle()
    expect(commands).toEqual(['/plugin install beta@fixture --scope project'])
  })

  it('filters by the search box', async () => {
    draw()
    await settle()
    act(() => { button('Discover').click() })
    await settle()
    const search = document.querySelector<HTMLInputElement>('[data-plugins-search]')!
    act(() => {
      search.value = 'skill'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle()
    const discover = document.querySelector('[data-plugins-discover]')!
    expect(discover.textContent).toContain('beta@fixture')
    expect(discover.textContent).not.toContain('alpha@fixture')
  })
})

describe('Marketplaces', () => {
  it('adds a marketplace from the box, and a suggested one with a click', async () => {
    draw()
    await settle()
    act(() => { button('Marketplaces').click() })
    await settle()
    const pane = document.querySelector('[data-plugins-marketplaces]')!
    expect(pane.textContent).toContain('fixture')
    expect(pane.textContent).toContain('3 plugins')
    const box = pane.querySelector<HTMLInputElement>('[data-plugins-add-marketplace]')!
    act(() => {
      box.value = 'acme/tools'
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle()
    act(() => { button('Add marketplace', pane).click() })
    await settle()
    act(() => { button('Add', pane).click() })
    await settle()
    expect(commands).toEqual(['/plugin marketplace add acme/tools', '/plugin marketplace add obra/superpowers-marketplace'])
  })
})

describe('the console commands the tab did not have', () => {
  it('Reload plugins runs /reload-plugins, and Validate runs /plugin validate on the folder typed', async () => {
    draw()
    await settle()
    button('Reload plugins').click()
    await settle()
    expect(commands).toContain('/reload-plugins')
    ;([...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Marketplaces') as HTMLElement).click()
    await settle()
    const input = host.querySelector<HTMLInputElement>('[data-plugins-validate] input')!
    input.value = 'D:\work\my-plugin'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    button('Validate').click()
    await settle()
    expect(commands).toContain('/plugin validate D:\work\my-plugin')
  })
})
