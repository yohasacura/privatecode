import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { SessionHost } from '../src/host/host.js'
import {
  isHostEvent,
  type HostEvent,
  type HostOutbound,
  type HostReply,
} from '../src/host/protocol.js'
import { RawResponse, startFakeServer } from './fake-server.js'

// ---------------------------------------------------------------------------------------
// Fixtures: an in-process fake llama.cpp (the same `startFakeServer` technique
// `test/loop.test.ts` uses -- a real `LlamaClient` pointed at a real HTTP server whose
// handler returns canned responses, including `hang()` for a server that accepts the
// connection and never answers) plus a captured `HostTransport` that records every
// reply/event and lets a test await a specific event by name.
// ---------------------------------------------------------------------------------------

let stop: (() => Promise<void>) | undefined
const workspaces: string[] = []

afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function newWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-host-'))
  workspaces.push(dir)
  return dir
}

/** A request the fake server accepts and never answers -- same technique as loop.test.ts's
 * own `hang()`, used here for the compaction request the session-switch test aborts. */
function hang(): Promise<never> {
  return new Promise<never>(() => {})
}

function sseFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}
const SSE_DONE = 'data: [DONE]\n\n'

/**
 * A `chatStream`-shaped SSE response for a step that calls one tool: a reasoning delta (so
 * the happy-path test has a `thinking.delta` to assert between `step.start` and `tool.call`),
 * the tool-call fragments (id+name on the first, arguments on the second -- the exact shape
 * `LlamaClient.chatStream`'s spike-derived parser expects), the finish_reason chunk, and the
 * usage chunk.
 */
function toolCallSSE(
  name: string,
  args: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } = { completion_tokens: 20, prompt_tokens: 100 },
): RawResponse {
  const body =
    sseFrame({ choices: [{ delta: { reasoning_content: 'thinking about it' } }] }) +
    sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name, arguments: '' } }] } }] }) +
    sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] }) +
    sseFrame({ choices: [{ finish_reason: 'tool_calls', delta: {} }], timings: {} }) +
    sseFrame({ choices: [], usage }) +
    SSE_DONE
  return new RawResponse(200, body, 'text/event-stream')
}

/** A `chatStream`-shaped SSE response for a step that ends the turn with plain text. */
function textSSE(
  text: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } = { completion_tokens: 5, prompt_tokens: 60 },
): RawResponse {
  const body =
    sseFrame({ choices: [{ delta: { content: text } }] }) +
    sseFrame({ choices: [{ finish_reason: 'stop', delta: {} }], timings: {} }) +
    sseFrame({ choices: [], usage }) +
    SSE_DONE
  return new RawResponse(200, body, 'text/event-stream')
}

/**
 * Routes `/props`/`/health` distinctly from `/v1/chat/completions`, and further splits
 * chat traffic by `body.stream`: every host-driven TURN always streams (SessionHost wires
 * onThinkingDelta/onTextDelta unconditionally -- see host.ts), while `generateCompaction`
 * always calls the plain, non-streaming `chat()` (`stream: false` in its payload) -- so
 * `body.stream` alone is enough to tell a turn's own generation apart from a background
 * compaction's, with no call-order bookkeeping needed.
 */
async function makeServer(
  chatHandler: (body: any, streaming: boolean) => unknown,
  contextLength: number | null = 1000,
) {
  return startFakeServer((body, req) => {
    if (req.url === '/props') {
      return contextLength === null ? {} : { default_generation_settings: { n_ctx: contextLength } }
    }
    if (req.url === '/health') return { status: 'ok' }
    return chatHandler(body, body.stream === true)
  })
}

interface CapturedTransport {
  messages: HostOutbound[]
  send(msg: HostOutbound): void
}

function makeTransport(): CapturedTransport {
  const messages: HostOutbound[] = []
  return { messages, send: (msg) => { messages.push(msg) } }
}

function events(transport: CapturedTransport): HostEvent[] {
  return transport.messages.filter(isHostEvent)
}

function eventsNamed(transport: CapturedTransport, name: string): HostEvent[] {
  return events(transport).filter((e) => e.event === name)
}

function reply(transport: CapturedTransport, id: number): HostReply | undefined {
  return transport.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
}

/**
 * The result of request `id`, or a failure that says what actually went wrong.
 *
 * Reading `.result` off a `HostReply` union needs narrowing anyway, and doing it here buys
 * the diagnosis for free: an error reply reports the host's own message instead of the
 * `Cannot read properties of undefined` a bare `?.result` produces, which is what a
 * mis-premised test looks like when it fails.
 */
