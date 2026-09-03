import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvents, type AgentOptions } from '../src/agent/loop.js'
import { LoopDetector } from '../src/agent/loop-detector.js'
import { LlamaClient } from '../src/llama/client.js'
import { PermissionEngine } from '../src/permissions/engine.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { editFileTool } from '../src/tools/edit-file.js'
import { runCommandTool } from '../src/tools/run-command.js'
import { Workspace } from '../src/workspace.js'
import { RawResponse, startFakeServer, TrickleResponse } from './fake-server.js'
import type { InteractionPort } from '../src/interaction.js'
import type { Tool } from '../src/tools/types.js'

let stop: (() => Promise<void>) | undefined
const workspaces: string[] = []

afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let pingCalls = 0
let boomCalls = 0
beforeEach(() => { pingCalls = 0; boomCalls = 0 })

const ping: Tool<{ value: string }> = {
  name: 'ping',
  readOnly: true,
  description: 'ping',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  validate: (raw) => {
    const v = (raw as any)?.value
    return typeof v === 'string' && v.trim() !== ''
      ? { ok: true, args: { value: v } }
      : { ok: false, error: 'value must be non-empty' }
  },
  execute: async (args) => { pingCalls++; return { ok: true, content: `pong:${args.value}` } },
}

/** Stands in for a write tool: running it at all is the damage. */
const boom: Tool<Record<string, never>> = {
  name: 'boom',
  readOnly: false,
  description: 'has a side effect',
  parameters: { type: 'object', properties: {} },
  validate: () => ({ ok: true, args: {} }),
  execute: async () => { boomCalls++; return { ok: true, content: 'BOOM' } },
}

function toolCallResponse(name: string, args: string, content: string | null = null) {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content, reasoning_content: 'brief',
        tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: args } }],
      },
    }],
    usage: { completion_tokens: 30 },
  }
}

function twoToolCallResponse() {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'ping', arguments: '{"value":"a"}' } },
          { id: 'c2', type: 'function', function: { name: 'ping', arguments: '{"value":"b"}' } },
        ],
      },
    }],
    usage: { completion_tokens: 30 },
  }
}

function truncatedResponse(reasoning = 'x'.repeat(50)) {
  return {
    choices: [{
      finish_reason: 'length',
      message: { role: 'assistant', content: null, reasoning_content: reasoning },
    }],
    usage: { completion_tokens: 4000 },
  }
}

function textResponse(text: string) {
  return {
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { completion_tokens: 10 },
  }
}

/** A request the server accepts and never answers. */
function hang() {
  return new Promise<never>(() => {})
}

type ExtraOptions = Partial<Omit<AgentOptions, 'client' | 'registry' | 'context'>>

function makeAgent(url: string, extra: ExtraOptions = {}, alsoRegister: Tool<any>[] = []) {
  const registry = new ToolRegistry()
  registry.register(ping)
  registry.register(boom)
  for (const t of alsoRegister) registry.register(t)
  const root = mkdtempSync(join(tmpdir(), 'pc-loop-'))
  workspaces.push(root)
  return new Agent({
    // A short `/slots` budget so the unreachable path can be exercised in a test rather than
    // waited out: the shipped default is 8 s, sized against a real decode batch.
    client: new LlamaClient({ baseUrl: url, model: 'm', slotsTimeoutMs: 300 }),
    registry,
    context: { workspace: new Workspace(root) },
    maxSteps: 5,
    // No test wants to wait out the production 20 s recheck; the ones that are ABOUT the
    // recheck set their own, because `extra` spreads after this.
    prefillRecheckMs: 100,
    ...extra,
  })
}

type Recorded = [string, ...unknown[]]

function recorder() {
  const events: Recorded[] = []
  const handlers: AgentEvents = {
    onStepStart: (i) => { events.push(['stepStart', i]) },
    onThinking: (t) => { events.push(['thinking', t]) },
    onContinuation: (s) => { events.push(['continuation', s]) },
    onStepRetry: () => { events.push(['stepRetry']) },
    onToolCall: (n, a) => { events.push(['toolCall', n, a]) },
    onToolResult: (n, r) => { events.push(['toolResult', n, r]) },
    onAssistantText: (t) => { events.push(['assistantText', t]) },
    onStepDone: (i) => { events.push(['stepDone', i]) },
  }
  return {
    events,
    handlers,
    names: () => events.map((e) => e[0]),
    of: (name: string) => events.filter((e) => e[0] === name).map((e) => e[1]),
  }
}

test('a tool that produces live output reaches the host through onToolOutput', async () => {
  // The chain behind the live console pane: tool -> ctx.onLiveOutput -> AgentEvents ->
  // (host) tool.output event. Wired only when a host listens; the tool result stays the
  // authoritative record either way.
  const chunks: [string, string][] = []
  const chatty: Tool<Record<string, never>> = {
    name: 'chatty',
    readOnly: true,
    description: 'emits output over time',
    parameters: { type: 'object', properties: {} },
    validate: () => ({ ok: true, args: {} }),
    execute: async (_args, ctx) => {
      ctx.onLiveOutput?.('line 1\n')
      ctx.onLiveOutput?.('line 2\n')
      return { ok: true, content: 'line 1\nline 2\n' }
    },
  }
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    return n === 1 ? toolCallResponse('chatty', '{}') : textResponse('done')
  })
  stop = fake.close
  const agent = makeAgent(fake.url, {
    events: { onToolOutput: (name, text) => { chunks.push([name, text]) } },
  }, [chatty])
  const result = await agent.runTurn('go')
  expect(result.stoppedBecause).toBe('done')
  expect(chunks).toEqual([['chatty', 'line 1\n'], ['chatty', 'line 2\n']])
})

test('a silent step survives while /slots shows the prefill moving', async () => {
  // Watched live: a server-side cache eviction made the next turn re-prefill ~187k tokens
  // for nine minutes — pure silence to the client — and the step died against a window
  // sized from the few hundred chars THIS process had appended. The clock now asks the
  // server before killing a first-token wait: growing n_prompt_tokens_processed means the
  // silence is prefill, and the window re-arms.
  let slotPolls = 0
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/slots') {
      slotPolls++
      return [{ is_processing: true, n_prompt_tokens_processed: slotPolls * 1000 }]
    }
    return new Promise((resolve) => setTimeout(() => resolve(textResponse('after long prefill')), 6500))
  })
  stop = fake.close
  const result = await makeAgent(fake.url, {
    stepTimeoutMs: 200, firstStepTimeoutMs: 200, prefillRecheckMs: 200,
  }).runTurn('hi')
  expect(result.stoppedBecause).toBe('done')
  expect(result.finalText).toBe('after long prefill')
  expect(slotPolls).toBeGreaterThan(0)
})

test('a stalled prefill still times out instead of waiting forever', async () => {
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/slots') {
      // Processing, but the counter never moves: whatever the server is doing, it is not
      // working through our prompt — the guard must not be extendable by mere liveness.
      return [{ is_processing: true, n_prompt_tokens_processed: 500 }]
    }
    return hang()
  })
  stop = fake.close
  const result = await makeAgent(fake.url, { stepTimeoutMs: 200, firstStepTimeoutMs: 200, prefillRecheckMs: 150 }).runTurn('hi')
  expect(result.stoppedBecause).toBe('timeout')
})

