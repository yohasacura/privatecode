import { afterEach, expect, test } from 'vitest'
import { LlamaClient } from '../src/llama/client.js'
import { startFakeServer } from './fake-server.js'

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

test('raises a typed error when the server returns a non-2xx status', async () => {
  const fake = await startFakeServer(() => { throw new Error('boom') })
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'm' })

  await expect(client.chat({ messages: [], maxTokens: 10 }))
    .rejects.toThrow(/llama\.cpp request failed/)
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