function resultOf<T>(transport: CapturedTransport, id: number): T {
  const found = reply(transport, id)
  if (!found) throw new Error(`no reply to request ${id}`)
  if ('error' in found) throw new Error(`request ${id} failed: ${found.error.message}`)
  return found.result as T
}

/** Waits for the Nth (default 1st) occurrence of `name` to land in `transport.messages`,
 * polling on the microtask queue -- everything under test here settles via promise chains
 * with no real timers involved, so a `setImmediate`-paced poll is exactly as fast as an
 * event emitter would be, with far less plumbing. */
async function waitForEvent(transport: CapturedTransport, name: string): Promise<HostEvent> {
  for (;;) {
    const found = eventsNamed(transport, name)[0]
    if (found) return found
    await new Promise((r) => setImmediate(r))
  }
}

async function initHost(serverUrl: string, workspaceRoot: string) {
  const transport = makeTransport()
  const host = new SessionHost({ transport })
  await host.handle({ id: 1, method: 'init', params: { workspaceRoot, serverUrl } })
  return { host, transport }
}

// ---------------------------------------------------------------------------------------

test('init -> send happy path: event order step.start -> deltas -> tool.call -> ' +
     'approval.request -> [reply allow] -> tool.result -> turn.done', async () => {
  let call = 0
  const fake = await makeServer(() => {
    call++
    return call === 1
      ? toolCallSSE('write_file', JSON.stringify({ path: 'note.txt', content: 'hello' }))
      : textSSE('all done')
  })
  stop = fake.close
  const root = newWorkspace()
  const { host, transport } = await initHost(fake.url, root)

  const sendPromise = host.handle({ id: 2, method: 'send', params: { text: 'please write the note' } })

  const approvalEvent = await waitForEvent(transport, 'approval.request')
  const requestId = (approvalEvent.data as { requestId: string }).requestId
  expect(typeof requestId).toBe('string')
  expect(requestId.length).toBeGreaterThan(0)

  // The tool must not have run yet -- approval is still pending.
  expect(existsSync(join(root, 'note.txt'))).toBe(false)

  const replyResult = await host.handle({
    id: 3, method: 'approval.reply', params: { requestId, decision: { verdict: 'allow' } },
  })
  void replyResult
  expect(reply(transport, 3)).toEqual({ id: 3, result: {} })

  await sendPromise
  const sendReply = reply(transport, 2)
  expect(sendReply && 'result' in sendReply && sendReply.result).toMatchObject({
    turn: { stoppedBecause: 'done' },
  })

  // The tool ran exactly once the approval was granted.
  expect(existsSync(join(root, 'note.txt'))).toBe(true)
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('hello')

  const names = events(transport).map((e) => e.event)
  const idx = (name: string) => names.indexOf(name)
  const stepStart = idx('step.start')
  const delta = names.findIndex((n) => n === 'thinking.delta' || n === 'text.delta')
  const toolCall = idx('tool.call')
  const approvalRequest = idx('approval.request')
  const toolResult = idx('tool.result')
  const turnDone = idx('turn.done')

  expect(stepStart).toBeGreaterThanOrEqual(0)
  expect(delta).toBeGreaterThan(stepStart)
  expect(toolCall).toBeGreaterThan(delta)
  expect(approvalRequest).toBeGreaterThan(toolCall)
  expect(toolResult).toBeGreaterThan(approvalRequest)
  expect(turnDone).toBeGreaterThan(toolResult)
  expect(eventsNamed(transport, 'tool.result')).toHaveLength(1)
})