test('a request the server died under is retried once health returns', async () => {
  // Watched live: llama.cpp dies on a VRAM spike mid-generation, the watchdog relaunches
  // it in ~20-30 s, and before this retry existed the whole turn ended on "stream read
  // error (TypeError: terminated)" for an outage the server had already recovered from.
  let n = 0
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/health') return { status: 'ok' }
    n++
    return n === 1 ? new RawResponse(500, 'CUDA error: out of memory', 'text/plain') : textResponse('survived')
  })
  stop = fake.close
  const rec = recorder()
  const result = await makeAgent(fake.url, { events: rec.handlers }).runTurn('hello')
  expect(result.stoppedBecause).toBe('done')
  expect(result.finalText).toBe('survived')
  expect(n).toBe(2)
  // The renderer is told the dead attempt's partials are superseded BEFORE the re-send —
  // without this the retry's stream appends onto the dead attempt's open cards.
  expect(rec.names()).toContain('stepRetry')
})

test('a cancel while that retry waits for the server ends the turn instead of throwing', async () => {
  // The user's side of the same outage. The window has been frozen for however long the
  // relaunch takes, so pressing Esc inside the wait is the likeliest cancel there is —
  // and `waitHealthy` reports an abort as `false`, the same answer it gives for "the
  // budget ran out". The turn used to fall through to a raw throw that escaped runStep,
  // runTurn and Session.send: no `turn.done` was ever emitted and the window showed
  // "stream read error (TypeError: terminated)" for a turn the user had cancelled.
  const abort = new AbortController()
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/health') {
      // Esc, mid-wait. The server is still down, so this probe fails as well.
      abort.abort()
      return new RawResponse(503, 'loading model', 'text/plain')
    }
    // A stream that dies mid-thought: one frame, then the connection ends without ever
    // sending a finish_reason — what a llama.cpp process killed by a VRAM spike leaves.
    return new TrickleResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'half a thought' } }] })}\n\n`,
    ], 1)
  })
  stop = fake.close
  const agent = makeAgent(fake.url, {
    signal: abort.signal,
    events: { onThinkingDelta: () => {} },
  })

  const result = await agent.runTurn('go')

  expect(result.stoppedBecause).toBe('aborted')
  // And the dead attempt's thinking is kept, exactly as on every other cancel path: the
  // turn ends with what the model had said, marked as unfinished.
  const last = agent.transcript.messages().at(-1)!
  expect(last.reasoning_content).toBe('half a thought')
  expect(last.content).toMatch(/interrupted by the user/)
})

test('executes a tool call, feeds the result back, then finishes', async () => {
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    return n === 1 ? toolCallResponse('ping', '{"value":"a"}') : textResponse('all done')
  })
  stop = fake.close
  const agent = makeAgent(fake.url)

  const result = await agent.runTurn('do the thing')

  expect(result.stoppedBecause).toBe('done')
  expect(result.finalText).toBe('all done')
  const toolMessage = fake.requests[1].body.messages.find((m: any) => m.role === 'tool')
  expect(toolMessage.content).toBe('pong:a')
})

// finish_reason "length" means thinking ran long, not that the step failed.
test('continues a truncated step instead of failing it', async () => {
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    if (n === 1) return truncatedResponse()
    if (n === 2) return toolCallResponse('ping', '{"value":"b"}')
    return textResponse('finished after continuing')
  })
  stop = fake.close
  const agent = makeAgent(fake.url)

  const result = await agent.runTurn('hard task')

  expect(result.stoppedBecause).toBe('done')
  // The continuation must force an action.
  expect(fake.requests[1].body.tool_choice).toBe('required')
})

test('a failed tool result is reported to the model rather than thrown', async () => {
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    if (n === 1) return toolCallResponse('ping', '{"value":"  "}')
    return textResponse('recovered')
  })
  stop = fake.close
  const agent = makeAgent(fake.url)

  await agent.runTurn('go')

  const toolMessage = fake.requests[1].body.messages.find((m: any) => m.role === 'tool')
  expect(toolMessage.content).toMatch(/must be non-empty/)
})

test('stops at maxSteps instead of looping forever', async () => {
  const fake = await startFakeServer(() => toolCallResponse('ping', '{"value":"x"}'))
  stop = fake.close
  const agent = makeAgent(fake.url)

  const result = await agent.runTurn('loop please')

  expect(result.stoppedBecause).toBe('max_steps')
  expect(result.steps).toBe(5)
})

test('the transcript is never rewritten between steps', async () => {
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    return n === 1 ? toolCallResponse('ping', '{"value":"a"}') : textResponse('done')
  })
  stop = fake.close
  const agent = makeAgent(fake.url)

  await agent.runTurn('go')

  const first = fake.requests[0].body.messages
  const second = fake.requests[1].body.messages
  // Every message of the first request must still be present, unchanged, and in order.
  expect(second.slice(0, first.length)).toEqual(first)
})

// ---------------------------------------------------------------------------
// Truncation policy
// ---------------------------------------------------------------------------

// The median hard edit truncates (docs/DESIGN.md: 5591 tokens median thinking at
// tool_choice auto, against a 4000-token budget), so the continuation is the normal
// path, not a tail case. A continuation that truncates again did nothing at all and
// must never be reported as a completed turn.
test('a continuation that truncates again fails the turn instead of reporting success', async () => {
  const fake = await startFakeServer(() => truncatedResponse())
  stop = fake.close
  const agent = makeAgent(fake.url)

  const result = await agent.runTurn('hard task')

  expect(result.stoppedBecause).toBe('truncated')
  expect(result.steps).toBe(1)
  // Two generations, then stop: no third attempt, and no silent 'done'.
  expect(fake.requests.length).toBe(2)
  expect(result.finalText).not.toBe('')
  const last = agent.transcript.messages().at(-1)!
  expect(last.role).toBe('user')
  expect(last.content).toMatch(/twice in a row/i)
  expect(last.content).toMatch(/nothing was done/i)
})

// The partial reasoning is thrown away today, so the model re-thinks from zero and the
// comment claiming the continuation is cheap is false.
test('the truncated assistant turn enters the transcript before the nudge', async () => {
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    if (n === 1) return truncatedResponse('half a thought')
    if (n === 2) return toolCallResponse('ping', '{"value":"b"}')
    return textResponse('done')
  })
  stop = fake.close
  const agent = makeAgent(fake.url)

  await agent.runTurn('hard task')

  const first = fake.requests[0].body.messages
  const second = fake.requests[1].body.messages
  // Still append-only.
  expect(second.slice(0, first.length)).toEqual(first)
  expect(second.length).toBe(first.length + 2)
  expect(second[first.length]).toEqual({
    role: 'assistant', content: null, reasoning_content: 'half a thought',
  })
  expect(second[first.length + 1].role).toBe('user')
})

// ---------------------------------------------------------------------------
// Per-step deadline
// ---------------------------------------------------------------------------

test('a step that outlives its wall-clock ceiling ends the turn as a timeout', async () => {
  const fake = await startFakeServer(hang)
  stop = fake.close
  const rec = recorder()
  const agent = makeAgent(fake.url, { stepTimeoutMs: 300, events: rec.handlers })

  const started = Date.now()
  const result = await agent.runTurn('go silent')
  const elapsed = Date.now() - started

  expect(result.stoppedBecause).toBe('timeout')
  expect(elapsed).toBeLessThan(5_000)
  // Task 12 renders a countdown, so the budget must be known at step *start*.
  expect(rec.of('stepStart')[0]).toMatchObject({ step: 1, timeoutMs: 300 })
  const last = agent.transcript.messages().at(-1)!
  expect(last.content).toMatch(/time limit/i)
})

/**
 * The step budget measures SILENCE, not elapsed time.
 *
 * Both of these are the same defect from the two sides. It reached the live model first: with
 * one call per step the two readings were close enough that nothing showed, and then a step
 * started carrying several calls. Measured, three runs of "create four thorough ~100-line
 * files": the model batched all four into one generation and every run died on the 90 s
 * ceiling having written NOTHING, while the same task under one-call-per-step finished 3/3 in
 * 166 s. The turn was killed for producing too much, too fast, in one piece.
 */
function sseFrames(chunks: number): string[] {
  const frames = Array.from({ length: chunks }, () =>
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'still going. ' } }] })}\n\n`)
  frames.push(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: { content: 'done' } }] })}\n\n`)
  frames.push('data: [DONE]\n\n')
  return frames
}

test('a step that keeps streaming is not killed for taking a long time', async () => {
  // Ten frames 120 ms apart is 1.2 s of work against a 400 ms budget — three times over, if
  // the budget were elapsed time. Every individual gap is well inside it, so nothing here is
  // ever silent for 400 ms, and the step must finish.
  const fake = await startFakeServer(() => new TrickleResponse(sseFrames(10), 120))
  stop = fake.close
  const agent = makeAgent(fake.url, {
    stepTimeoutMs: 400,
    // Streaming is opt-in on a delta callback being present at all — without one the loop
    // calls the non-streaming `chat()`, which has no deltas to re-arm from and would make
    // this test pass for the wrong reason.
    events: { onThinkingDelta: () => {} },
  })

  const started = Date.now()
  const result = await agent.runTurn('write four large files')
  const elapsed = Date.now() - started

  expect(result.stoppedBecause).toBe('done')
  expect(elapsed).toBeGreaterThan(800)
})

test('the wait for a first token allows for prefilling what was just appended', async () => {
  // The gap before a step's FIRST token is not idleness: llama.cpp reuses its cache by
  // longest common prefix, so everything appended since the last request has to be processed
  // before a token can appear. That is work with a knowable length.
  //
  // Found live, not reasoned about. A step batched three ~15k-token file reads; the NEXT step
  // had to prefill 46k new tokens — 116-185 s at the measured 2.5-4 ms each — against a flat
  // 90 s, and the turn died with the model perfectly healthy. Same shape had been eating the
  // budget for a while: one 15k-token read already cost 58.8 s of the 90.
  //
  // Here: a tool returning 400 KB (~100k tokens by the chars/4 rule) buys ~400 s of extra
  // room for the step that follows it, so a first token that takes 700 ms lands comfortably
  // even though the flat budget is 250 ms.
  const bulky: Tool<Record<string, never>> = {
    name: 'bulky',
    readOnly: true,
    description: 'returns a great deal of text',
    parameters: { type: 'object', properties: {} },
    validate: () => ({ ok: true, args: {} }),
    execute: async () => ({ ok: true, content: 'x'.repeat(400_000) }),
  }
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    if (n === 1) {
      // Answered instantly, so the FIRST step is never the one under test.
      return new TrickleResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'b1', type: 'function', function: { name: 'bulky', arguments: '{}' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }] })}\n\n`,
        'data: [DONE]\n\n',
      ], 1)
    }
    // The step after the bulky result: 700 ms before the first frame, which is what
    // prefilling 100k tokens looks like from here.
    return new TrickleResponse([
      `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: { content: 'done' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ], 700)
  })
  stop = fake.close
  const agent = makeAgent(
    fake.url,
    { stepTimeoutMs: 250, events: { onThinkingDelta: () => {} } },
    [bulky],
  )

  const result = await agent.runTurn('read the big thing')

  expect(result.stoppedBecause).toBe('done')
})

test('a step that goes quiet mid-stream is still abandoned', async () => {
  // The other half, and the reason the budget exists at all. A server that streams a little
  // and then stops answering must not hold the turn open until the client's ten-minute
  // transport timeout — and re-arming on deltas would do exactly that if the clock were only
  // ever pushed forward and never allowed to fire.
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'starting' } }] })}\n\n`,
  ]
  const fake = await startFakeServer(async () => {
    // Two frames' worth of gap, then nothing: the promise never settles, so the connection
    // stays open and quiet.
    return new TrickleResponse(frames, 100_000)
  })
  stop = fake.close
  const agent = makeAgent(fake.url, {
    stepTimeoutMs: 300,
    events: { onThinkingDelta: () => {} },
  })

  const started = Date.now()
  const result = await agent.runTurn('go quiet after one token')
  const elapsed = Date.now() - started

  expect(result.stoppedBecause).toBe('timeout')
  expect(elapsed).toBeLessThan(5_000)
})

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

