// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { Skills } from './skills'

/**
 * Settings → Skills, now that it makes and edits things: a skill or agent from a template,
 * SKILL.md and the files beside it in the window's editor, the folder for the rest. The
 * bundled and plugin skills are shown and not edited.
 */

let host: HTMLElement
let calls: Array<{ method: string; params: Record<string, unknown> }>
let files: Record<string, string>
let created: { skills: Array<Record<string, unknown>>; agents: Array<Record<string, unknown>> }

function stubClient(): ProtocolClient {
  return {
    call: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      switch (method) {
        case 'skills.list': return {
          skills: [
            { name: 'deck', scope: 'project', description: 'Builds decks', path: 'D:\\ws\\.privatecode\\skills\\deck\\SKILL.md', files: ['build.ps1'] },
            { name: 'pptx', scope: 'bundled', description: 'Ships with the app', path: 'C:\\app\\sidecar\\skills\\pptx\\SKILL.md', files: ['pptx.cjs'] },
            { name: 'greet', scope: 'plugin', plugin: 'alpha@fixture', description: 'From a plugin', path: 'D:\\store\\alpha\\skills\\greet\\SKILL.md', files: [] },
            ...created.skills,
          ],
          problems: [],
          dirs: [{ scope: 'project', path: 'D:\\ws\\.privatecode\\skills' }, { scope: 'user', path: 'C:\\Users\\me\\AppData\\Roaming\\PrivateCode\\skills' }],
        }
        case 'agents.list': return {
          agents: [
            { name: 'reviewer', scope: 'project', purpose: 'Reviews diffs', path: 'D:\\ws\\.privatecode\\agents\\reviewer.md' },
            { name: 'alpha:helper', scope: 'plugin', plugin: 'alpha', purpose: 'From a plugin' },
            ...created.agents,
          ],
          problems: [],
          dirs: [{ scope: 'project', path: 'D:\\ws\\.privatecode\\agents' }, { scope: 'user', path: 'C:\\Users\\me\\AppData\\Roaming\\PrivateCode\\agents' }],
        }
        case 'skills.create': {
          // What the host does: the file from the template, and the next list shows it.
          const name = params['name'] as string
          const path = `D:\\ws\\.privatecode\\skills\\${name}\\SKILL.md`
          files[path] = '---\ndescription: new\n---\nTemplate.'
          created.skills.push({ name, scope: params['scope'] as string, description: 'new', path, files: [] })
          return { path }
        }
        case 'agents.create': {
          const name = params['name'] as string
          const path = `D:\\ws\\.privatecode\\agents\\${name}.md`
          files[path] = '---\ndescription: new agent\n---\nBrief.'
          created.agents.push({ name, scope: params['scope'] as string, purpose: 'new agent', path })
          return { path }
        }
        case 'fs.read': {
          const body = files[params['path'] as string] ?? 'missing'
          return { lines: body.split('\n'), truncated: false }
        }
        case 'fs.write': {
          files[params['path'] as string] = params['text'] as string
          return { path: params['path'], bytes: (params['text'] as string).length }
        }
        case 'fs.openExternal': return { opened: params['path'] }
        case 'memory.list': return { layers: [{ scope: 'project', path: 'D:\\ws\\AGENTS.md', bytes: 120, truncated: false }] }
        default: return {}
      }
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

function byAction(action: string, within: ParentNode = document): HTMLElement[] {
  return [...within.querySelectorAll<HTMLElement>(`[data-action="${action}"]`)]
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  calls = []
  created = { skills: [], agents: [] }
  files = { 'D:\\ws\\.privatecode\\skills\\deck\\SKILL.md': '---\ndescription: Builds decks\n---\nSteps.', 'D:\\ws\\.privatecode\\skills\\deck\\build.ps1': 'Write-Output deck' }
  act(() => { render(<Skills client={stubClient()} />, host) })
})
afterEach(() => { render(null, host); host.remove(); document.body.innerHTML = '' })

test('your own skills can be edited and opened; the bundled and plugin ones only opened', async () => {
  await settle()
  const rows = [...host.querySelectorAll('[data-skills] [role="button"], [data-skills] button')]
  expect(rows.length).toBeGreaterThan(0)
  // One Edit for `deck` (project); none for `pptx` (bundled) or `greet` (plugin).
  expect(byAction('skill-edit', host)).toHaveLength(1)
  expect(byAction('skill-folder', host)).toHaveLength(3)
  // Expanded, the bundled one says why it has no Edit.
  // Rows render in list order; the second toggle is pptx's.
  const toggles = host.querySelectorAll<HTMLElement>('[data-skills] [aria-expanded]')
  toggles[1]!.click()
  await settle()
  expect(host.textContent).toContain('rewritten on update')
})

test('New skill writes a template and opens it in the editor', async () => {
  await settle()
  byAction('skill-new', host)[0]!.click()
  await settle()
  const name = host.querySelector<HTMLInputElement>('[data-create="skill"] input')!
  name.value = 'notes'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  byAction('skill-create', host)[0]!.click()
  await settle()
  expect(calls.find((c) => c.method === 'skills.create')?.params).toEqual({ name: 'notes', scope: 'project' })
  const editor = host.querySelector('[data-file-editor]')
  expect(editor?.getAttribute('data-path')).toBe('D:\\ws\\.privatecode\\skills\\notes\\SKILL.md')
  expect(editor?.querySelector('textarea')?.value).toContain('Template.')
})

test('editing a skill file saves it whole through fs.write', async () => {
  await settle()
  // Expand `deck`, edit the script beside it.
  host.querySelectorAll<HTMLElement>('[data-skills] [aria-expanded]')[0]!.click()
  await settle()
  const script = byAction('skill-file-edit', host).find((b) => b.textContent === 'build.ps1')!
  script.click()
  await settle()
  const textarea = host.querySelector<HTMLTextAreaElement>('[data-file-editor] textarea')!
  expect(textarea.value).toBe('Write-Output deck')
  textarea.value = 'Write-Output "deck v2"'
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  byAction('editor-save', host)[0]!.click()
  await settle()
  const write = calls.find((c) => c.method === 'fs.write')
  expect(write?.params).toEqual({ path: 'D:\\ws\\.privatecode\\skills\\deck\\build.ps1', text: 'Write-Output "deck v2"' })
  expect(host.querySelector('[data-editor-status]')?.textContent).toContain('saved')
})

test('agents are listed with their scope, and yours can be edited', async () => {
  await settle()
  expect(host.textContent).toContain('reviewer')
  expect(host.textContent).toContain('alpha:helper')
  expect(byAction('agent-edit', host)).toHaveLength(1)
  // And the memory a session loads — the console's /memory — with an Edit of its own.
  expect(host.textContent).toContain('AGENTS.md')
  expect(byAction('memory-edit', host)).toHaveLength(1)
  byAction('agent-new', host)[0]!.click()
  await settle()
  const name = host.querySelector<HTMLInputElement>('[data-create="agent"] input')!
  name.value = 'tester'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  byAction('agent-create', host)[0]!.click()
  await settle()
  expect(calls.find((c) => c.method === 'agents.create')?.params).toEqual({ name: 'tester', scope: 'project' })
  expect(host.querySelector('[data-file-editor]')?.getAttribute('data-path')).toBe('D:\\ws\\.privatecode\\agents\\tester.md')
})
