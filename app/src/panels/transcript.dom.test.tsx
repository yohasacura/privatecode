// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { Transcript } from './transcript'
import { initialChatState, type ChatItem, type ChatState } from '../lib/state'
import type { ProtocolClient } from '../lib/client'

const client = { call: () => Promise.resolve({}), on: () => () => {} } as unknown as ProtocolClient

const user = (id: number, text = 'do it'): ChatItem => ({ kind: 'user', id, text })
const prose = (id: number): ChatItem => ({ kind: 'assistant', id, text: 'done', interrupted: false })
const tool = (id: number, name: string, args: Record<string, unknown>, ok = true): ChatItem => ({
  kind: 'tool', id, name, args: JSON.stringify(args), startedAtMs: 0,
  result: { ok, content: '', display: '', preview: '' },
} as unknown as ChatItem)

function mount(patch: Partial<ChatState>): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state: ChatState = { ...initialChatState(), ...patch }
  act(() => {
    render(
      <Transcript client={client} state={state} dispatch={() => {}} onOpenFile={() => {}} onBackToLive={() => {}} />,
      host,
    )
  })
  return host
}

afterEach(() => { document.body.innerHTML = '' })

describe('action groups in the transcript', () => {
  it('folds finished work into one sentence and opens on a click', () => {
    const host = mount({ items: [
      user(1), tool(2, 'Read', { path: 'a.cs' }), tool(3, 'Read', { path: 'b.cs' }), tool(4, 'Edit', { path: 'a.cs' }), prose(5),
    ] })
    const group = host.querySelector<HTMLElement>('[data-group]')!
    expect(group.dataset['group']).toBe('done')
    const header = group.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(header.textContent).toContain('Read 2 files · edited 1')
    expect(header.textContent).toContain('3 steps')
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(group.querySelectorAll('.row-tool')).toHaveLength(0)
    act(() => header.click())
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(group.querySelectorAll('.row-tool')).toHaveLength(3)
  })

  it('stays open when something in it failed, and while it is live', () => {
    const failed = mount({ items: [user(1), tool(2, 'Read', { path: 'a.cs' }), tool(3, 'Bash', { commands: ['dotnet build'] }, false), prose(4)] })
    const group = failed.querySelector<HTMLElement>('[data-group]')!
    expect(group.dataset['group']).toBe('failed')
    expect(group.querySelector('button[aria-expanded]')!.getAttribute('aria-expanded')).toBe('true')
    document.body.innerHTML = ''

    const live = mount({ turnRunning: true, items: [user(1), tool(2, 'Read', { path: 'a.cs' }), tool(3, 'Read', { path: 'Store.cs' })] })
    const liveGroup = live.querySelector<HTMLElement>('[data-group]')!
    expect(liveGroup.dataset['group']).toBe('live')
    expect(liveGroup.querySelector('button')!.textContent).toContain('Reading Store.cs')
  })

  it('a lone tool call is a row of its own', () => {
    const host = mount({ items: [user(1), tool(2, 'Read', { path: 'a.cs' }), prose(3)] })
    expect(host.querySelector('[data-group]')).toBeNull()
    expect(host.querySelectorAll('.row-tool')).toHaveLength(1)
  })
})

describe('the first screen of a session', () => {
  it('offers starters that go to the composer as a window event', () => {
    const host = mount({})
    const heard: string[] = []
    const listen = (e: Event): void => { heard.push((e as CustomEvent<string>).detail) }
    window.addEventListener('pc:compose', listen)
    const chips = host.querySelectorAll<HTMLButtonElement>('.empty-state button')
    expect(chips.length).toBe(3)
    act(() => chips[0]!.click())
    window.removeEventListener('pc:compose', listen)
    expect(heard).toHaveLength(1)
    expect(heard[0]).toMatch(/explain/i)
  })
})

describe('what a person can do with a row', () => {
  it('a request can be copied or put back in the composer to resend', () => {
    const host = mount({ items: [user(1, 'rename Foo to Bar'), prose(2)] })
    const heard: string[] = []
    const listen = (e: Event): void => { heard.push((e as CustomEvent<string>).detail) }
    window.addEventListener('pc:compose', listen)
    const edit = host.querySelector<HTMLButtonElement>('.row-user [aria-label="Edit and resend"]')!
    act(() => edit.click())
    window.removeEventListener('pc:compose', listen)
    expect(heard).toEqual(['rename Foo to Bar'])
  })

  it('a dropped stream ends in one line and a Continue that sends the nudge', () => {
    const host = mount({ items: [
      user(1), { kind: 'assistant', id: 2, text: 'half an ans', interrupted: false },
      { kind: 'error', id: 3, message: 'llama.cpp stream ended before completion (connection dropped mid-generation)' },
    ] })
    const heard: string[] = []
    const listen = (e: Event): void => { heard.push((e as CustomEvent<string>).detail) }
    window.addEventListener('pc:send', listen)
    const button = host.querySelector<HTMLButtonElement>('[data-action="continue"]')!
    expect(button).not.toBeNull()
    act(() => button.click())
    window.removeEventListener('pc:send', listen)
    expect(heard).toEqual(['continue'])
  })

  it('a stopped turn offers to resume, except when the advice is to start over', () => {
    const stopped = mount({ items: [user(1), { kind: 'stopped', id: 2, reason: 'max_steps' }] })
    expect(stopped.querySelector('[data-action="resume"]')).not.toBeNull()
    document.body.innerHTML = ''
    const truncated = mount({ items: [user(1), { kind: 'stopped', id: 2, reason: 'truncated' }] })
    expect(truncated.querySelector('[data-action="resume"]')).toBeNull()
    document.body.innerHTML = ''
    // Not on an old one: the offer belongs to the last thing that happened.
    const old = mount({ items: [user(1), { kind: 'stopped', id: 2, reason: 'max_steps' }, user(3), prose(4)] })
    expect(old.querySelector('[data-action="resume"]')).toBeNull()
  })
})

describe('the checks strip', () => {
  it('shows each stage of the live turn with its state', () => {
    const host = mount({
      items: [user(1), prose(2)],
      stages: [
        { stage: 'contract', state: 'passed', detail: undefined, at: undefined, startedAtMs: 0, ms: 1200, outcome: '3 criteria', attempt: 1 },
        { stage: 'build', state: 'running', detail: 'dotnet build in src', at: undefined, startedAtMs: Date.now(), ms: undefined, outcome: undefined, attempt: 2 },
      ],
    })
    const chips = [...host.querySelectorAll<HTMLElement>('[data-strip="stages"] [data-stage]')]
    expect(chips.map((c) => [c.dataset['stage'], c.dataset['state']])).toEqual([['contract', 'passed'], ['build', 'running']])
    expect(chips[1]!.textContent).toContain('attempt 2')
    expect(chips[1]!.title).toBe('dotnet build in src')
  })

  it('says when the checks are off, and says nothing before anything happened', () => {
    const session = { sessionId: 's1', mode: 'normal' as const, gateMode: 'manual' as const, contextLength: null, title: '' }
    const off = mount({ items: [user(1), prose(2)], session })
    expect(off.querySelector('[data-strip="off"]')?.textContent).toContain('checks off')
    document.body.innerHTML = ''
    const empty = mount({ session })
    expect(empty.querySelector('[data-strip]')).toBeNull()
  })
})