// A step lasts 35-40 s, so a cancel button lands *inside* a call, never between steps.
test('an abort during a model call returns aborted rather than throwing', async () => {
  const fake = await startFakeServer(hang)
  stop = fake.close
  const controller = new AbortController()
  const agent = makeAgent(fake.url, { signal: controller.signal })
  setTimeout(() => controller.abort(), 50)

  const result = await agent.runTurn('cancel me')

  expect(result.stoppedBecause).toBe('aborted')
  expect(result.steps).toBe(0)
})

test('an already-aborted turn leaves the transcript untouched', async () => {
  const fake = await startFakeServer(() => textResponse('never asked'))
  stop = fake.close
  const controller = new AbortController()
  controller.abort()
  const agent = makeAgent(fake.url, { signal: controller.signal })
  const before = agent.transcript.messages().length

  const result = await agent.runTurn('go')

  expect(result.stoppedBecause).toBe('aborted')
  expect(agent.transcript.messages().length).toBe(before)
  expect(fake.requests.length).toBe(0)
})

// ---------------------------------------------------------------------------
// tool_choice
// ---------------------------------------------------------------------------

test('the first call of a step follows AgentOptions.toolChoice, defaulting to auto', async () => {
  const fake = await startFakeServer(() => textResponse('done'))
  stop = fake.close

  await makeAgent(fake.url).runTurn('go')
  await makeAgent(fake.url, { toolChoice: 'required' }).runTurn('go')

  expect(fake.requests[0].body.tool_choice).toBe('auto')
  expect(fake.requests[1].body.tool_choice).toBe('required')
})

// ---------------------------------------------------------------------------
// The default step budget
// ---------------------------------------------------------------------------

// docs/DESIGN.md §7 measured median thinking on a hard edit at 5591 tokens under exactly
// the tool_choice the Agent defaults to ('auto'), with one run reaching 6119. A default
// budget of 4000 therefore guaranteed the median hard edit truncated, and the branch then
// carried a whole truncation-continuation path to recover from a failure the default
// itself had chosen. The default has to clear the measured median, not sit under it.
test('the default per-step token budget clears the measured median hard edit', async () => {
  const fake = await startFakeServer(() => textResponse('done'))
  stop = fake.close

  await makeAgent(fake.url).runTurn('go')

  expect(fake.requests[0].body.max_tokens).toBe(8000)
  expect(fake.requests[0].body.max_tokens).toBeGreaterThan(6119)
})

test('an explicit maxTokensPerStep still wins over the default', async () => {
  const fake = await startFakeServer(() => textResponse('done'))
  stop = fake.close

  await makeAgent(fake.url, { maxTokensPerStep: 512 }).runTurn('go')

  expect(fake.requests[0].body.max_tokens).toBe(512)
})

// ---------------------------------------------------------------------------
// The tool context the Agent hands to tools
// ---------------------------------------------------------------------------

