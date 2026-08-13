import { afterEach, expect, test } from 'vitest'
import { LlamaClient, LlamaRequestError } from '../src/llama/client.js'
import { RawResponse, startFakeServer } from './fake-server.js'

/** The thrown value, so its type and fields can be asserted rather than only its text. */
async function thrownBy(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (e) {
    return e
  }
  throw new Error('expected the call to reject, but it resolved')
}

let stop: (() => Promise<void>) | undefined
afterEach(async () => { await stop?.(); stop = undefined })

function completion(overrides: Record<string, unknown> = {}) {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should open the file.',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
        }],
      },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 42 },
    timings: { predicted_per_second: 60.6, prompt_per_second: 545 },
    ...overrides,
  }
}

test('parses reasoning_content, tool calls, finish reason and timings', async () => {
  const fake = await startFakeServer(() => completion())
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'Qwen3.6-35B-A3B' })

  const result = await client.chat({
    messages: [{ role: 'user', content: 'open src/a.ts' }],
    maxTokens: 1000,
  })

  expect(result.finishReason).toBe('tool_calls')
  expect(result.message.reasoning_content).toBe('I should open the file.')
  expect(result.message.tool_calls?.[0]?.function.name).toBe('read_file')
  expect(result.timings?.predicted_per_second).toBeCloseTo(60.6)
  expect(result.usage?.completion_tokens).toBe(42)
})

test('sends the model id and the messages verbatim', async () => {
  const fake = await startFakeServer(() => completion())
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'Qwen3.6-35B-A3B' })

  await client.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 })

  const sent = fake.requests[0]
  expect(sent.url).toBe('/v1/chat/completions')
  expect(sent.body.model).toBe('Qwen3.6-35B-A3B')
  expect(sent.body.messages).toEqual([{ role: 'user', content: 'hi' }])
})

// `toThrow(/llama\.cpp request failed/)` matched every LlamaRequestError the client can
// raise, including ones that never look at the HTTP status at all: turning client.ts's
// `if (!res.ok)` into `if (false)` — deleting the whole status-classification layer —
// left the suite green. What that layer produces is a status and a body, so that is what
// is asserted.
test('raises a typed error carrying the status and body when the server returns a non-2xx', async () => {
  const fake = await startFakeServer(() => { throw new Error('boom') })
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'm' })

  const err = await thrownBy(() => client.chat({ messages: [], maxTokens: 10 }))

  expect(err).toBeInstanceOf(LlamaRequestError)
  const e = err as LlamaRequestError
  expect(e.status).toBe(500)
  expect(e.body).toContain('boom')
  expect(e.message).toMatch(/HTTP 500/)
  // The server produced a response, so it is up: telling the user to restart it would be
  // wrong, and this flag is what the CLI branches on.
  expect(e.answered).toBe(true)
})

// The two doors the head commit left open. Both are a *running* server answering, so both
// must be classified as answered — the CLI's other branch tells the user to start a server
// that is already up and replying.
test('a 200 whose body is not JSON is reported as the server answering, not as unreachable', async () => {
  const fake = await startFakeServer(() => new RawResponse(200, '<html>proxy error</html>', 'text/html'))
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'm' })

  const err = await thrownBy(() => client.chat({ messages: [], maxTokens: 10 }))

  // Pre-fix this was a raw SyntaxError from JSON.parse, which is not a LlamaRequestError
  // at all, so the CLI fell through to "Start it with Start-QwenServer.bat".
  expect(err).toBeInstanceOf(LlamaRequestError)
  const e = err as LlamaRequestError
  expect(e.answered).toBe(true)
  expect(e.status).toBe(200)
  expect(e.body).toContain('proxy error')
  expect(e.message).toMatch(/not JSON/i)
})

test('a 200 with JSON but no choices is reported as the server answering', async () => {
  // llama.cpp's real shape for this: a 200 carrying an error object.
  const fake = await startFakeServer(() => ({ error: { message: 'context window exceeded' } }))
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'm' })

  const err = await thrownBy(() => client.chat({ messages: [], maxTokens: 10 }))

  expect(err).toBeInstanceOf(LlamaRequestError)
  const e = err as LlamaRequestError
  // Pre-fix `status` was undefined here, and the CLI discriminates on "did the HTTP layer
  // error", not "did the server answer" — so this also printed the restart advice.
  expect(e.answered).toBe(true)
  expect(e.message).toMatch(/no choices/i)
  // What the server actually said has to survive: it is the only diagnostic there is.
  expect(e.body).toContain('context window exceeded')
})

test('a request that never reaches a server is reported as unreachable', async () => {
  // Nothing is listening on this port; this is the one case where "start the server" is
  // the right advice, and it must stay distinguishable from the three above.
  const client = new LlamaClient({
    baseUrl: 'http://127.0.0.1:1', model: 'm', requestTimeoutMs: 2_000,
  })

  const err = await thrownBy(() => client.chat({ messages: [], maxTokens: 10 }))

  expect(err).toBeInstanceOf(LlamaRequestError)
  expect((err as LlamaRequestError).answered).toBe(false)
  expect((err as LlamaRequestError).status).toBeUndefined()
})

test('props() maps all fields from /props correctly', async () => {
  const propsPayload = {
    default_generation_settings: { n_ctx: 131072 },
    total_slots: 1,
    model_path: 'D:\\LocalAgentAI\\models\\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
    build_info: 'b10202-155372596',
    model_alias: 'Qwen3.6-35B-A3B',
    chat_template: '{% for message in messages %}...{% endfor %}',
  }

  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') {
      return propsPayload
    }
    return {}
  })
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'Qwen3.6-35B-A3B' })

  const result = await client.props()

  expect(result.buildInfo).toBe('b10202-155372596')
  expect(result.modelPath).toBe('D:\\LocalAgentAI\\models\\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf')
  expect(result.contextLength).toBe(131072)
  expect(result.totalSlots).toBe(1)
})

test('thinking can be switched off for one request, and is on by default', async () => {
  // The switch that makes compaction affordable. Measured on the real server: same prompt,
  // 900-token budget — thinking on gave 20.7 s and 719 characters of answer, thinking off
  // gave 5.2 s and 1069. The budget was going to the thinking and the ANSWER was what got
  // truncated, which is why every compaction was generating twice.
  const seen: Record<string, unknown>[] = []
  const fake = await startFakeServer((body) => {
    seen.push(body as Record<string, unknown>)
    return { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }
  })
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'Qwen3.6-35B-A3B' })

  await client.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 })
  expect(seen[0]!['chat_template_kwargs']).toBeUndefined()

  await client.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, disableThinking: true })
  // `chat_template_kwargs`, not `reasoning_budget`: the server accepts both and honours only
  // this one — `reasoning_budget: 0` came back with 3554 characters of thinking.
  expect(seen[1]!['chat_template_kwargs']).toEqual({ enable_thinking: false })
})
