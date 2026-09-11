// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { WorkspaceTab } from './workspace-tab'

/**
 * The folder manager sends the whole list on every change, so what it knows is what gets
 * saved — and it once knew nothing: the tab starts empty, asks `workspace.get`, and an Add
 * pressed before the answer (or while the folder picker was open) saved the new folder
 * alone. A five-folder workspace came back as two.
 */

let host: HTMLElement
let calls: { method: string; params: unknown }[]
/** Releases the held `workspace.get`, so a test can act before and after the list arrives. */
let answer: (() => void) | null

const LOADED = {
  name: 'ws',
  folders: [
    { name: 'ws', root: 'D:/ws', access: 'write', primary: true, git: 'not a repository' },
    { name: 'api', root: 'D:/api', access: 'write', primary: false, git: 'not a repository' },
    {
      name: 'docs', root: 'E:/docs', access: 'read', primary: false, git: '',
      missing: 'Folder "docs" is no longer at E:/docs; it is not part of this workspace until you point it somewhere else.',
    },
  ],
  problems: [],
}

function stubClient(): ProtocolClient {
  return {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'workspace.get') {
        await new Promise<void>((r) => { answer = r })
        return LOADED
      }
      if (method === 'fs.tree') return { entries: [{ name: 'api', dir: true }, { name: 'ws', dir: true }] }
      if (method === 'git.status') return { repos: [], unversioned: [] }
      return {}
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}

function draw(): void {
  act(() => {
    render(
      <WorkspaceTab
        client={stubClient()}
        items={[]}
        changes={[]}
        onOpenFile={() => {}}
        onOpenView={() => {}}
        workspaceRoot="D:/ws"
        workspaceName="ws"
        folderCount={3}
        reloadKey={0}
        isDevBridge
        onReopenWorkspace={() => {}}
        onSwitchWorkspace={() => {}}
        onCloseWorkspace={() => {}}
        sessionKey="s1"
        reviewed={new Map()}
        onMarkReviewed={() => {}}
      />,
      host,
    )
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

async function drawLoaded(): Promise<void> {
  draw()
  await settle()
  act(() => { answer?.() })
  await settle()
}

const addButton = (): HTMLButtonElement => host.querySelector('[aria-label="Add a folder to the workspace"]') as HTMLButtonElement
const saved = (): unknown[] => calls.filter((c) => c.method === 'workspace.set').map((c) => c.params)

beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); calls = []; answer = null })
afterEach(() => { render(null, host); host.remove(); document.body.innerHTML = '' })

describe('the folder manager', () => {
  it('cannot add a folder until the list has loaded', async () => {
    draw()
    await settle()
    expect(addButton().disabled).toBe(true)
    expect(saved()).toEqual([])
    act(() => { answer?.() })
    await settle()
    expect(addButton().disabled).toBe(false)
  })

  it('an add sends every folder it knows — the one that is not mounted included — plus the new one', async () => {
    await drawLoaded()
    act(() => { addButton().click() })
    const input = host.querySelector('[data-add-folder]') as HTMLInputElement
    expect(input).not.toBeNull()
    act(() => { input.value = 'D:/new'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await settle()
    expect(saved()).toEqual([{
      name: 'ws',
      folders: [
        { path: 'D:/api', name: 'api', access: 'write' },
        { path: 'E:/docs', name: 'docs', access: 'read' },
        { path: 'D:/new', access: 'write' },
      ],
    }])
  })

  it('a folder that is not mounted is shown with its reason, and removing it drops only it', async () => {
    await drawLoaded()
    const row = host.querySelector('[data-missing-folder="docs"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.getAttribute('title')).toMatch(/no longer at/)
    expect(row.textContent).toContain('E:/docs')
    act(() => { (row.querySelector('button') as HTMLButtonElement).click() })
    await settle()
    expect(saved()).toEqual([{ name: 'ws', folders: [{ path: 'D:/api', name: 'api', access: 'write' }] }])
  })
})
