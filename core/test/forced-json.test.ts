import { afterEach, expect, test } from 'vitest'
import { forcedJson } from '../src/session/forced-json.js'
import { reviewVerdict } from '../src/session/contract.js'
import { LlamaClient } from '../src/llama/client.js'
import { startFakeServer } from './fake-server.js'
import type { ToolSchema } from '../src/llama/types.js'

/**
 * The one request shape every gate depends on, pinned.
 *
 * Measured against llama.cpp b10665 (spike/response-format-check.mts): `tools` together
 * with `response_format` is refused — HTTP 400, "failed to parse grammar" — in every schema
 * shape, and `forcedJson` turns a refusal into `null` by design. So from the server update
 * of 2026-08-28 until `tool_choice: 'none'` was added, every gate asked its question, was
 * refused in 0.2 s, and reported that it could not run. Nothing in the test suite noticed,
 * because the fake server accepts anything. This test at least pins the request.
 */

let stop: (() => Promise<void>) | undefined
afterEach(async () => { await stop?.(); stop = undefined })

const tool: ToolSchema = {
  type: 'function',
  function: { name: 'Read', description: 'r', parameters: { type: 'object', properties: {} } },
}
const answer = { choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }] }

test('with the session\'s tool array along, the request says tool_choice none', async () => {
  const fake = await startFakeServer(() => answer)
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'm' })
  const parsed = await forcedJson(client, {
    messages: [{ role: 'user', content: 'q' }],
    name: 'probe',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    maxTokens: 50,
    tools: [tool],
  })
  expect(parsed).toEqual({ ok: true })
  const body = fake.requests[0]?.body
  expect(body.tools).toHaveLength(1)
  expect(body.tool_choice).toBe('none')
  expect(body.response_format?.json_schema?.name).toBe('probe')
})

test('without tools there is no tool_choice to send', async () => {
  const fake = await startFakeServer(() => answer)
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'm' })
  await forcedJson(client, {
    messages: [{ role: 'user', content: 'q' }],
    name: 'probe',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    maxTokens: 50,
  })
  const body = fake.requests[0]?.body
  expect(body.tools).toBeUndefined()
  expect(body.tool_choice).toBeUndefined()
})

test('the reviewer\'s verdict, which builds its own request, sends the same pair', async () => {
  const fake = await startFakeServer(() => ({
    choices: [{ message: { role: 'assistant', content: '{"goalMet":true,"goalGap":"","issues":[]}' }, finish_reason: 'stop' }],
  }))
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'm' })
  await reviewVerdict(client, [{ role: 'user', content: 'review this' }], undefined, [tool])
  const body = fake.requests[0]?.body
  expect(body.tools).toHaveLength(1)
  expect(body.tool_choice).toBe('none')
  expect(body.response_format?.json_schema?.name).toBe('review')
})
