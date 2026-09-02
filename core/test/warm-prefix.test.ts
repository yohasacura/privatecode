import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../src/session/session.js'
import { LlamaClient } from '../src/llama/client.js'
import { createToolset } from '../src/tools/default-set.js'
import { PermissionEngine } from '../src/permissions/engine.js'
import { startFakeServer } from './fake-server.js'

/**
 * The prefix warm-up: one token asked over message 0 and the tool block the moment a
 * session exists, so the first real step finds them cached instead of paying 20 s of
 * prefill in front of a person who has just pressed Enter.
 *
 * The property that makes it worth anything is BYTE IDENTITY: llama.cpp reuses its cache by
 * longest common prefix, so a warm-up of a prompt that differs from the first step's in one
 * character warms nothing. That is what these tests pin.
 */

let root: string
let stop: (() => Promise<void>) | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-warm-'))
  mkdirSync(join(root, '.privatecode'), { recursive: true })
})
afterEach(async () => {
  await stop?.()
  stop = undefined
  rmSync(root, { recursive: true, force: true })
})

const reply = {
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 50, completion_tokens: 1 },
}

function build(url: string): Session {
  return new Session({
    client: new LlamaClient({ baseUrl: url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    engine: new PermissionEngine({ layers: [], mode: 'autopilot', workspaceRoot: root }),
    repoMap: 'PROJECT MAP\nsrc/a.ts\n  function a :1',
  })
}

test('asks for one token over message 0 and the tool block, and the first turn reuses both byte for byte', async () => {
  const fake = await startFakeServer((_b, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    return reply
  })
  stop = fake.close
  const session = build(fake.url)

  await session.warmPrefix()
  const chats = () => fake.requests.filter((r) => r.url === '/v1/chat/completions').map((r) => r.body)
  expect(chats()).toHaveLength(1)
  const warm = chats()[0]
  expect(warm.max_tokens).toBe(1)
  expect(warm.tools.length).toBeGreaterThan(5)
  expect(warm.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user'])
  expect(warm.messages[0].content).toContain('PROJECT MAP')

  await session.send('hello')
  const first = chats()[1]
  // The same message 0 — not a rebuilt one — and the same tool array in the same order.
  expect(first.messages[0]).toEqual(warm.messages[0])
  expect(JSON.stringify(first.tools)).toBe(JSON.stringify(warm.tools))
  // The placeholder never entered the transcript, and there is exactly one system message.
  expect(first.messages.filter((m: { role: string }) => m.role === 'system')).toHaveLength(1)
  expect(first.messages[1]).toEqual({ role: 'user', content: 'hello' })
  expect(session.messages().filter((m) => m.role === 'system')).toHaveLength(1)
})

test('runs once, and not at all once a turn has been sent', async () => {
  const fake = await startFakeServer((_b, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    return reply
  })
  stop = fake.close
  const session = build(fake.url)
  await session.warmPrefix()
  await session.warmPrefix()
  expect(fake.requests.filter((r) => r.url === '/v1/chat/completions')).toHaveLength(1)
  await session.send('hello')
  await session.warmPrefix()
  expect(fake.requests.filter((r) => r.url === '/v1/chat/completions')).toHaveLength(2)
})

test('a warm-up still in flight is cancelled by abortWarmup, and the session goes on without it', async () => {
  let release: (() => void) | undefined
  let calls = 0
  const fake = await startFakeServer((_b, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    calls++
    // The first chat — the warm-up — hangs until told otherwise, like a server mid-prefill.
    if (calls === 1) return new Promise<unknown>((r) => { release = () => r(reply) })
    return reply
  })
  stop = fake.close
  const session = build(fake.url)
  const warming = session.warmPrefix()
  // Give the request time to reach the fake before cancelling it.
  await new Promise((r) => setTimeout(r, 100))
  session.abortWarmup()
  await warming // resolves, never throws
  release?.()
  const result = await session.send('hello')
  expect(result.stoppedBecause).toBe('done')
  expect(session.messages().filter((m) => m.role === 'system')).toHaveLength(1)
})

test('a server that is not there leaves the session exactly as it was', async () => {
  const session = build('http://127.0.0.1:9') // nothing listens on port 9
  await expect(session.warmPrefix()).resolves.toBeUndefined()
  expect(session.messages().filter((m) => m.role === 'system')).toHaveLength(1)
})