// Grep already wires `cancelSignal: ctx.signal`, and Glob' traversal is
// unbounded, but the Agent passed `this.opts.context` through untouched — so `ctx.signal`
// was undefined for every tool call ever made and that whole branch was dead code. A
// 30 s ripgrep and an unbounded walk both ignored the user's cancel.
test('the turn signal reaches the tool context', async () => {
  let seen: AbortSignal | undefined
  let abortedDuringCall: boolean | undefined
  const probe: Tool<Record<string, never>> = {
    name: 'probe',
    readOnly: false,
    description: 'records the context it was handed',
    parameters: { type: 'object', properties: {} },
    validate: () => ({ ok: true, args: {} }),
    execute: async (_args, ctx) => {
      seen = ctx.signal
      abortedDuringCall = ctx.signal?.aborted
      return { ok: true, content: 'probed' }
    },
  }
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    return n === 1 ? toolCallResponse('probe', '{}') : textResponse('done')
  })
  stop = fake.close
  const controller = new AbortController()
  const agent = makeAgent(fake.url, { signal: controller.signal }, [probe])

  await agent.runTurn('go')

  expect(seen).toBeInstanceOf(AbortSignal)
  expect(abortedDuringCall).toBe(false)
  // It is the *turn's* cancel, not some unrelated signal: cancelling the turn cancels
  // what the tool was given.
  controller.abort()
  expect(seen!.aborted).toBe(true)
})

test('a turn with no signal leaves the tool context alone', async () => {
  let seen: unknown = 'never ran'
  const probe: Tool<Record<string, never>> = {
    name: 'probe',
    readOnly: false,
    description: 'records the context it was handed',
    parameters: { type: 'object', properties: {} },
    validate: () => ({ ok: true, args: {} }),
    execute: async (_args, ctx) => {
      seen = ctx.signal
      return { ok: true, content: 'probed' }
    },
  }
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    return n === 1 ? toolCallResponse('probe', '{}') : textResponse('done')
  })
  stop = fake.close

  await makeAgent(fake.url, {}, [probe]).runTurn('go')

  expect(seen).toBeUndefined()
})

// ---------------------------------------------------------------------------
// allowedTools is a safety guarantee, not a hint
// ---------------------------------------------------------------------------

test('a tool outside allowedTools is refused before it runs', async () => {
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    return n === 1 ? toolCallResponse('boom', '{}') : textResponse('understood')
  })
  stop = fake.close
  const agent = makeAgent(fake.url, { allowedTools: ['ping'], mode: 'plan' })

  await agent.runTurn('please edit something')

  expect(boomCalls).toBe(0)
  const toolMessage = fake.requests[1].body.messages.find((m: any) => m.role === 'tool')
  expect(toolMessage.name).toBe('boom')
  expect(toolMessage.content).toMatch(/not available/i)
})

// ---------------------------------------------------------------------------
// Plan mode cannot be constructed unsafely
//
// A reviewer demonstrated that `mode: 'plan'` alone restricted nothing: only
// `allowedTools` filtered the schemas and gated the runtime backstop, and nothing forced
// a plan-mode caller to pass it. These pin the fix: the constructor derives the
// restriction itself from the registry's `readOnly` declarations, so there is no call
// site left that can omit, forget, or widen it.
// ---------------------------------------------------------------------------

test('mode: "plan" alone, with no allowedTools passed, still refuses a mutating tool', async () => {
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    return n === 1 ? toolCallResponse('boom', '{}') : textResponse('understood')
  })
  stop = fake.close
  const agent = makeAgent(fake.url, { mode: 'plan' })

  await agent.runTurn('please edit something')

  expect(boomCalls).toBe(0)
  const toolMessage = fake.requests[1].body.messages.find((m: any) => m.role === 'tool')
  expect(toolMessage.name).toBe('boom')
  expect(toolMessage.content).toMatch(/not available/i)
})

// The schema-level defence matters as much as the runtime refusal: llama.cpp builds its
// constraint grammar from what is offered, so a mutating tool must never even be listed.
test('mode: "plan" alone never offers a mutating tool\'s schema to the model', async () => {
  const fake = await startFakeServer(() => textResponse('done'))
  stop = fake.close
  const agent = makeAgent(fake.url, { mode: 'plan' })

  await agent.runTurn('look around')

  const names = fake.requests[0].body.tools.map((t: any) => t.function.name)
  expect(names).toEqual(['ping'])
})

// A caller cannot widen plan mode by naming a mutating tool explicitly either: the
// registry's readOnly declarations are a ceiling, not a grant.
test('plan mode narrows an explicit allowedTools list down to its readOnly members', async () => {
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    return n === 1 ? toolCallResponse('boom', '{}') : textResponse('understood')
  })
  stop = fake.close
  const agent = makeAgent(fake.url, { mode: 'plan', allowedTools: ['ping', 'boom'] })

  await agent.runTurn('please edit something')

  expect(boomCalls).toBe(0)
  const names = fake.requests[0].body.tools.map((t: any) => t.function.name)
  expect(names).toEqual(['ping'])
})

// ---------------------------------------------------------------------------
// Transcript shape
// ---------------------------------------------------------------------------

// A strict OpenAI endpoint rejects an assistant turn whose tool_calls are not all
// answered; llama.cpp tolerates it, which is why this went unnoticed.
test('every tool call carried forward is answered, and every one of them ran', async () => {
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    return n === 1 ? twoToolCallResponse() : textResponse('ok')
  })
  stop = fake.close
  const agent = makeAgent(fake.url)

  await agent.runTurn('go')

  const messages = fake.requests[1].body.messages
  const assistant = messages.find((m: any) => m.role === 'assistant')
  const answered = messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id)
  expect(answered).toEqual((assistant.tool_calls ?? []).map((c: any) => c.id))
  // Both ran. This used to run the first and refuse the second, which cost a whole extra
  // step per discarded call — measured at ~23% of a 13-step turn.
  expect(pingCalls).toBe(2)
  const replies = messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content)
  expect(replies).toEqual(['pong:a', 'pong:b'])
})

test('the calls of one step run in the order the model wrote them', async () => {
  // Not incidental: a model that proposes `Write config.ts` then `Bash "npm
  // test"` means those in that order, and the results are fed back as one block with no
  // ordering information of their own beyond their position.
  const order: string[] = []
  const noting: Tool<{ tag: string }> = {
    name: 'noting',
    readOnly: true,
    description: 'records the order it was called in',
    parameters: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] },
    validate: (raw) => ({ ok: true, args: { tag: String((raw as any)?.tag) } }),
    execute: async (args) => { order.push(args.tag); return { ok: true, content: args.tag } },
  }
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    if (n > 1) return textResponse('ok')
    return {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant', content: null,
          tool_calls: ['first', 'second', 'third'].map((tag, i) => ({
            id: `c${i}`, type: 'function',
            function: { name: 'noting', arguments: JSON.stringify({ tag }) },
          })),
        },
      }],
      usage: { completion_tokens: 30 },
    }
  })
  stop = fake.close
  const agent = makeAgent(fake.url, {}, [noting])

  await agent.runTurn('go')

  expect(order).toEqual(['first', 'second', 'third'])
  const replies = fake.requests[1].body.messages
    .filter((m: any) => m.role === 'tool')
    .map((m: any) => [m.tool_call_id, m.content])
  expect(replies).toEqual([['c0', 'first'], ['c1', 'second'], ['c2', 'third']])
})