test('a reply naming an unknown requestId errors and authorizes nothing; a double-reply ' +
     'errors on the second attempt', async () => {
  let call = 0
  const fake = await makeServer(() => {
    call++
    return call === 1
      ? toolCallSSE('write_file', JSON.stringify({ path: 'note.txt', content: 'hello' }))
      : textSSE('all done')
  })
  stop = fake.close
  const root = newWorkspace()
  const { host, transport } = await initHost(fake.url, root)

  const sendPromise = host.handle({ id: 2, method: 'send', params: { text: 'write it' } })
  const approvalEvent = await waitForEvent(transport, 'approval.request')
  const requestId = (approvalEvent.data as { requestId: string }).requestId

  // Wrong id: refused, and the tool must not run.
  await host.handle({
    id: 3, method: 'approval.reply', params: { requestId: 'not-a-real-id', decision: { verdict: 'allow' } },
  })
  const wrongIdReply = reply(transport, 3)
  expect(wrongIdReply && 'error' in wrongIdReply).toBe(true)
  expect(existsSync(join(root, 'note.txt'))).toBe(false)

  // Correct id: succeeds, exactly once.
  await host.handle({
    id: 4, method: 'approval.reply', params: { requestId, decision: { verdict: 'allow' } },
  })
  expect(reply(transport, 4)).toEqual({ id: 4, result: {} })

  // Same id again: the requestId was single-use and is gone now -- errors.
  await host.handle({
    id: 5, method: 'approval.reply', params: { requestId, decision: { verdict: 'allow' } },
  })
  const secondReply = reply(transport, 5)
  expect(secondReply && 'error' in secondReply).toBe(true)

  await sendPromise
  const sendReply = reply(transport, 2)
  expect(sendReply && 'result' in sendReply && sendReply.result).toMatchObject({
    turn: { stoppedBecause: 'done' },
  })
  expect(existsSync(join(root, 'note.txt'))).toBe(true)
})

test('send while a turn is already running is refused, and does not disturb the running turn', async () => {
  const fake = await makeServer(() => hang())
  stop = fake.close
  const root = newWorkspace()
  const { host, transport } = await initHost(fake.url, root)

  const firstSend = host.handle({ id: 2, method: 'send', params: { text: 'a' } })
  await host.handle({ id: 3, method: 'send', params: { text: 'b' } })

  const refusedReply = reply(transport, 3)
  expect(refusedReply && 'error' in refusedReply).toBe(true)
  expect((refusedReply as { error: { message: string } }).error.message).toMatch(/already running/)

  // Clean up the still-running first turn rather than leaving it hanging past the test.
  await host.handle({ id: 4, method: 'abort', params: {} })
  await firstSend
  const firstReply = reply(transport, 2)
  expect(firstReply && 'result' in firstReply && firstReply.result).toMatchObject({
    turn: { stoppedBecause: 'aborted' },
  })
})

test('prompt.improve returns the draft suggestions, and touches nothing', async () => {
  // The Improve button is a PREVIEW of the distiller: same request a send would make,
  // rendered back as prompt text — and the session's meta must stay exactly as it was,
  // because the draft may never be sent.
  const fake = await makeServer((body: any) => {
    // The distill request is non-streaming with a forced tool; anything else here fails loudly.
    if (body.tool_choice !== 'required') return new RawResponse(500, 'unexpected request', 'text/plain')
    return {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant', content: null,
          tool_calls: [{
            id: 'c1', type: 'function',
            function: {
              name: 'suggest_improvements',
              arguments: JSON.stringify({
                criteria: ['tests/greet.test.js проходит', 'экспорт обновлён'],
                constraints: ['не менять greet()'],
                questions: ['Какие файлы затронуть?'],
              }),
            },
          }],
        },
      }],
      usage: { completion_tokens: 60 },
    }
  })
  stop = fake.close
  const root = newWorkspace()
  const { host, transport } = await initHost(fake.url, root)

  await host.handle({ id: 2, method: 'prompt.improve', params: { text: 'Добавь функцию greetMany, тесты должны проходить.' } })
  const result = resultOf<{ suggestions: { criteria: string[]; constraints: string[]; questions: string[] } | null }>(transport, 2)
  expect(result.suggestions).toEqual({
    criteria: ['tests/greet.test.js проходит', 'экспорт обновлён'],
    constraints: ['не менять greet()'],
    questions: ['Какие файлы затронуть?'],
  })

  // Preview only, and stronger than "no contract in the meta": a fresh session persists
  // nothing until a real send, and the preview must not change that — no state directory
  // at all is exactly "touched nothing".
  expect(existsSync(join(root, '.privatecode', 'state', 'sessions'))).toBe(false)
})

