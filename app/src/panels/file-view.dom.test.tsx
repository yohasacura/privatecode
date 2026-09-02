// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { FileView, isMissing } from './file-view'

/** A file tab's edges (docs/UI-REDESIGN-2026-09.md §7): the file that is gone, and find. */

let host: HTMLElement

function stubClient(read: () => Promise<unknown>): ProtocolClient {
  return {
    call: vi.fn(async (method: string) => {
      if (method === 'fs.read') return read()
      if (method === 'git.diff') return { diff: '' }
      if (method === 'git.status') return { repos: [], unversioned: [] }
      return {}
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}

function draw(client: ProtocolClient, face: 'file' | 'diff' = 'file'): void {
  act(() => {
    render(
      <FileView client={client} path="src/a.ts" face={face} onFaceChange={() => {}} entry={undefined} reviewed={false} />,
      host,
    )
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

function type(el: HTMLInputElement, text: string): void {
  act(() => {
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host) })
afterEach(() => { render(null, host); host.remove() })

describe('a file that is gone', () => {
  it('says so instead of showing an error code', async () => {
    draw(stubClient(() => Promise.reject(new Error("ENOENT: no such file or directory, open 'D:\\ws\\src\\a.ts'"))))
    await settle()
    const empty = host.querySelector('[data-panel="empty"]')!
    expect(empty.textContent).toContain('This file no longer exists')
    expect(empty.querySelector('button')?.textContent).toBe('Try again')
  })

  it('other failures keep their words and offer a retry', async () => {
    draw(stubClient(() => Promise.reject(new Error('the path is outside the workspace'))))
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('outside the workspace')
    expect(host.querySelector('[role="alert"] button')?.textContent).toBe('Retry')
  })

  it('recognises the shapes a missing file takes', () => {
    expect(isMissing('ENOENT: no such file')).toBe(true)
    expect(isMissing('src/a.ts does not exist')).toBe(true)
    expect(isMissing('permission denied')).toBe(false)
  })
})

describe('find in file', () => {
  it('counts the hits and walks them with Enter', async () => {
    draw(stubClient(() => Promise.resolve({ lines: ['alpha', 'beta', 'alpha beta', 'gamma'], truncated: false })))
    await settle()
    act(() => host.querySelector<HTMLButtonElement>('[aria-label^="Find in file"]')!.click())
    const box = host.querySelector<HTMLInputElement>('[data-find] input')!
    type(box, 'alpha')
    expect(host.querySelector('[data-find-count]')?.textContent).toBe('1 of 2')
    act(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(host.querySelector('[data-find-count]')?.textContent).toBe('2 of 2')
    type(box, 'zzz')
    expect(host.querySelector('[data-find-count]')?.textContent).toBe('no matches')
  })

  it('offers the file and its diff as one control', async () => {
    draw(stubClient(() => Promise.resolve({ lines: ['x'], truncated: false })))
    await settle()
    const faces = [...host.querySelectorAll<HTMLElement>('[role="radio"]')].map((r) => r.textContent)
    expect(faces).toEqual(['File', 'Diff'])
  })
})