test('a step stops at its first failed call and answers the rest without running them', async () => {
  // The reason one-call-per-step was ever right: the model should see a failure before more
  // actions land. Three edits generated from the same information need no such ordering, but
  // once one of them fails, what the next ones SHOULD be has changed — so they are answered
  // rather than run, and the model re-issues whichever still apply.
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    if (n > 1) return textResponse('ok')
    return {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant', content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'ping', arguments: '{"value":"a"}' } },
            // Fails validation: `value` must be non-empty.
            { id: 'c2', type: 'function', function: { name: 'ping', arguments: '{"value":"  "}' } },
            { id: 'c3', type: 'function', function: { name: 'boom', arguments: '{}' } },
          ],
        },
      }],
      usage: { completion_tokens: 30 },
    }
  })
  stop = fake.close
  const agent = makeAgent(fake.url)

  await agent.runTurn('go')

  // The first ran, the second ran and failed, the third never executed at all.
  expect(pingCalls).toBe(1)
  expect(boomCalls).toBe(0)

  const messages = fake.requests[1].body.messages
  const byId = new Map(
    messages.filter((m: any) => m.role === 'tool').map((m: any) => [m.tool_call_id, m.content]),
  )
  expect(byId.get('c1')).toBe('pong:a')
  expect(byId.get('c2')).toMatch(/must be non-empty/)
  // The prefix `commandsFrom` and `assumedOk` both read as "this never ran", and it names
  // which call stopped the step so the model is not left guessing.
  expect(byId.get('c3')).toMatch(/^Not run: ping failed earlier in this step/)
  // And every call is still answered — an unanswered tool_call poisons the session.
  expect([...byId.keys()]).toEqual(['c1', 'c2', 'c3'])
})

test('a cancel partway through a step leaves the transcript valid', async () => {
  // Esc lands wherever it lands, and a step running four calls is four times the window it
  // can land in. The remaining calls must not run; they must still be answered, because the
  // turn returns with this transcript and the next `send` will post it.
  const controller = new AbortController()
  const cancelling: Tool<Record<string, never>> = {
    name: 'cancelling',
    readOnly: true,
    description: 'aborts the turn from inside the tool',
    parameters: { type: 'object', properties: {} },
    validate: () => ({ ok: true, args: {} }),
    execute: async () => { controller.abort(); return { ok: true, content: 'cancelled' } },
  }
  const fake = await startFakeServer(() => ({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'cancelling', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'boom', arguments: '{}' } },
        ],
      },
    }],
    usage: { completion_tokens: 30 },
  }))
  stop = fake.close
  const agent = makeAgent(fake.url, { signal: controller.signal }, [cancelling])

  const result = await agent.runTurn('go')

  expect(result.stoppedBecause).toBe('aborted')
  expect(boomCalls).toBe(0)
  const messages = agent.transcript.messages()
  const assistant = messages.find((m) => m.role === 'assistant' && m.tool_calls)!
  const answered = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
  expect(answered).toEqual(assistant.tool_calls!.map((c) => c.id))
  const skipped = messages.find((m) => m.tool_call_id === 'c2')!
  expect(skipped.content).toMatch(/^Not run: the turn was cancelled/)
})

test('hitting maxSteps tells the model and keeps the last assistant prose', async () => {
  const fake = await startFakeServer(
    () => toolCallResponse('ping', '{"value":"x"}', 'still working on it'),
  )
  stop = fake.close
  const agent = makeAgent(fake.url)

  const result = await agent.runTurn('loop please')

  expect(result.stoppedBecause).toBe('max_steps')
  expect(result.finalText).toBe('still working on it')
  const last = agent.transcript.messages().at(-1)!
  expect(last.role).toBe('user')
  expect(last.content).toMatch(/5 steps/)
})

// ---------------------------------------------------------------------------
// The event surface Task 12 consumes
// ---------------------------------------------------------------------------

test('a plain two-step turn emits the whole event surface in order', async () => {
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    return n === 1
      ? toolCallResponse('ping', '{"value":"a"}', 'looking now')
      : textResponse('all done')
  })
  stop = fake.close
  const rec = recorder()
  const agent = makeAgent(fake.url, { events: rec.handlers, stepTimeoutMs: 9_000 })

  await agent.runTurn('go')

  // stepDone closes the generation phase; everything read off that message follows it.
  expect(rec.names()).toEqual([
    'stepStart', 'thinking', 'stepDone', 'assistantText',
    'toolCall', 'toolResult',
    'stepStart', 'stepDone', 'assistantText',
  ])
  // `firstTokenTimeoutMs` is the flat budget plus the prefill allowance for what this step
  // appends, so its exact value tracks prompt sizes; what is stable — and what the UI's
  // countdown depends on — is that it exists and is never smaller than the flat budget.
  const starts = rec.of('stepStart') as { step: number; timeoutMs: number; firstTokenTimeoutMs: number }[]
  expect(starts.map(({ step, timeoutMs }) => ({ step, timeoutMs })))
    .toEqual([{ step: 1, timeoutMs: 9_000 }, { step: 2, timeoutMs: 9_000 }])
  for (const s of starts) expect(s.firstTokenTimeoutMs).toBeGreaterThanOrEqual(s.timeoutMs)
  expect(rec.of('thinking')).toEqual(['brief'])
  // Prose that rides along with a tool call is surfaced too, not only a final answer.
  expect(rec.of('assistantText')).toEqual(['looking now', 'all done'])
  expect(rec.events.find((e) => e[0] === 'toolCall')).toEqual(['toolCall', 'ping', '{"value":"a"}'])
  expect(rec.events.find((e) => e[0] === 'toolResult'))
    .toEqual(['toolResult', 'ping', { ok: true, content: 'pong:a' }])
  const done = rec.of('stepDone') as any[]
  expect(done.map((d) => d.step)).toEqual([1, 2])
  expect(done.map((d) => d.continued)).toEqual([false, false])
  expect(done[0].completionTokens).toBe(30)
  expect(typeof done[0].seconds).toBe('number')
})

// The truncated generation is the median hard step and is currently silent for its
// entire first half: two full generations, one event.
test('a truncated step reports its partial thinking and that it is continuing', async () => {
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    if (n === 1) return truncatedResponse('half a thought')
    if (n === 2) return toolCallResponse('ping', '{"value":"b"}')
    return textResponse('done')
  })
  stop = fake.close
  const rec = recorder()
  const agent = makeAgent(fake.url, { events: rec.handlers })

  await agent.runTurn('hard task')

  expect(rec.names().slice(0, 5)).toEqual([
    'stepStart', 'thinking', 'continuation', 'thinking', 'stepDone',
  ])
  expect(rec.of('thinking').slice(0, 2)).toEqual(['half a thought', 'brief'])
  expect(rec.of('continuation')).toEqual([1])
  // One truncated step is one step, so exactly one stepDone, flagged continued.
  const done = rec.of('stepDone') as any[]
  expect(done[0]).toMatchObject({ step: 1, continued: true })
  expect(done.filter((d) => d.step === 1).length).toBe(1)
})

test('a timed-out step still closes its stepStart', async () => {
  const fake = await startFakeServer(hang)
  stop = fake.close
  const rec = recorder()
  const agent = makeAgent(fake.url, { stepTimeoutMs: 250, events: rec.handlers })

  await agent.runTurn('go silent')

  expect(rec.names()).toEqual(['stepStart', 'stepDone'])
})

// ---------------------------------------------------------------------------
// Residual fixes: Item 1 and Item 2
// ---------------------------------------------------------------------------

