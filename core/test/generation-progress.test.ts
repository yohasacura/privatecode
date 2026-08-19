import { afterEach, expect, test } from 'vitest'
import { LlamaClient } from '../src/llama/client.js'
import type { StreamProgress } from '../src/llama/types.js'
import { RawResponse, startFakeServer } from './fake-server.js'

/**
 * The measurement behind "is it stuck, or is it reading?".
 *
 * A turn's longest silence is prefill: the server works through the prompt and streams
 * nothing at all, so every delta callback is quiet and the window's only honest options were
 * the word "working" or an inference drawn from the shape of the transcript. llama.cpp will
 * say what it is doing if asked — `return_progress` during prefill, `timings_per_token`
 * during generation — and these are the tests that it is asked, that the answers are read
 * defensively, and that a reading is never mistaken for a sign of life.
 */

let stop: (() => Promise<void>) | undefined
afterEach(async () => { await stop?.(); stop = undefined })

function sse(...frames: unknown[]): RawResponse {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new RawResponse(200, body, 'text/event-stream')
}

const FINISH = { choices: [{ finish_reason: 'stop', delta: {} }] }

async function collect(...frames: unknown[]): Promise<{ progress: StreamProgress[]; body: any }> {
  let seen: any
  const fake = await startFakeServer((body) => { seen = body; return sse(...frames) })
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'test' })
  const progress: StreamProgress[] = []
  await client.chatStream(
    { messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 },
    { onDelta: (d) => { if (d.progress) progress.push(d.progress) } },
  )
  return { progress, body: seen }
}

test('the request asks for both readings, or the server has no reason to send them', async () => {
  const { body } = await collect(FINISH)
  expect(body.return_progress).toBe(true)
  expect(body.timings_per_token).toBe(true)
})

test('prefill is reported from its own chunk, which carries no choices at all', async () => {
  // The shape that made this worth a test: `prompt_progress` rides a chunk with an EMPTY
  // choices array, so a parser that reads progress after its tolerate-no-choice return sees
  // none of it, ever, and the feature is silently dead.
  const { progress } = await collect(
    { choices: [], prompt_progress: { total: 18_100, cache: 9_700, processed: 12_400, time_ms: 900 } },
    FINISH,
  )
  expect(progress).toHaveLength(1)
  expect(progress[0]!.prompt).toEqual({ processed: 12_400, total: 18_100, cache: 9_700 })
})

test('a cache of zero is still reported — it is the reading that explains a slow turn', async () => {
  const { progress } = await collect(
    { choices: [], prompt_progress: { total: 400, cache: 0, processed: 128 } },
    FINISH,
  )
  expect(progress[0]!.prompt).toEqual({ processed: 128, total: 400, cache: 0 })
})

test('a total of zero reports nothing, rather than a fraction over zero', async () => {
  const { progress } = await collect(
    { choices: [], prompt_progress: { total: 0, cache: 0, processed: 0 } },
    FINISH,
  )
  expect(progress).toHaveLength(0)
})

test('generation is reported from per-token timings, not from counting chunks', async () => {
  // Counting chunks would undercount here exactly as it does live: speculative decoding
  // means one chunk routinely carries several tokens, and `predicted_n` is the only count
  // that knows it.
  const { progress } = await collect(
    { choices: [{ delta: { content: 'hel' } }], timings: { predicted_n: 3, predicted_per_second: 61.4 } },
    FINISH,
  )
  expect(progress).toHaveLength(1)
  expect(progress[0]!.generated).toEqual({ tokens: 3, perSecond: 61.4 })
})

test('a rate the server does not report is left out, not invented', async () => {
  const { progress } = await collect(
    { choices: [{ delta: { content: 'x' } }], timings: { predicted_n: 2 } },
    FINISH,
  )
  expect(progress[0]!.generated).toEqual({ tokens: 2 })
})

