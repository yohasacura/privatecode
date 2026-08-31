// @vitest-environment happy-dom
import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ProtocolClient } from '../lib/client'
import { initialChatState, type ChatAction, type ChatState } from '../lib/state'
import { Composer } from './composer'

/**
 * The command picker, and the hole a non-Latin command opened in it.
 *
 * `/doctor` worked and did not appear in the hints, which is how the owner found this. Two
 * regexes were spelled `[a-z0-9-]`: one decides whether the picker opens at all, and the
 * other is the guard that stops a mistyped command reaching the model as chat. Both went
 * blind the moment a command had a Russian spelling — so `/док` offered nothing, and
 * `/докто` would have been sent to a model with no such tool, which answers a typo with a
 * confident account of having done the thing.
 */

let host: HTMLElement
let dispatched: ChatAction[]

function stubClient(): ProtocolClient {
  return {
    call: vi.fn(async (method: string) => {
      if (method === 'commands.list') return { commands: [] }
      if (method === 'fs.find') return { entries: [] }
      if (method === 'prompt.reply') return { reply: null }
      if (method === 'doctor.run') return { report: 'PrivateCode self-diagnosis\nx', savedTo: '.privatecode/diagnosis.md', sessions: 3 }
      return {}
    }),
    on: () => () => {},
  } as unknown as ProtocolClient
}

function draw(): void {
  const state: ChatState = {
    ...initialChatState(),
    session: { sessionId: 's1', mode: 'normal', contextLength: null, title: 't', gateMode: 'auto' },
  }
  render(
    <Composer
      client={stubClient()}
      state={state}
      dispatch={(a) => dispatched.push(a)}
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

function type(text: string): void {
  const el = box()
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function press(key: string): void {
  box().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

async function settle(ticks = 4): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 20))
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  dispatched = []
})
afterEach(() => {
  render(null, host)
  host.remove()
})

test('the doctor is offered in the hints, like every other built-in', async () => {
  draw()
  type('/doc')
  await settle()
  expect(host.textContent).toContain('doctor')
  // And it says what it is for, so it is discoverable rather than merely present.
  expect(host.textContent).toContain('anonymous report')
})

test('its Russian spelling finds it too, and completes to the canonical name', async () => {
  // The bug the owner saw: `/док` failed the picker's shape test entirely, so the list
  // never opened for the one command whose Russian spelling was the one asked for.
  draw()
  type('/док')
  await settle()
  expect(host.textContent).toContain('doctor')
})

test('a mistyped command is still refused rather than sent to the model', async () => {
  // The guard's whole purpose, and the case a Latin-only regex stopped covering. A model
  // with no such tool answers a typo with a confident account of having done the thing.
  draw()
  type('/докто')
  await settle()
  press('Escape')      // dismiss the picker, so Enter is a send rather than a completion
  await settle()
  press('Enter')
  await settle()
  const notes = dispatched.filter((a) => a.type === 'error-note')
  expect(notes).toHaveLength(1)
  expect(JSON.stringify(notes[0])).toContain('is not a command here')
})

test('the command runs without a turn, and its report lands as its own item', async () => {
  draw()
  type('/доктор')
  await settle()
  press('Escape')
  await settle()
  press('Enter')
  await settle()
  const diagnosis = dispatched.find((a) => a.type === 'diagnosis')
  expect(diagnosis).toBeDefined()
  expect(JSON.stringify(diagnosis)).toContain('self-diagnosis')
  // Nothing was sent anywhere: no turn, no model, no message in the conversation.
  expect(dispatched.some((a) => a.type === 'send-failed')).toBe(false)
  expect(box().value).toBe('')
})
