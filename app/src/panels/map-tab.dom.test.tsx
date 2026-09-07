// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { MapNoteResult, MapProgress, MapStatus, MapTreeResult } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { MapTab } from './map-tab'

/**
 * The Map tab against a scripted host: the empty state and its Build, the tree and the
 * note with its links, a search, and the progress events a build sends.
 */

const STATUS: MapStatus = { exists: true, builtAt: '2026-09-08T10:00:00Z', files: 2, modules: 2, noted: 2, stale: 0, verified: 1, fidelity: 0.67, commits: 3, building: false, last: null, dir: 'D:\\proj\\.privatecode\\map' }
const TREE: MapTreeResult = { modules: [
  { path: '', noted: true, children: ['src'], files: [] },
  { path: 'src', noted: true, children: [], files: [{ path: 'src/orders.ts', noted: true, fidelity: 0.67 }, { path: 'src/money.ts', noted: false, stale: true, fidelity: null }, { path: 'src/new.ts', noted: false, fidelity: null }] },
] }
const NOTES: Record<string, MapNoteResult> = {
  Project: { kind: 'project', markdown: '---\nkind: "project"\n---\n# Project\n\n## Overview\nA shop.\n\n## Subsystems\n- [[modules/src|src]] — the code\n', links: [{ kind: 'module', path: 'src', label: 'src' }] },
  'src/orders.ts': { kind: 'file', markdown: '# src/orders.ts\n\n## What\nHandles orders.\n\n## Uses\n- [[files/src/money.ts|money.ts]]\n', links: [{ kind: 'module', path: 'src', label: 'src' }, { kind: 'file', path: 'src/money.ts', label: 'money.ts' }] },
}

function fakeClient(status: MapStatus | null): ProtocolClient & { calls: Array<[string, unknown]>; fire: (p: MapProgress) => void } {
  const calls: Array<[string, unknown]> = []
  let listener: ((p: MapProgress) => void) | null = null
  return {
    calls,
    fire: (p: MapProgress) => listener?.(p),
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params])
      if (method === 'map.status') return status ?? { ...STATUS, exists: false, files: 0, modules: 0, noted: 0 }
      if (method === 'map.tree') return status === null ? { modules: [] } : TREE
      if (method === 'map.note') return NOTES[(params as { path: string }).path] ?? { kind: 'missing', markdown: 'nothing', links: [] }
      if (method === 'map.search') return { hits: [{ kind: 'file', path: 'src/orders.ts', score: 3, what: 'Handles orders.' }] }
      if (method === 'map.build') return { started: true }
      if (method === 'map.stop') return { stopped: true }
      return {}
    }),
    on: (event: string, cb: (p: MapProgress) => void) => { if (event === 'map.progress') listener = cb; return () => { listener = null } },
  } as unknown as ProtocolClient & { calls: Array<[string, unknown]>; fire: (p: MapProgress) => void }
}

const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve() }) }
let host: HTMLDivElement | null = null
afterEach(() => { if (host) { render(null, host); host.remove(); host = null } })

async function mount(client: ProtocolClient, onOpenFile: (p: string) => void = () => {}): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => { render(<MapTab client={client} active onOpenFile={onOpenFile} />, host!) })
  await flush()
  await flush()
  return host
}

describe('the Map tab', () => {
  test('with no map yet it explains and offers Build, which starts a build', async () => {
    const client = fakeClient(null)
    const el = await mount(client)
    expect(el.textContent).toContain('No map yet')
    const build = el.querySelector('[data-action="map-build"]') as HTMLButtonElement
    expect(build.textContent).toContain('Build')
    await act(async () => { build.click() })
    await flush()
    expect(client.calls.find(([m]) => m === 'map.build')?.[1]).toEqual({ verify: false })
    // The build reports; the header follows it.
    await act(async () => { client.fire({ phase: 'files', done: 1, total: 4, current: 'src/orders.ts' }) })
    expect(el.querySelector('[data-map-progress="files"]')?.textContent).toContain('Writing file notes')
    expect(el.querySelector('[data-map-progress="files"]')?.textContent).toContain('1/4')
    expect(el.querySelector('[data-action="map-stop"]')).not.toBeNull()
  })

  test('with a map: the counts, the tree, the project note first, a file note with its links', async () => {
    const opened: string[] = []
    const client = fakeClient(STATUS)
    const el = await mount(client, (p) => opened.push(p))
    expect(el.querySelector('[data-map-counts]')?.textContent).toBe('2/2 files noted · fidelity 67%')
    expect(el.querySelector('[data-action="map-build"]')?.textContent).toContain('Update')
    expect(el.querySelector('[data-map-note]')?.getAttribute('data-map-note')).toBe('project:')
    expect(el.querySelector('[data-map-note]')?.textContent).toContain('A shop.')
    // Wikilinks read as their label in the prose; the links row is the clickable version.
    expect(el.querySelector('[data-map-note]')?.textContent).not.toContain('[[')
    expect(el.querySelector('[data-map-note]')?.textContent).toContain('src — the code')

    // The first level is open on arrival; its files are on screen without a click.
    const file = el.querySelector('[data-map-file="src/orders.ts"]') as HTMLButtonElement
    expect(file).not.toBeNull()
    expect(file.textContent).toContain('67%')
    expect(el.querySelector('[data-map-file="src/money.ts"]')?.textContent).toContain('stale')
    // A file that never had a note is not "stale": it has nothing to be stale.
    expect(el.querySelector('[data-map-file="src/new.ts"]')?.textContent).toContain('no note')
    await act(async () => { file.click() })
    await flush()
    expect(client.calls.find(([m, p]) => m === 'map.note' && (p as { path: string }).path === 'src/orders.ts')).toBeDefined()
    expect(el.querySelector('[data-map-note]')?.textContent).toContain('Handles orders.')
    const links = [...el.querySelectorAll('[data-map-links] button')].map((b) => b.textContent?.trim())
    expect(links).toEqual(['src/', 'money.ts'])
    const open = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Open file')) as HTMLButtonElement
    await act(async () => { open.click() })
    expect(opened).toEqual(['src/orders.ts'])
  })

  test('a search lists hits, and a hit opens its note', async () => {
    const client = fakeClient(STATUS)
    const el = await mount(client)
    const box = el.querySelector('input[aria-label="Search the notes"]') as HTMLInputElement
    await act(async () => { box.value = 'orders'; box.dispatchEvent(new Event('input', { bubbles: true })) })
    await flush()
    const hit = el.querySelector('[data-map-hit="src/orders.ts"]') as HTMLButtonElement
    expect(hit?.textContent).toContain('Handles orders.')
    await act(async () => { hit.click() })
    await flush()
    expect(el.querySelector('[data-map-note]')?.getAttribute('data-map-note')).toBe('file:src/orders.ts')
  })
})
