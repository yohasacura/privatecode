import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../src/session/session.js'
import { SessionStore } from '../src/session/store.js'
import { LlamaClient } from '../src/llama/client.js'
import { createToolset } from '../src/tools/default-set.js'
import { PermissionEngine } from '../src/permissions/engine.js'
import { readSlotRecord, slotFilenameFor, writeSlotRecord } from '../src/session/slot-record.js'
import { RawResponse, startFakeServer } from './fake-server.js'

/**
 * Instant resume: the slot's state saved to disk after a turn, read back when the session
 * is resumed, so a fat transcript costs half a second instead of minutes of prefill.
 *
 * What these pin is the CONTRACT with the server, not the speed: when a save happens (after
 * a done turn, before any gate), what it is labelled with, when a restore is attempted
 * (this session's record, nothing else), and that a server without the flag is asked once.
 */

let root: string
let stop: (() => Promise<void>) | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-slot-'))
  mkdirSync(join(root, '.privatecode'), { recursive: true })
})
afterEach(async () => {
  await stop?.()
  stop = undefined
  rmSync(root, { recursive: true, force: true })
})

const done = {
  choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1200, completion_tokens: 5 },
}

/** A fake that answers chat with `done` and the slot actions as the real server would —
 * or refuses them all with 501 when `slots` is false. */
async function serve(slots = true) {
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    if (req.url?.startsWith('/slots/0?action=')) {
      if (!slots) return new RawResponse(501, '{"error":{"code":501,"message":"This server does not support slots action"}}', 'application/json')
      const action = req.url.split('action=')[1]
      return action === 'save' ? { n_saved: 1200 } : { n_restored: 1200 }
    }
    return done
  })
  stop = fake.close
  return fake
}

function build(url: string, resume?: string): Session {
  return new Session({
    client: new LlamaClient({ baseUrl: url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    engine: new PermissionEngine({ layers: [], mode: 'autopilot', workspaceRoot: root }),
    store: new SessionStore(root),
    ...(resume !== undefined ? { resume } : {}),
  })
}

const slotRequests = (fake: { requests: { url?: string; body: { filename?: string } }[] }) =>
  fake.requests.filter((r) => r.url?.startsWith('/slots/0'))

test('a turn that ends done saves the slot, labelled with the session', async () => {
  const fake = await serve()
  const session = build(fake.url)
  await session.send('hello')

  const saves = slotRequests(fake)
  expect(saves).toHaveLength(1)
  expect(saves[0]!.url).toBe('/slots/0?action=save')
  // One file per workspace, named without a path in it.
  expect(saves[0]!.body.filename).toBe(slotFilenameFor(root))
  expect(saves[0]!.body.filename).toMatch(/^privatecode-[0-9a-f]{12}\.bin$/)
  const record = readSlotRecord(root)
  expect(record?.sessionId).toBe(session.id)
  expect(record?.tokens).toBe(1200)
})

test('the save comes BEFORE the gates, and not again a minute later', async () => {
  const fake = await serve()
  const session = build(fake.url)
  await session.send('hello')
  await session.send('and again')
  // The second turn is within the save interval and grew by little: one save in all.
  expect(slotRequests(fake)).toHaveLength(1)
  // And it preceded every later chat request of the first turn: nothing the gates asked
  // could have moved the slot's state past the transcript before the state was written.
  const urls = fake.requests.map((r) => r.url)
  const saveAt = urls.indexOf('/slots/0?action=save')
  const firstChat = urls.indexOf('/v1/chat/completions')
  expect(firstChat).toBeLessThan(saveAt)
})

test('resuming the session the record names restores the slot, then warms the rest', async () => {
  const fake = await serve()
  const first = build(fake.url)
  await first.send('hello')
  const id = first.id

  const resumed = build(fake.url, id)
  expect(await resumed.restoreSlot()).toBe(true)
  const restore = slotRequests(fake).find((r) => r.url === '/slots/0?action=restore')
  expect(restore?.body.filename).toBe(slotFilenameFor(root))

  // The warm-up still runs after a restore: the transcript may have grown since the save.
  const chatsBefore = fake.requests.filter((r) => r.url === '/v1/chat/completions').length
  await resumed.warmPrefix()
  const chatsAfter = fake.requests.filter((r) => r.url === '/v1/chat/completions')
  expect(chatsAfter).toHaveLength(chatsBefore + 1)
  expect(chatsAfter[chatsAfter.length - 1]!.body.max_tokens).toBe(1)
})

test('a record naming another session is left alone', async () => {
  const fake = await serve()
  const first = build(fake.url)
  await first.send('hello')
  writeSlotRecord(root, { sessionId: 'someone-else', savedAt: new Date().toISOString(), tokens: 5 })

  const resumed = build(fake.url, first.id)
  expect(await resumed.restoreSlot()).toBe(false)
  expect(slotRequests(fake).some((r) => r.url === '/slots/0?action=restore')).toBe(false)
})

test('a server started without the flag is asked once and never labelled', async () => {
  const fake = await serve(false)
  const session = build(fake.url)
  await session.send('hello')
  await session.send('again')
  expect(slotRequests(fake)).toHaveLength(1)
  expect(readSlotRecord(root)).toBeNull()
  expect(await session.restoreSlot()).toBe(false)
})

test('a fresh in-memory session (no store) never touches the slot', async () => {
  const fake = await serve()
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    engine: new PermissionEngine({ layers: [], mode: 'autopilot', workspaceRoot: root }),
  })
  await session.send('hello')
  expect(slotRequests(fake)).toHaveLength(0)
})
