// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { initialChatState, type ChatState } from '../lib/state'
import { Composer } from './composer'

/** The composer's bar and its edges (docs/UI-REDESIGN-2026-09.md §6): what it says when it
 * cannot send, and the affordances that put text in the box for you. */

let host: HTMLElement

function stubClient(commands: { name: string; description: string }[] = []): ProtocolClient {
  return {
    call: vi.fn(async (method: string) => {
      if (method === 'commands.list') return { commands }
      if (method === 'fs.find') return { entries: [] }
      if (method === 'prompt.reply') return { reply: null }
      return {}
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}

function draw(patch: Partial<ChatState> = {}, extra: { locked?: string } = {}, client = stubClient()): void {
  const state: ChatState = {
    ...initialChatState(),
    session: { sessionId: 's1', mode: 'normal', contextLength: null, title: 't', gateMode: 'auto' },
    ...patch,
  }
  act(() => {
    render(
      <Composer
        client={client}
        state={state}
        dispatch={() => {}}
        modalOpen={false}
        onAdoptViewed={async () => {}}
        {...(extra.locked !== undefined ? { locked: extra.locked } : {})}
      />,
      host,
    )
  })
}

function box(): HTMLTextAreaElement {
  const el = host.querySelector('textarea')
  if (el === null) throw new Error('the composer has no textarea')
  return el
}

function type(text: string): void {
  act(() => {
    const el = box()
    el.value = text
    el.setSelectionRange(text.length, text.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host) })
afterEach(() => { render(null, host); host.remove() })

describe('the bar', () => {
  it('offers the modes as one radiogroup with the current one checked', () => {
    draw()
    const group = host.querySelector('[role="radiogroup"]')!
    expect(group.getAttribute('aria-label')).toMatch(/how much the agent may do/i)
    const checked = group.querySelector('[role="radio"][aria-checked="true"]')!
    expect(checked.textContent).toBe('Normal')
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(4)
  })

  it('shows the checks as a switch that says which way it is', () => {
    draw()
    const sw = host.querySelector('[role="switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).toContain('Checks on')
  })

  it('the paperclip puts an @ at the caret, which is what opens the file picker', () => {
    draw()
    type('look at ')
    act(() => host.querySelector<HTMLButtonElement>('[aria-label^="Attach"]')!.click())
    expect(box().value).toBe('look at @')
  })
})

describe('when it cannot send', () => {
  it('a locked box is read-only and says why where the words would go', () => {
    draw({}, { locked: 'An update is installing — the agent restarts in a moment.' })
    expect(box().readOnly).toBe(true)
    expect(box().placeholder).toBe('An update is installing — the agent restarts in a moment.')
    const send = host.querySelector<HTMLButtonElement>('[data-action="send"]')!
    expect(send.disabled).toBe(true)
    expect(send.title).toBe('An update is installing — the agent restarts in a moment.')
  })

  it('a slash that matches no command says so instead of sending it', async () => {
    draw({}, {}, stubClient([{ name: 'compact', description: 'Fold the conversation' }]))
    // The command list arrives from the host after mount; let that round-trip settle.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    type('/zzz')
    expect(host.querySelector('[data-picker="commands-empty"]')?.textContent).toContain('No such command')
    type('/comp')
    expect(host.querySelector('[data-picker="commands-empty"]')).toBeNull()
    expect(host.querySelector('[data-picker="commands"] [role="option"]')?.textContent).toContain('/compact')
  })
})