test('abort during contract distillation rolls the whole message back: delivered:false, no title, no contract', async () => {
  // Watched live: Esc two seconds into a task-shaped send. The distiller was the request
  // in flight, so the user message had not reached the transcript — yet the UI kept the
  // row under "continues from here", the session was titled after the phantom message,
  // and an F5 later the row vanished. The host must say the message was never delivered.
  const fake = await makeServer(() => hang())
  stop = fake.close
  const root = newWorkspace()
  const { host, transport } = await initHost(fake.url, root)

  // Task-shaped (>220 chars of prose), so the host asks for a distillation — which hangs.
  const task = 'Добавь в src/greet.js функцию greetMany, которая принимает массив имён и ' +
    'возвращает массив приветствий. Каждый элемент должен проходить ту же валидацию, что и ' +
    'в greet. Добавь tests/greet.test.js с тестами на оба случая и обнови экспорты модуля. ' +
    'Все тесты должны проходить, ничего не ломай.'
  const sendPromise = host.handle({ id: 2, method: 'send', params: { text: task } })
  // The distill request is the FIRST chat call; wait until it is actually in flight so
  // the abort lands mid-distillation rather than before send() started.
  // Generous: under a full parallel suite the first chat POST can take seconds to appear,
  // and a premature timeout here fails the test for slowness, not for wrongness.
  await vi.waitFor(() => {
    if (!fake.requests.some((r: any) => r.body?.messages)) throw new Error('distill not started')
  }, { timeout: 15_000, interval: 25 })
  await host.handle({ id: 3, method: 'abort', params: {} })
  await sendPromise

  const sendReply = reply(transport, 2)
  expect(sendReply && 'result' in sendReply && sendReply.result).toMatchObject({
    turn: { stoppedBecause: 'aborted', delivered: false },
  })
  // Nothing derived from the undelivered message may survive it.
  const metaFile = readdirSync(join(root, '.privatecode', 'state', 'sessions'))
    .find((f) => f.endsWith('.meta.json'))!
  const meta = JSON.parse(readFileSync(join(root, '.privatecode', 'state', 'sessions', metaFile), 'utf8'))
  expect(meta.contract).toBeUndefined()
  expect(meta.title ?? '').not.toMatch(/greetMany|Добавь/)
})

test('abort mid-approval denies the pending approval and ends the turn aborted; the tool never runs', async () => {
  const fake = await makeServer(() =>
    toolCallSSE('write_file', JSON.stringify({ path: 'note.txt', content: 'hello' })))
  stop = fake.close
  const root = newWorkspace()
  const { host, transport } = await initHost(fake.url, root)

  const sendPromise = host.handle({ id: 2, method: 'send', params: { text: 'write it' } })
  await waitForEvent(transport, 'approval.request')

  const abortResult = await host.handle({ id: 3, method: 'abort', params: {} })
  void abortResult
  expect(reply(transport, 3)).toEqual({ id: 3, result: {} })

  await sendPromise
  const sendReply = reply(transport, 2)
  expect(sendReply && 'result' in sendReply && sendReply.result).toMatchObject({
    turn: { stoppedBecause: 'aborted' },
  })
  expect(existsSync(join(root, 'note.txt'))).toBe(false)
})

test('fs.read refuses a path that escapes the workspace or names a denylisted file', async () => {
  const fake = await makeServer(() => hang())
  stop = fake.close
  const root = newWorkspace()
  const { host, transport } = await initHost(fake.url, root)

  await host.handle({ id: 2, method: 'fs.read', params: { path: '../x' } })
  const escapeReply = reply(transport, 2)
  expect(escapeReply && 'error' in escapeReply).toBe(true)
  expect((escapeReply as { error: { message: string } }).error.message).toMatch(/escapes the workspace/)

  await host.handle({ id: 3, method: 'fs.read', params: { path: '.env' } })
  const envReply = reply(transport, 3)
  expect(envReply && 'error' in envReply).toBe(true)
  expect((envReply as { error: { message: string } }).error.message).toMatch(/access denied/)
})

test('config.get/config.set round-trip through SessionHost.handle, available before init', async () => {
  // ui-config.ts's uiConfigPath() reads process.env.APPDATA at call time; redirected here
  // so this test writes to a throwaway temp dir instead of the real machine's
  // %APPDATA%/PrivateCode/ui.json (host.ts's configGet/configSet call the default path,
  // not the test-only override parameter ui-config.test.ts uses directly).
  const previousAppData = process.env['APPDATA']
  const tempAppData = newWorkspace()
  process.env['APPDATA'] = tempAppData
  try {
    const transport = makeTransport()
    const host = new SessionHost({ transport })

    // No init() call anywhere above -- config.get/config.set must work standalone, since
    // a settings modal or workspace picker needs them before any session exists.
    await host.handle({ id: 1, method: 'config.set', params: { serverUrl: 'http://127.0.0.1:8080' } })
    expect(reply(transport, 1)).toEqual({ id: 1, result: {} })

    await host.handle({ id: 2, method: 'config.set', params: { recentWorkspace: 'C:/proj' } })
    expect(reply(transport, 2)).toEqual({ id: 2, result: {} })

    await host.handle({ id: 3, method: 'config.get', params: {} })
    const getReply = reply(transport, 3)
    expect(getReply && 'result' in getReply).toBe(true)
    expect((getReply as { result: unknown }).result).toEqual({
      serverUrl: 'http://127.0.0.1:8080',
      recentWorkspaces: ['C:/proj'],
    })
  } finally {
    process.env['APPDATA'] = previousAppData
  }
})

