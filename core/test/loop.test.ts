import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvents, type AgentOptions } from '../src/agent/loop.js'
import { LlamaClient } from '../src/llama/client.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { Workspace } from '../src/workspace.js'
import { startFakeServer } from './fake-server.js'
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

function makeAgent(url: string, extra: ExtraOptions = {}) {
  const registry = new ToolRegistry()
  registry.register(ping)
  registry.register(boom)
  const root = mkdtempSync(join(tmpdir(), 'pc-loop-'))
  workspaces.push(root)
  return new Agent({
    client: new LlamaClient({ baseUrl: url, model: 'm' }),
    registry,
    context: { workspace: new Workspace(root) },
    maxSteps: 5,
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
// Transcript shape
// ---------------------------------------------------------------------------

// A strict OpenAI endpoint rejects an assistant turn whose tool_calls are not all
// answered; llama.cpp tolerates it, which is why this went unnoticed.
test('every tool call carried forward is answered', async () => {
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
  // Only the first call actually ran.
  expect(pingCalls).toBe(1)
  const second = messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c2')
  expect(second.content).toMatch(/one tool call per step/i)
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
  expect(rec.of('stepStart')).toEqual([{ step: 1, timeoutMs: 9_000 }, { step: 2, timeoutMs: 9_000 }])
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