// Item 1: finish_reason: 'stop' with empty content should have a fallback like
// the other terminal paths (timeout, truncated, max_steps).
test('finish_reason: stop with empty content returns a fallback, not empty finalText', async () => {
  const fake = await startFakeServer(() => textResponse(''))
  stop = fake.close
  const agent = makeAgent(fake.url)

  const result = await agent.runTurn('go')

  expect(result.stoppedBecause).toBe('done')
  // The fix: should use a fallback message, not empty string
  expect(result.finalText).not.toBe('')
  expect(result.finalText).toMatch(/answer|ended|model stopped|produced/)
})

// Item 2: sub-second timeout budgets should not read as "0 s"
test('sub-second timeout budget formats correctly (not 0 s)', async () => {
  const fake = await startFakeServer(hang)
  stop = fake.close
  const agent = makeAgent(fake.url, { stepTimeoutMs: 400 })

  const result = await agent.runTurn('go silent')

  expect(result.stoppedBecause).toBe('timeout')
  // Should not contain "0 s" for a 400ms budget
  expect(result.finalText).not.toMatch(/\b0\s+s\b/)
  expect(result.finalText).toMatch(/400 ms/)
  // The nudge appended to the transcript is the LAST message, not the second to last:
  // reading at(-2) read back the test's own 'go silent' user message, so hard-coding a
  // `0 s` budget in loop.ts produced the exact text this test is named for and still
  // passed. The nudge is what the model actually sees next, so it is what must be right.
  const last = agent.transcript.messages().at(-1)!
  expect(last.role).toBe('user')
  expect(last.content).toMatch(/time limit/i)
  expect(last.content).toMatch(/400 ms/)
  expect(last.content).not.toMatch(/\b0\s+s\b/)
})

// ---------------------------------------------------------------------------
// Plan 4 Task 8: StepInfo.draftAcceptance
// ---------------------------------------------------------------------------

test('draftAcceptance is draft_n_accepted / draft_n when the server drafted at least one token', async () => {
  const fake = await startFakeServer(() => ({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
    usage: { completion_tokens: 10 },
    timings: { draft_n: 20, draft_n_accepted: 15 },
  }))
  stop = fake.close
  const rec = recorder()
  const agent = makeAgent(fake.url, { events: rec.handlers })

  await agent.runTurn('go')

  const [stepDone] = rec.of('stepDone') as any[]
  expect(stepDone.draftAcceptance).toBeCloseTo(0.75)
})

test('draftAcceptance is absent when draft_n is 0 (no drafting attempted this step)', async () => {
  const fake = await startFakeServer(() => ({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
    usage: { completion_tokens: 10 },
    timings: { draft_n: 0, draft_n_accepted: 0 },
  }))
  stop = fake.close
  const rec = recorder()
  const agent = makeAgent(fake.url, { events: rec.handlers })

  await agent.runTurn('go')

  const [stepDone] = rec.of('stepDone') as any[]
  expect(stepDone.draftAcceptance).toBeUndefined()
})

test('draftAcceptance is absent when the server reports no timings at all', async () => {
  const fake = await startFakeServer(() => textResponse('done'))
  stop = fake.close
  const rec = recorder()
  const agent = makeAgent(fake.url, { events: rec.handlers })

  await agent.runTurn('go')

  const [stepDone] = rec.of('stepDone') as any[]
  expect(stepDone.draftAcceptance).toBeUndefined()
})

test('draftAcceptance is absent when only one of draft_n/draft_n_accepted is present', async () => {
  const fake = await startFakeServer(() => ({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
    usage: { completion_tokens: 10 },
    timings: { draft_n: 20 }, // draft_n_accepted missing
  }))
  stop = fake.close
  const rec = recorder()
  const agent = makeAgent(fake.url, { events: rec.handlers })

  await agent.runTurn('go')

  const [stepDone] = rec.of('stepDone') as any[]
  expect(stepDone.draftAcceptance).toBeUndefined()
})

// --- loop detection, wired ------------------------------------------------------------
//
// The detector's own semantics are unit-tested in loop-detector.test.ts. What is tested
// here is the WIRING, which is where a six-line change goes wrong: that the Agent consults
// it, that it does so before the tool runs, and that the refusal reaches the model as an
// ordinary tool message rather than ending the turn.

test('the third identical call with the same answer is refused instead of run', async () => {
  const fake = await startFakeServer(() => ({
    choices: [{
      message: { role: 'assistant', content: null, tool_calls: [
        { id: 'c', type: 'function', function: { name: 'ping', arguments: '{"value":"same"}' } },
      ] },
      finish_reason: 'tool_calls',
    }],
  }))
  stop = fake.close

  const { handlers, events } = recorder()
  const agent = makeAgent(fake.url, { loopDetector: new LoopDetector(), events: handlers })
  await agent.runTurn('go')

  // Five steps were offered; the tool ran twice and was refused after that.
  expect(pingCalls).toBe(2)
  const results = events.filter(([kind]) => kind === 'toolResult')
  expect(results.length).toBe(5)
  const refusals = results.filter(([, , r]) => (r as { content: string }).content.includes('already called ping'))
  expect(refusals.length).toBe(3)
})

test('a call whose answer keeps changing is never refused', async () => {
  // The regression that would matter most: breaking background_task poll, whose whole
  // purpose is to be called until something changes.
  let n = 0
  const counter: Tool<Record<string, never>> = {
    name: 'counter',
    readOnly: true,
    description: 'counts',
    parameters: { type: 'object', properties: {} },
    validate: () => ({ ok: true, args: {} }),
    execute: async () => ({ ok: true, content: `count ${n++}` }),
  }
  const fake = await startFakeServer(() => ({
    choices: [{
      message: { role: 'assistant', content: null, tool_calls: [
        { id: 'c', type: 'function', function: { name: 'counter', arguments: '{}' } },
      ] },
      finish_reason: 'tool_calls',
    }],
  }))
  stop = fake.close

  const agent = makeAgent(fake.url, { loopDetector: new LoopDetector() }, [counter])
  await agent.runTurn('go')
  expect(n).toBe(5)
})

test('every call of a step is announced, and never two calls at once', async () => {
  // Two properties in one recording, because they are the same property.
  //
  // Announced: a card opens in the window on the streamed arguments and closes on
  // `tool.call`. A call that produced no `onToolCall` leaves that row pulsing for the life of
  // the session, and the next call of the same name inherits it — taking its arguments and
  // then its result. Seen in a live run as `-> Glob -> Glob -> Glob`
  // against one `(ok)`.
  //
  // Strictly sequential: `Session.lastToolArgs` pairs a call's arguments with its result
  // through one slot per tool NAME, and `captureToolResult` reads it back to learn which
  // FOLDER a write landed in — which is the folder `verify` then runs in. Announcing a second
  // `ping` before the first one's result would overwrite that slot. Nothing in the type system
  // stops a future edit from awaiting the calls together, so the interleaving is asserted here
  // rather than left as a comment.
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    return n === 1 ? twoToolCallResponse() : textResponse('ok')
  })
  stop = fake.close
  const { handlers, events } = recorder()
  const agent = makeAgent(fake.url, { events: handlers })

  await agent.runTurn('go')

  const toolEvents = events
    .filter((e) => e[0] === 'toolCall' || e[0] === 'toolResult')
    .map((e) => `${e[0]}:${e[1]}`)
  expect(toolEvents).toEqual([
    'toolCall:ping', 'toolResult:ping',
    'toolCall:ping', 'toolResult:ping',
  ])
  // Each announcement carries its OWN arguments, in order.
  expect(events.filter((e) => e[0] === 'toolCall').map((e) => e[2]))
    .toEqual(['{"value":"a"}', '{"value":"b"}'])
  expect(events.filter((e) => e[0] === 'toolResult').map((e) => (e[2] as any).content))
    .toEqual(['pong:a', 'pong:b'])
  expect(pingCalls).toBe(2)
})