test('switching sessions aborts an in-flight background compaction instead of hanging on it', async () => {
  const fake = await makeServer((_body, streaming) => {
    if (streaming) {
      // The turn's own generation: one step, no tool call, reported prompt_tokens well
      // over the 80% auto-compaction trigger against the 1000-token context probed below.
      return textSSE('all done', { completion_tokens: 10, prompt_tokens: 900 })
    }
    // The compaction's own (non-streaming) generation: accepted and never answered -- the
    // hanging stub this test aborts.
    return hang()
  })
  stop = fake.close
  const root = newWorkspace()
  const { host, transport } = await initHost(fake.url, root)

  await host.handle({ id: 2, method: 'send', params: { text: 'go' } })
  const sendReply = reply(transport, 2)
  expect(sendReply && 'result' in sendReply && sendReply.result).toMatchObject({
    turn: { stoppedBecause: 'done' },
  })

  // The background compaction fires synchronously off the end of that same send() call --
  // by the time send()'s own reply has landed, 'started' has already been emitted.
  expect(eventsNamed(transport, 'compaction').some((e) => (e.data as { state: string }).state === 'started'))
    .toBe(true)

  // The actual thing under test: switching sessions must not hang even though the
  // compaction it aborts never gets an answer of its own.
  await host.handle({ id: 3, method: 'sessions.new', params: {} })

  const switchReply = reply(transport, 3)
  expect(switchReply && 'result' in switchReply).toBe(true)
  expect(eventsNamed(transport, 'compaction').some((e) => (e.data as { state: string }).state === 'postponed'))
    .toBe(true)
})

/**
 * Sending while a compaction is running.
 *
 * Reported from the running app: the context filled, the window said it was compacting, a
 * message sent at that moment came back `llama.cpp request failed: HTTP 400`. The cause was
 * that `send()` ABORTED the in-flight compaction — and a compaction is only ever running
 * because the context is over the line, so the room it was making was the room that very
 * message needed. The turn then ran against the same over-full transcript and the server
 * refused it.
 *
 * `ready` is the assertion that matters: it is emitted only when the summary generation was
 * allowed to FINISH. Under the old behaviour the abort landed first and the lifecycle went
 * straight from `started` to `postponed`, with no `ready` in between.
 */
test('a message sent during a compaction waits for it instead of killing it', async () => {
  let compactions = 0
  const fake = await makeServer((body, streaming) => {
    if (streaming) return textSSE('all done', { completion_tokens: 10, prompt_tokens: 900 })
    // Only the summary generation counts as the compaction — the background PREWARM that
    // follows a ready summary is also a non-streaming request (max_tokens 1) and must not
    // be mistaken for a second compaction by this counter.
    const last = (body.messages as { content?: string | null }[]).at(-1)
    const isSummary = typeof last?.content === 'string' && last.content.includes('compacted to free up context')
    if (!isSummary) {
      return { choices: [{ message: { content: 'warm' }, finish_reason: 'length' }] }
    }
    compactions++
    // Slow enough that the second send() below lands while it is still in flight, which is
    // the whole situation under test.
    return new Promise((resolve) => setTimeout(
      () => resolve({ choices: [{ message: { content: 'a summary' }, finish_reason: 'stop' }] }),
      120,
    ))
  })
  stop = fake.close
  const root = newWorkspace()
  const { host, transport } = await initHost(fake.url, root)

  // The first turn reports 900 of 1000 prompt tokens, which trips the auto-trigger; the
  // background compaction starts off the end of this same call.
  await host.handle({ id: 2, method: 'send', params: { text: 'go' } })
  const states = (): string[] =>
    eventsNamed(transport, 'compaction').map((e) => (e.data as { state: string }).state)
  expect(states()).toContain('started')
  expect(states()).not.toContain('ready')

  // Sent while it is still generating — exactly what the user did.
  await host.handle({ id: 3, method: 'send', params: { text: 'and one more thing' } })

  expect(compactions).toBe(1)
  expect(states()).toContain('ready')
  const second = reply(transport, 3)
  expect(second && 'result' in second && second.result).toMatchObject({
    turn: { stoppedBecause: 'done' },
  })
  await host.shutdown()
}, 30_000)

