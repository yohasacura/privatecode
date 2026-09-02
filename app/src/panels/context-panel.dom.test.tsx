// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import type { ChangeEntry } from './changes-tab'
import { ContextPanel } from './context-panel'

/** The inspector's three tabs (docs/UI-REDESIGN-2026-09.md §7): a real tablist, the panel
 * it controls, and the counts that let a tab you are not on say something happened. */

let host: HTMLElement

function stubClient(): ProtocolClient {
  return {
    call: vi.fn(async (method: string) => {
      switch (method) {
        case 'workspace.get': return { name: 'ws', folders: [], problems: [] }
        case 'git.status': return { repos: [], unversioned: [] }
        case 'fs.tree': return { entries: [] }
        case 'jobs.list': return { jobs: [] }
        case 'checkpoints.list': return { checkpoints: [] }
        case 'worklog.read': return { text: '' }
        default: return {}
      }
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}

const change: ChangeEntry = {
  id: 7, tool: 'edit_file', path: 'src/a.ts', ok: true, content: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n',
  revisions: 1, openPath: 'src/a.ts', restorePaths: ['src/a.ts'],
}

function draw(changes: ChangeEntry[] = []): void {
  act(() => {
    render(
      <ContextPanel
        client={stubClient()}
        items={[]}
        changes={changes}
        reloadKey={0}
        onOpenFile={() => {}}
        hasSession
        workspaceRoot="D:/ws"
        workspaceName="ws"
        folderCount={1}
        isDevBridge={false}
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

beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host) })
afterEach(() => { render(null, host); host.remove() })

describe('the inspector', () => {
  it('is one tablist with the workspace first and a panel that names its tab', async () => {
    draw()
    await settle()
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Workspace', 'History', 'Terminal'])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    const panel = host.querySelector('[role="tabpanel"]')!
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]?.id)
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(panel.id)
  })

  it('counts the session’s changes on the Workspace tab', async () => {
    draw([change])
    await settle()
    expect(host.querySelector('[role="tab"]')?.textContent).toContain('1')
  })

  it('switches panels on a click and keeps the terminal’s input where it is', async () => {
    draw()
    await settle()
    const terminal = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes('Terminal'))!
    act(() => terminal.click())
    await settle()
    expect(terminal.getAttribute('aria-selected')).toBe('true')
    expect(host.querySelector('[data-terminal-input]')).not.toBeNull()
    expect(host.querySelector('[data-panel="empty"]')?.textContent).toContain('Nothing has run yet')
  })
})
