// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { MergeEditor } from './merge-editor'

/**
 * The merge editor, against a scripted host: both sides of each block with a checkbox,
 * Take Incoming / Take Current answering every block, Accept Merge gated on completeness
 * and writing the result through `git.resolve`.
 */

const WORKING = ['top', '<<<<<<< HEAD', 'ours 1', '=======', 'theirs 1', '>>>>>>> feature', 'middle', '<<<<<<< HEAD', 'ours 2', '=======', 'theirs 2', '>>>>>>> feature', 'end', ''].join('\n')

function fakeClient(): ProtocolClient & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params])
      if (method === 'git.conflict') return { base: 'top\nbase\nmiddle\nbase\nend\n', ours: 'top\nours 1\nmiddle\nours 2\nend\n', theirs: 'top\ntheirs 1\nmiddle\ntheirs 2\nend\n', working: WORKING, oursLabel: 'main', theirsLabel: 'feature', operation: 'merge' }
      return { ok: true }
    }),
    on: () => () => {},
  } as unknown as ProtocolClient & { calls: Array<[string, unknown]> }
}

const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve() }) }
let host: HTMLDivElement | null = null
afterEach(() => { if (host) { render(null, host); host.remove(); host = null } })

async function mount(client: ProtocolClient): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => { render(<MergeEditor client={client} root={'D:\\proj'} repoPath="src/app.ts" path="src/app.ts" />, host!) })
  await flush()
  return host
}

describe('the merge editor', () => {
  test('shows both sides of every block, and Accept Merge waits for every answer', async () => {
    const el = await mount(fakeClient())
    expect(el.textContent).toContain('Incoming — feature')
    expect(el.textContent).toContain('Current — main')
    expect(el.textContent).toContain('2 conflicts · 2 unresolved')
    expect(el.querySelectorAll('input[type="checkbox"]').length).toBe(4)
    const accept = el.querySelector('[data-action="accept-merge"]') as HTMLButtonElement
    expect(accept.disabled).toBe(true)
    const result = el.querySelector('textarea[aria-label="Merge result"]') as HTMLTextAreaElement
    // Nothing chosen yet: the blocks are empty in the result, the plain text stays.
    expect(result.value).toBe('top\nmiddle\nend\n')
  })

  test('ticking sides builds the result, and Take Incoming answers everything', async () => {
    const client = fakeClient()
    const el = await mount(client)
    const ours0 = el.querySelector('input[data-side="ours"][data-index="0"]') as HTMLInputElement
    const theirs0 = el.querySelector('input[data-side="theirs"][data-index="0"]') as HTMLInputElement
    await act(async () => { ours0.click() })
    await act(async () => { theirs0.click() })
    let result = (el.querySelector('textarea[aria-label="Merge result"]') as HTMLTextAreaElement).value
    expect(result).toBe('top\nours 1\ntheirs 1\nmiddle\nend\n')
    expect((el.querySelector('[data-action="accept-merge"]') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { (el.querySelector('[data-action="take-incoming"]') as HTMLButtonElement).click() })
    result = (el.querySelector('textarea[aria-label="Merge result"]') as HTMLTextAreaElement).value
    expect(result).toBe('top\ntheirs 1\nmiddle\ntheirs 2\nend\n')
    const accept = el.querySelector('[data-action="accept-merge"]') as HTMLButtonElement
    expect(accept.disabled).toBe(false)
    await act(async () => { accept.click() })
    await flush()
    expect(client.calls.find(([m]) => m === 'git.resolve')?.[1]).toEqual({ root: 'D:\\proj', path: 'src/app.ts', text: 'top\ntheirs 1\nmiddle\ntheirs 2\nend\n' })
    expect(el.textContent).toContain('Resolved and staged')
  })

  test('a hand edit of the result wins, and markers left in it keep Accept disabled', async () => {
    const el = await mount(fakeClient())
    const result = el.querySelector('textarea[aria-label="Merge result"]') as HTMLTextAreaElement
    await act(async () => { result.value = 'top\nmerged by hand\nend\n'; result.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(el.textContent).toContain('edited by hand')
    expect((el.querySelector('[data-action="accept-merge"]') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { result.value = 'top\n<<<<<<< HEAD\nstill\n'; result.dispatchEvent(new Event('input', { bubbles: true })) })
    expect((el.querySelector('[data-action="accept-merge"]') as HTMLButtonElement).disabled).toBe(true)
  })
})