/**
 * Closing the window used to throw away the conversation you were in the middle of: every
 * launch called `init` with no resume and got a fresh session. Now that a resumed session
 * can actually be SHOWN, continuing the last one is what a launch should do.
 */
test('init with continueLast opens the workspace\'s newest session, with its conversation', async () => {
  const fake = await makeServer(() => textSSE('noted'))
  stop = fake.close
  const root = newWorkspace()

  // Two sessions, the second one carrying a turn, so "newest" is a real distinction and
  // there is something to come back to.
  const first = await initHost(fake.url, root)
  const firstId = resultOf<{ sessionId: string }>(first.transport, 1).sessionId
  await first.host.handle({ id: 2, method: 'sessions.new', params: {} })
  const secondId = resultOf<{ sessionId: string }>(first.transport, 2).sessionId
  await first.host.handle({ id: 3, method: 'send', params: { text: 'remember this' } })
  await first.host.shutdown()

  expect(secondId).not.toBe(firstId)

  // A fresh host, as a relaunch would be.
  const transport = makeTransport()
  const host = new SessionHost({ transport })
  await host.handle({
    id: 1, method: 'init', params: { workspaceRoot: root, serverUrl: fake.url, continueLast: true },
  })
  const result = resultOf<{ sessionId: string; items: unknown[] }>(transport, 1)

  expect(result.sessionId).toBe(secondId)
  expect(result.items).toContainEqual({ kind: 'user', text: 'remember this' })
  await host.shutdown()
})

test('continueLast in a workspace with no sessions yet is simply a fresh one', async () => {
  const fake = await makeServer(() => textSSE('hi'))
  stop = fake.close
  const root = newWorkspace()
  const transport = makeTransport()
  const host = new SessionHost({ transport })
  await host.handle({
    id: 1, method: 'init', params: { workspaceRoot: root, serverUrl: fake.url, continueLast: true },
  })
  const result = resultOf<{ sessionId: string; items: unknown[] }>(transport, 1)
  expect(typeof result.sessionId).toBe('string')
  expect(result.items).toEqual([])
  await host.shutdown()
})

test('an explicit resume beats continueLast: they answer different questions', async () => {
  const fake = await makeServer(() => textSSE('ok'))
  stop = fake.close
  const root = newWorkspace()
  const first = await initHost(fake.url, root)
  const oldest = resultOf<{ sessionId: string }>(first.transport, 1).sessionId
  // Both sessions take a turn: a session with no messages was never written to disk, so
  // resuming it is a "not found", not a fair test of which id wins.
  await first.host.handle({ id: 2, method: 'send', params: { text: 'the older one' } })
  await first.host.handle({ id: 3, method: 'sessions.new', params: {} })
  await first.host.handle({ id: 4, method: 'send', params: { text: 'the newer one' } })
  await first.host.shutdown()

  const transport = makeTransport()
  const host = new SessionHost({ transport })
  await host.handle({
    id: 1,
    method: 'init',
    params: { workspaceRoot: root, serverUrl: fake.url, continueLast: true, resume: oldest },
  })
  expect(resultOf<{ sessionId: string }>(transport, 1).sessionId).toBe(oldest)
  await host.shutdown()
})

/**
 * The verify loop's gating, through the host, because the condition most likely to regress
 * is also the most annoying one to get wrong: a check that fires after a turn which only
 * READ things would add its whole runtime to every question anyone asks.
 */