// The second-decline escalation, and what counts as "the second decline of the same thing".
//
// The real tools are registered here rather than stand-ins, because the whole question is
// which field of THEIR `PermissionKey` carries the thing being acted on: `command` for
// Bash, `paths` for Edit, and `target` for nothing the user declines often.

/** Declines every approval, so a turn becomes a sequence of denials. */
const declineEverything: InteractionPort = {
  requestApproval: async () => ({ verdict: 'deny' as const }),
  askUser: async () => '',
}

/** Normal mode asks about every command and every write, and the port says no to all of them. */
function denyingAgent(url: string, extra: ExtraOptions = {}) {
  const registry = new ToolRegistry()
  registry.register(runCommandTool)
  registry.register(editFileTool)
  const root = mkdtempSync(join(tmpdir(), 'pc-deny-'))
  workspaces.push(root)
  return new Agent({
    client: new LlamaClient({ baseUrl: url, model: 'm' }),
    registry,
    context: { workspace: new Workspace(root) },
    maxSteps: 5,
    mode: 'normal',
    permissions: new PermissionEngine({ layers: [], mode: 'normal', workspaceRoot: root }),
    interaction: declineEverything,
    ...extra,
  })
}

/** One tool call per step, in order, then prose. */
function callsThenDone(calls: [string, Record<string, unknown>][]) {
  let n = 0
  return () => {
    const next = calls[n++]
    return next ? toolCallResponse(next[0], JSON.stringify(next[1])) : textResponse('ok')
  }
}

const resultContents = (rec: ReturnType<typeof recorder>): string[] =>
  rec.events.filter((e) => e[0] === 'toolResult').map((e) => (e[2] as { content: string }).content)

test('declining two unrelated commands is not reported to the model as declining one thing twice', async () => {
  // The escalation tells the model to stop proposing variants of a change the user does not
  // want — an instruction to abandon the work. Derived from two decisions about entirely
  // different commands it is simply wrong, and `Bash` puts its command line in
  // `command`, never in `target`, so counting on `target` alone collapsed every command in
  // the turn into one bucket.
  const fake = await startFakeServer(callsThenDone([
    ['Bash', { command: 'npm install -g something' }],
    ['Bash', { command: 'git clean -fdx' }],
  ]))
  stop = fake.close
  const rec = recorder()
  await denyingAgent(fake.url, { events: rec.handlers }).runTurn('go')

  const contents = resultContents(rec)
  expect(contents.length).toBe(2)
  expect(contents[0]).toMatch(/adjust your approach/)
  expect(contents[1]).not.toMatch(/decline #/)
  expect(contents[1]).toMatch(/adjust your approach/)
})

test('declining two edits to unrelated files is not reported as declining one thing twice', async () => {
  // The same collapse from the file side: Edit keys on `paths`.
  const fake = await startFakeServer(callsThenDone([
    ['Edit', { path: 'src/one.ts', search_text: 'a', replace_text: 'b' }],
    ['Edit', { path: 'src/two.ts', search_text: 'a', replace_text: 'b' }],
  ]))
  stop = fake.close
  const rec = recorder()
  await denyingAgent(fake.url, { events: rec.handlers }).runTurn('go')

  expect(resultContents(rec)[1]).not.toMatch(/decline #/)
})

test('declining the same file twice still escalates, however the model spelled the path', async () => {
  // The other half: the escalation exists because a denied edit came back as a fresh
  // variant of the same edit, twice and three times, and it has to keep firing for that.
  // Windows makes `src\App.ts` and `src/app.ts` one file, and the model writes both — a
  // grouping that took the spelling literally would let variant number four through on a
  // capital letter.
  const fake = await startFakeServer(callsThenDone([
    ['Edit', { path: 'src/App.ts', search_text: 'a', replace_text: 'b' }],
    ['Edit', { path: 'src\\app.ts', search_text: 'a', replace_text: 'c' }],
  ]))
  stop = fake.close
  const rec = recorder()
  await denyingAgent(fake.url, { events: rec.handlers }).runTurn('go')

  const contents = resultContents(rec)
  expect(contents[0]).not.toMatch(/decline #/)
  expect(contents[1]).toMatch(/decline #2/)
  expect(contents[1]).toMatch(/STOP proposing further variants/)
})

test('declining the same command twice still escalates, whatever whitespace it arrived in', async () => {
  const fake = await startFakeServer(callsThenDone([
    ['Bash', { command: 'npm install -g something' }],
    ['Bash', { command: 'npm  install   -g something' }],
  ]))
  stop = fake.close
  const rec = recorder()
  await denyingAgent(fake.url, { events: rec.handlers }).runTurn('go')

  expect(resultContents(rec)[1]).toMatch(/decline #2/)
})

test('a pre-write check that throws answers the call instead of orphaning it', async () => {
  // `onBeforeTool` sits between the assistant tool-call message and the `role: 'tool'`
  // reply that answers it, and it was awaited with no guard while the permission gate ten
  // lines below wraps its host boundary for exactly this reason. The session wires it to
  // the premise/understanding gates, whose `saveMeta` was a bare `writeFileSync` -- one
  // OneDrive lock, AV hold or full disk and the throw escaped `runTurn`, `Session.send`
  // rethrew it, `Host.send` never emitted `turn.done`, and the unanswered call was written
  // to disk. It then survives resume: compaction deliberately leaves an unanswered call
  // exactly as unanswered as it was, so every later request of the session is malformed.
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    return n === 1 ? toolCallResponse('ping', JSON.stringify({ value: 'x' })) : textResponse('done')
  })
  stop = fake.close
  const agent = makeAgent(fake.url, {
    onBeforeTool: async () => { throw new Error('EBUSY: settings.json is locked') },
  })

  const result = await agent.runTurn('go')

  // The turn ends normally...
  expect(result.stoppedBecause).toBe('done')
  // ...the tool never ran...
  expect(pingCalls).toBe(0)
  // ...and every assistant tool_call has its matching tool reply, which is the invariant
  // that keeps the session usable at all.
  const messages = agent.transcript.messages()
  const asked = messages
    .filter((m) => m.role === 'assistant' && m.tool_calls !== undefined)
    .flatMap((m) => m.tool_calls!.map((c) => c.id))
  const answered = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id!)
  expect(asked.length).toBeGreaterThan(0)
  expect([...asked].sort()).toEqual([...answered].sort())
  // ...and the model is told why, in the vocabulary it already knows.
  const reply = messages.find((m) => m.role === 'tool')!
  expect(reply.content).toContain('Not run:')
  expect(reply.content).toContain('EBUSY')
})

test('plan mode sends exactly the registry read-only schemas, and nothing else', async () => {
  // Pins the rule the compaction prewarm has to mirror. `buildAgent` never passes
  // `allowedTools`, so this narrowing happens HERE, inside Agent — which is why the prewarm
  // (which sends the tool list itself) was warming a 21-schema prompt while the step that
  // followed sent 11. The ~8.1k-char difference sits inside the system block at the very
  // front of the prompt, so the prewarmed prefix matched nothing from token 0 and the full
  // re-prefill was paid twice: once wasted, once on the user's clock.
  let sentTools: { function: { name: string } }[] | undefined
  const fake = await startFakeServer((body) => {
    sentTools = (body as { tools?: { function: { name: string } }[] }).tools
    return textResponse('ok')
  })
  stop = fake.close

  await makeAgent(fake.url, { mode: 'plan' }).runTurn('have a look')

  // `ping` declares readOnly, `boom` does not.
  expect(sentTools?.map((t) => t.function.name)).toEqual(['ping'])
})

/**
 * `tool_choice: 'required'` is a request this server accepts and IGNORES.
 *
 * Measured live, 3/3, with a single read-only tool and "Say hello in one word. Do not use any
 * tool.": prose from the first token, `finish_reason: stop`, no `tool_calls`. No grammar was
 * applied. The truncation continuation rests on the opposite premise — it sends `'required'`
 * precisely because by then talking has already failed — so a continuation that talked was
 * returned as an ordinary message, `runTurn` saw zero calls, and a step that took NO ACTION
 * AT ALL ended the turn `stoppedBecause: 'done'`.
 */
test('a continuation that talks instead of acting ends the turn truncated, not done', async () => {
  let calls = 0
  const fake = await startFakeServer(() => {
    calls++
    return calls === 1
      // Step 1 runs out of room mid-thought.
      ? {
          choices: [{
            finish_reason: 'length',
            message: { role: 'assistant', content: null, reasoning_content: 'I should look at' },
          }],
          usage: { completion_tokens: 8 },
        }
      // The continuation ends cleanly and calls nothing -- what `required` was meant to stop.
      : {
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'I have finished reviewing the change; it looks correct.' },
          }],
          usage: { completion_tokens: 12 },
        }
  })
  stop = fake.close
  const agent = makeAgent(fake.url)
  const result = await agent.runTurn('check the change')

  expect(result.stoppedBecause).toBe('truncated')
  expect(pingCalls).toBe(0)
  // The words are not thrown away: the model produced them and the turn shows them.
  expect(result.finalText).toContain('finished reviewing')
  // `required` really was asked for, which is what makes this the server's answer and not ours.
  expect(fake.requests.map((r: any) => r.body.tool_choice)).toEqual(['auto', 'required'])
})

