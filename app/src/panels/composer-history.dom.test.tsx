// @vitest-environment happy-dom
import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { initialChatState, type ChatItem, type ChatState } from '../lib/state'
import { Composer } from './composer'

/**
 * Walking back through what you have already sent.
 *
 * The keys are shared with two pickers and with ordinary caret movement inside a multi-line
 * draft, so the whole feature lives or dies on WHEN it declines to act. These pin the three
 * cases that make it usable rather than infuriating: an arrow in the middle of a draft moves
 * the caret, an arrow at the edge recalls, and the draft you were writing comes back.
 */

let host: HTMLElement
let client: ProtocolClient

function stubClient(): ProtocolClient {
  return {
    call: vi.fn(async (method: string) => {
      if (method === 'commands.list') return { commands: [] }
      if (method === 'fs.find') return { entries: [] }
      if (method === 'prompt.reply') return { reply: null }
      return {}
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}

/** A state carrying `sent` as this session's own user messages, newest last. */
function stateWith(sent: string[]): ChatState {
  const items: ChatItem[] = sent.map((text, i) => ({ kind: 'user', id: i + 1, text }))
  return {
    ...initialChatState(),
    items,
    session: { sessionId: 's1', mode: 'normal', contextLength: null, title: 't', gateMode: 'auto' },
  }
}

async function settle(ticks = 4): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 20))
}

function draw(state: ChatState): void {
  render(
    <Composer
      client={client}
      state={state}
      dispatch={() => {}}
      modalOpen={false}
      onAdoptViewed={async () => {}}
    />,
    host,
  )
}

function box(): HTMLTextAreaElement {
  const el = host.querySelector('textarea')
  if (el === null) throw new Error('the composer has no textarea')
  return el as HTMLTextAreaElement
}

/** A real keydown, so the component's own handler and its preventDefault both run. */
function press(key: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  box().dispatchEvent(e)
  return e
}

/** Typing, the way the component hears it. */
function type(text: string): void {
  const el = box()
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function caret(at: number): void {
  box().setSelectionRange(at, at)
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  client = stubClient()
})
afterEach(() => {
  render(null, host)
  host.remove()
})

test('Up in an empty box recalls the newest message', async () => {
  draw(stateWith(['first thing', 'second thing']))
  await settle()

  box().focus()
  caret(0)
  press('ArrowUp')
  await settle()

  expect(box().value).toBe('second thing')
})

test('Up again reaches the one before, and stops at the oldest', async () => {
  draw(stateWith(['first thing', 'second thing']))
  await settle()
  box().focus()
  caret(0)

  press('ArrowUp')
  await settle()
  caret(0)
  press('ArrowUp')
  await settle()
  expect(box().value).toBe('first thing')

  // At the oldest entry the key is NOT consumed — it goes back to being an ordinary Up.
  caret(0)
  const e = press('ArrowUp')
  await settle()
  expect(box().value).toBe('first thing')
  expect(e.defaultPrevented).toBe(false)
})

test('the draft you were writing comes back when you walk forward past the newest', async () => {
  draw(stateWith(['sent earlier']))
  await settle()

  type('half a thought')
  await settle()
  caret(0)
  press('ArrowUp')
  await settle()
  expect(box().value).toBe('sent earlier')

  // This is the failure that makes people stop using history at all: losing what they were
  // writing to a stray Up.
  caret(box().value.length)
  press('ArrowDown')
  await settle()
  expect(box().value).toBe('half a thought')
})

test('an arrow inside a draft moves the caret and does not recall', async () => {
  draw(stateWith(['sent earlier']))
  await settle()

  type('line one\nline two')
  await settle()
  // Caret in the middle: this Up belongs to the text, not to the history.
  caret(12)
  const e = press('ArrowUp')
  await settle()

  expect(box().value).toBe('line one\nline two')
  expect(e.defaultPrevented).toBe(false)
})

test('with nothing sent yet, Up is an ordinary Up', async () => {
  draw(stateWith([]))
  await settle()

  box().focus()
  caret(0)
  const e = press('ArrowUp')
  await settle()

  expect(box().value).toBe('')
  expect(e.defaultPrevented).toBe(false)
})

test('the harness\'s own user-role notes are not history', async () => {
  const state = stateWith(['mine'])
  state.items.push({ kind: 'user', id: 99, text: 'the build failed, here is the output', harness: true })
  draw(state)
  await settle()

  box().focus()
  caret(0)
  press('ArrowUp')
  await settle()

  // A verify result and a plan focus note share `role: 'user'` with your words and are not
  // things you typed. Recalling one would be the window quoting itself back at you.
  expect(box().value).toBe('mine')
})

/**
 * The suggested reply.
 *
 * The gate is the whole design: a suggestion is asked for only when the answer ENDED IN A
 * QUESTION, because that is when a reply is the obvious next thing. Asking after every turn
 * would spend a model generation proposing something nobody wanted, and the server has one
 * slot to spend it in.
 */
function withAnswer(text: string): ChatState {
  return {
    ...initialChatState(),
    items: [{ kind: 'assistant', id: 1, text, interrupted: false }],
    session: { sessionId: 's1', mode: 'normal', contextLength: null, title: 't', gateMode: 'auto' },
  }
}

function replied(reply: string | null): { client: ProtocolClient; asked: () => number } {
  let asked = 0
  const c = {
    call: vi.fn(async (method: string) => {
      if (method === 'prompt.reply') { asked++; return { reply } }
      if (method === 'commands.list') return { commands: [] }
      if (method === 'fs.find') return { entries: [] }
      return {}
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
  return { client: c, asked: () => asked }
}

test('an answer ending in a question earns a suggestion, and Tab takes it', async () => {
  const r = replied('Yes, fix it and rebuild the app.')
  client = r.client
  draw(withAnswer('I found the cause in two places.\n\nShall I fix it and rebuild?'))
  await settle()

  expect(r.asked()).toBe(1)
  // Shown in the placeholder, which is where an empty box already draws faint text — no
  // overlay, and nothing to keep aligned as the font changes.
  expect(box().placeholder).toContain('Yes, fix it and rebuild the app.')
  expect(box().placeholder).toContain('Tab')

  box().focus()
  press('Tab')
  await settle()
  expect(box().value).toBe('Yes, fix it and rebuild the app.')
})

test('an answer that does not ask anything earns nothing', async () => {
  const r = replied('should never be asked for')
  client = r.client
  draw(withAnswer('Done. The build passes and the tests are green.'))
  await settle()

  expect(r.asked()).toBe(0)
  expect(box().placeholder).not.toContain('should never be asked for')
})

test('a rhetorical question mid-answer does not count', async () => {
  const r = replied('nope')
  client = r.client
  // The `?` is not the last thing said, so this is prose, not a question to you.
  draw(withAnswer('Why did it fail? The path was wrong.\n\nFixed and verified.'))
  await settle()

  expect(r.asked()).toBe(0)
})

test('the model declining is silent, not an error', async () => {
  const r = replied(null)
  client = r.client
  draw(withAnswer('Shall I go on?'))
  await settle()

  expect(r.asked()).toBe(1)
  // Nothing shown, nothing said. There is no failure here worth a person's attention.
  expect(box().placeholder).toBe('Ask for a change, a review, or an explanation')
})