test('verify runs after a turn that wrote, and not after one that only read', async () => {
  let call = 0
  const fake = await makeServer((_body, _streaming) => {
    call++
    if (call === 1) return toolCallSSE('write_file', JSON.stringify({ path: 'a.txt', content: 'x' }))
    return textSSE('done')
  })
  stop = fake.close
  const root = newWorkspace()
  mkdirSync(join(root, '.privatecode'), { recursive: true })
  // The verify command is observable by what it leaves behind, which is the only way to
  // assert "it ran" without reaching inside the session.
  writeFileSync(
    join(root, '.privatecode', 'settings.json'),
    JSON.stringify({
      verify: 'Write-Output ran >> verified.log',
      permissions: { allow: ['write_file(**)'] },
    }),
    'utf8',
  )

  const { host, transport } = await initHost(fake.url, root)
  await host.handle({ id: 2, method: 'send', params: { text: 'write the file' } })

  const log = join(root, 'verified.log')
  expect(existsSync(log)).toBe(true)
  const afterWrite = readFileSync(log, 'utf8')
  expect(eventsNamed(transport, 'verify')).toHaveLength(1)
  expect((eventsNamed(transport, 'verify')[0]?.data as { ok: boolean }).ok).toBe(true)

  // A second turn that calls no write tool at all must leave the log untouched.
  await host.handle({ id: 3, method: 'send', params: { text: 'and now just answer' } })
  expect(readFileSync(log, 'utf8')).toBe(afterWrite)
  expect(eventsNamed(transport, 'verify')).toHaveLength(1)
  await host.shutdown()
}, 30_000)

/**
 * Verify, once a workspace is several folders.
 *
 * The gate that matters here is the same one as above, one level finer: running every
 * folder's suite after a one-line edit in one of them turns a thirty-second turn into three
 * minutes, and the folders nothing touched cannot have been broken.
 */
test('verify runs only in the folder that was written', async () => {
  let call = 0
  const fake = await makeServer((_body, _streaming) => {
    call++
    if (call === 1) return toolCallSSE('write_file', JSON.stringify({ path: 'engine/x.txt', content: 'x' }))
    return textSSE('done')
  })
  stop = fake.close
  const root = newWorkspace()
  const engine = join(root, '..', `${basename(root)}-engine`)
  mkdirSync(engine, { recursive: true })
  workspaces.push(engine)
  mkdirSync(join(root, '.privatecode'), { recursive: true })
  writeFileSync(
    join(root, '.privatecode', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['write_file(**)'] } }),
    'utf8',
  )
  // Both commands are observable by what they leave behind, in their own folder.
  writeFileSync(
    join(root, '.privatecode', 'workspace.json'),
    JSON.stringify({
      version: 1,
      folders: [{ path: engine, name: 'engine', access: 'write' }],
      profile: {
        verify: {
          [basename(root)]: 'Write-Output ran >> primary-verified.log',
          engine: 'Write-Output ran >> engine-verified.log',
        },
      },
    }),
    'utf8',
  )

  const { host, transport } = await initHost(fake.url, root)
  await host.handle({ id: 2, method: 'send', params: { text: 'write into the engine folder' } })

  expect(existsSync(join(engine, 'engine-verified.log'))).toBe(true)
  expect(existsSync(join(root, 'primary-verified.log'))).toBe(false)
  const fired = eventsNamed(transport, 'verify')
  expect(fired).toHaveLength(1)
  expect((fired[0]?.data as { folder?: string }).folder).toBe('engine')
  await host.shutdown()
}, 30_000)

/**
 * A turn that fills the window makes room and carries on.
 *
 * Compaction used to be possible only BETWEEN turns, because it replaces the transcript
 * object while a running Agent holds a reference to the old one. So a single turn long
 * enough to fill the context by itself had no way out: it ran until llama.cpp refused the
 * request, and the refusal ended it. With the step ceiling gone, that turn is exactly the
 * turn this tool is for.
 */