/**
 * `/slots` not answering is not the same statement as "nothing is happening", and the step
 * clock used to treat it as one.
 *
 * llama.cpp serves HTTP between decode batches, so during the exact prefill this extension
 * exists to protect, `/slots` is the slowest it ever is. Measured against a real 23,487-token
 * cold prefill with the shipped 3 s timeout: a 2,607 ms median answer, worst 2,655 ms, and
 * one poll in thirteen crossing outright. Every crossing killed a step that was doing
 * nothing wrong.
 */
test('a prefill survives a run of /slots probes that do not answer', async () => {
  let slotPolls = 0
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/slots') {
      slotPolls++
      // The first two go unanswered, exactly as a slow decode batch does.
      if (slotPolls <= 2) return hang()
      return [{ is_processing: true, n_prompt_tokens_processed: slotPolls * 1000 }]
    }
    return new Promise((resolve) => setTimeout(() => resolve(textResponse('after long prefill')), 6500))
  })
  stop = fake.close
  const result = await makeAgent(fake.url, {
    stepTimeoutMs: 200, firstStepTimeoutMs: 200, prefillRecheckMs: 200,
  }).runTurn('hi')
  expect(result.stoppedBecause).toBe('done')
  expect(result.finalText).toBe('after long prefill')
})

test('a /slots that never answers at all still lets the step die', async () => {
  // The other half: tolerating an unanswered probe must not become an unbounded wait. Three
  // unknowns of grace, then the step ends the way it always did.
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/slots') return hang()
    return hang()
  })
  stop = fake.close
  const result = await makeAgent(fake.url, {
    stepTimeoutMs: 200, firstStepTimeoutMs: 200, prefillRecheckMs: 100,
  }).runTurn('hi')
  expect(result.stoppedBecause).toBe('timeout')
})

/**
 * `n_prompt_tokens_processed` belongs to whatever the SLOT is working on, not to our
 * request, and it carries the previous task's final value until the next one starts.
 * Observed directly while probing: `processing=false processed=41087` from the request
 * before, while the request being measured then climbed 4096, 6144, 8192. Read as "the
 * counter went backwards, so we stalled", that kills a healthy prefill.
 */
test('a prefill counter that jumps backwards is a new request, not a stall', async () => {
  let slotPolls = 0
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/slots') {
      slotPolls++
      // First look: the tail of some earlier, much bigger prefill. Then ours, from the start.
      const processed = slotPolls === 1 ? 41_087 : slotPolls * 2048
      return [{ is_processing: true, n_prompt_tokens_processed: processed }]
    }
    return new Promise((resolve) => setTimeout(() => resolve(textResponse('after long prefill')), 6500))
  })
  stop = fake.close
  const result = await makeAgent(fake.url, {
    stepTimeoutMs: 200, firstStepTimeoutMs: 200, prefillRecheckMs: 200,
  }).runTurn('hi')
  expect(result.stoppedBecause).toBe('done')
  expect(result.finalText).toBe('after long prefill')
})

import { CUT_CALL_NOTE, CUT_STEP_PREFIX } from '../src/agent/loop.js'

// The output limit landing in the middle of a batch of calls used to throw the whole batch
// away — three good edits gone with the one that was cut, four cards closed with "ran out of
// room", and a continuation redoing them one by one.
test('a step cut by the output limit keeps its complete calls and drops only the cut one', async () => {
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    if (n === 1) {
      return {
        choices: [{
          finish_reason: 'length',
          message: {
            role: 'assistant', content: null, reasoning_content: 'three edits at once',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'ping', arguments: '{"value":"a"}' } },
              { id: 'c2', type: 'function', function: { name: 'ping', arguments: '{"value":"b"}' } },
              { id: 'c3', type: 'function', function: { name: 'ping', arguments: '{"value":"c' } },
            ],
          },
        }],
        usage: { completion_tokens: 8000 },
      }
    }
    return textResponse('done')
  })
  stop = fake.close
  const results: Array<[string, boolean, string, string | undefined]> = []
  const agent = makeAgent(fake.url, { events: { onToolResult: (name, r, id) => { results.push([name, r.ok, r.content, id]) } } })

  const result = await agent.runTurn('edit three files')
  expect(result.stoppedBecause).toBe('done')

  // The two complete calls ran and were answered; the cut one is not in the transcript.
  const second = fake.requests[1].body
  const assistant = second.messages.filter((m: any) => m.role === 'assistant').pop()
  expect(assistant.tool_calls.map((c: any) => c.id)).toEqual(['c1', 'c2'])
  expect(second.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content)).toEqual(['pong:a', 'pong:b'])
  // No forced continuation: the step did real work, so the model is told and carries on.
  expect(second.tool_choice).not.toBe('required')
  const note = second.messages.filter((m: any) => m.role === 'user').pop()
  expect(note.content).toContain(`${CUT_STEP_PREFIX}2 complete tool calls`)
  expect(note.content).toContain('the next one was cut mid-way')
  // The window heard a result for the cut call too, so its card closes honestly.
  expect(results.map(([name, ok, content, id]) => `${id}:${name}:${ok}:${content.slice(0, 12)}`)).toEqual([
    'c1:ping:true:pong:a', 'c2:ping:true:pong:b', `c3:ping:false:${CUT_CALL_NOTE.slice(0, 12)}`,
  ])
})