test('the slot\'s PREVIOUS token count is never shown as this request\'s', async () => {
  // Measured against the live server, and the reason this test exists in this exact shape:
  // during prefill llama.cpp attaches the slot's leftover timings to every progress chunk.
  // A real 22k-token prefill reported `predicted_n: 575` — the last request's count —
  // fourteen times over fifty-four seconds, before this one had produced a single token.
  // A `predicted_n > 0` guard passes all of that; only "have we seen a delta of our own"
  // does not.
  const { progress } = await collect(
    { choices: [], prompt_progress: { total: 22_153, cache: 0, processed: 2_048 }, timings: { predicted_n: 575, predicted_per_second: 47.7 } },
    { choices: [], prompt_progress: { total: 22_153, cache: 0, processed: 22_153 }, timings: { predicted_n: 575, predicted_per_second: 47.7 } },
    { choices: [{ delta: { content: 'four' } }], timings: { predicted_n: 2, predicted_per_second: 12.8 } },
    FINISH,
  )
  expect(progress.filter((p) => p.generated !== undefined)).toEqual([
    { generated: { tokens: 2, perSecond: 12.8 } },
  ])
  expect(progress.filter((p) => p.prompt !== undefined)).toHaveLength(2)
})

test('garbage in the progress fields reads as "not reported", never as a throw', async () => {
  // This is the one part of the SSE contract taken from documentation rather than measured
  // against the live server. A throw inside the stream reader surfaces to the user as the
  // model's answer having failed, so the wrong shape must degrade quietly.
  const { progress } = await collect(
    { choices: [], prompt_progress: { total: 'lots', cache: null, processed: undefined } },
    { choices: [], prompt_progress: 'nonsense' },
    { choices: [{ delta: { content: 'x' } }], timings: { predicted_n: 'many' } },
    FINISH,
  )
  expect(progress).toHaveLength(0)
})

test('generation readings are throttled, so 60 tokens a second is not 60 events', async () => {
  // Ten tokens back to back, well inside one throttle window: the first is reported and the
  // rest are dropped. Sixty of these a second through the agent loop, the host transport and
  // a Preact reducer would be paid for a number nobody can read that fast.
  const frames = Array.from({ length: 10 }, (_, i) => ({
    choices: [{ delta: { content: 'x' } }],
    timings: { predicted_n: i + 1, predicted_per_second: 60 },
  }))
  const { progress } = await collect(...frames, FINISH)
  expect(progress).toHaveLength(1)
  expect(progress[0]!.generated?.tokens).toBe(1)
})

test('a rate over one token is not reported, because it is not a rate', async () => {
  // Measured live: the first frame after a warm prefill came back with
  // `predicted_per_second: 1000000` — the server dividing one token by an elapsed time of
  // very nearly zero. Rendered, that is "1 tokens · 1000000 tok/s", which reads as a broken
  // app. The count is true and survives; only the rate waits for a second token.
  const { progress } = await collect(
    { choices: [{ delta: { content: 'f' } }], timings: { predicted_n: 1, predicted_per_second: 1_000_000 } },
    FINISH,
  )
  expect(progress[0]!.generated).toEqual({ tokens: 1 })
})

test('the streaming path carries the thinking opt-out, or a compaction thinks', async () => {
  // Latent until compaction started streaming: every `disableThinking` caller used the
  // non-streaming path, so this flag was silently dropped here for as long as it existed.
  // A summariser that thinks spends its budget on the thinking and truncates the summary.
  let seen: any
  const fake = await startFakeServer((body) => { seen = body; return sse(FINISH) })
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'test' })
  await client.chatStream({ messages: [{ role: 'user', content: 'x' }], maxTokens: 8, disableThinking: true })
  expect(seen.chat_template_kwargs).toEqual({ enable_thinking: false })
  // And a request that did not ask stays untouched, rather than gaining a template kwarg.
  await client.chatStream({ messages: [{ role: 'user', content: 'x' }], maxTokens: 8 })
  expect(seen.chat_template_kwargs).toBeUndefined()
})