test('a long turn compacts between its own steps instead of dying on a full window', async () => {
  // Sized against the real thresholds rather than round numbers: the pre-turn check is
  // skipped below (TOOL_SCHEMA_TOKENS + PRE_TURN_HEADROOM) * 4 = 26 400, so the window has
  // to be bigger than that for the check to run at all.
  const CONTEXT = 40_000
  let streamed = 0
  let compactions = 0
  const fake = await makeServer((_body, streaming) => {
    if (!streaming) {
      compactions++
      return {
        choices: [{
          message: { role: 'assistant', content: 'BRIEFING: what happened so far, in short.' },
          finish_reason: 'stop',
        }],
      }
    }
    streamed++
    // Each working step reports a prompt the server itself measured at nearly the whole
    // window -- that is the ground truth the between-steps check reads -- and carries enough
    // reasoning to be worth summarising. Both are needed: compaction is refused outright
    // when the history it would replace is no bigger than the briefing replacing it, and the
    // first two steps ARE refused for exactly that reason (the big message is still the
    // newest one, and the tail keeps what is recent). By the third there is a middle.
    if (streamed <= 3) {
      const body =
        sseFrame({ choices: [{ delta: { reasoning_content: 'x'.repeat(60_000) } }] }) +
        sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${streamed}`, type: 'function', function: { name: 'list_dir', arguments: '' } }] } }] }) +
        // A different path each time: three identical calls in a row is what the loop
        // detector is for, and tripping it would prove nothing about compaction.
        sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: `d${streamed}` }) } }] } }] }) +
        sseFrame({ choices: [{ finish_reason: 'tool_calls', delta: {} }], timings: {} }) +
        // The step that runs on the freshly compacted transcript reports what such a step
        // really would: a much smaller prompt. Left at 38 000 it re-triggers the check and
        // the turn compacts twice -- which works, and is the fake being untruthful rather
        // than anything under test.
        sseFrame({ choices: [], usage: { prompt_tokens: streamed <= 2 ? 38_000 : 9_000, completion_tokens: 20 } }) +
        SSE_DONE
      return new RawResponse(200, body, 'text/event-stream')
    }
    return textSSE('finished after making room', { prompt_tokens: 900, completion_tokens: 5 })
  }, CONTEXT)
  stop = fake.close
  const root = newWorkspace()
  for (const d of ['d1', 'd2', 'd3']) mkdirSync(join(root, d))
  const { host, transport } = await initHost(fake.url, root)

  await host.handle({ id: 2, method: 'send', params: { text: 'do something long' } })

  // It compacted, and it compacted DURING the turn -- there was only ever one turn.
  const states = eventsNamed(transport, 'compaction').map((e) => (e.data as { state: string }).state)
  expect(compactions).toBe(1)
  expect(states).toContain('started')
  expect(states).toContain('applied')

  // And the turn finished on its own terms rather than being ended by the window.
  const done = eventsNamed(transport, 'turn.done')
  expect(done).toHaveLength(1)
  expect((done[0]!.data as { stoppedBecause: string }).stoppedBecause).toBe('done')

  // The proof that the swap reached the running turn: the step after it was sent the
  // briefing, which only exists in the transcript compaction built.
  const lastChat = fake.requests.filter((r: any) => r.body.messages).at(-1)
  const sent = (lastChat as any).body.messages as { content: string | null }[]
  expect(sent.some((m) => m.content?.includes('BRIEFING: what happened so far'))).toBe(true)
})

/**
 * A tool call reaches the window while it is being written, not only once it is whole.
 *
 * On a large edit the model spends most of the step generating the argument. Until this
 * existed the fragments were accumulated in the client and reported to nobody, so the window
 * had nothing to show for that time — the longest silence in a normal turn, and the one the
 * user described as the chat freezing.
 */
test('the arguments of a tool call are streamed as they are generated', async () => {
  let call = 0
  const fake = await makeServer(() => {
    call++
    if (call > 1) return textSSE('done')
    // Deliberately in pieces, the way a real generation arrives: the id and name once, then
    // the argument a fragment at a time.
    const body =
      sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '' } }] } }] }) +
      sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }) +
      sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"note' } }] } }] }) +
      sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.txt"}' } }] } }] }) +
      sseFrame({ choices: [{ finish_reason: 'tool_calls', delta: {} }], timings: {} }) +
      SSE_DONE
    return new RawResponse(200, body, 'text/event-stream')
  })
  stop = fake.close
  const root = newWorkspace()
  writeFileSync(join(root, 'note.txt'), 'hello', 'utf8')
  const { host, transport } = await initHost(fake.url, root)

  await host.handle({ id: 2, method: 'send', params: { text: 'read the note' } })

  const deltas = eventsNamed(transport, 'tool.call.delta')
    .map((e) => e.data as { index: number; name?: string; args?: string })

  // The name comes first and alone -- that is what lets the window open a row before any of
  // the argument exists.
  expect(deltas[0]).toEqual({ index: 0, name: 'read_file' })
  // Every fragment, in order, and together they are the call.
  expect(deltas.slice(1).map((d) => d.args).join('')).toBe('{"path":"note.txt"}')
  expect(deltas.slice(1).every((d) => d.name === undefined)).toBe(true)

  // And the finished call still arrives, carrying the assembled document the tool ran on.
  const calls = eventsNamed(transport, 'tool.call').map((e) => e.data as { name: string; args: string })
  expect(calls).toEqual([{ name: 'read_file', args: '{"path":"note.txt"}' }])
})
