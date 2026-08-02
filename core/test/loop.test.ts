import { afterEach, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.js'
import { LlamaClient } from '../src/llama/client.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { Workspace } from '../src/workspace.js'
import { startFakeServer } from './fake-server.js'
import type { Tool } from '../src/tools/types.js'

let stop: (() => Promise<void>) | undefined
afterEach(async () => { await stop?.(); stop = undefined })

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
  execute: async (args) => ({ ok: true, content: `pong:${args.value}` }),
}

function toolCallResponse(name: string, args: string) {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content: null, reasoning_content: 'brief',
        tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: args } }],
      },
    }],
    usage: { completion_tokens: 30 },
  }
}

function textResponse(text: string) {
  return {
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { completion_tokens: 10 },
  }
}

function makeAgent(url: string) {
  const registry = new ToolRegistry()
  registry.register(ping)
  return new Agent({
    client: new LlamaClient({ baseUrl: url, model: 'm' }),
    registry,
    context: { workspace: new Workspace(mkdtempSync(join(tmpdir(), 'pc-loop-'))) },
    maxSteps: 5,
  })
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
    if (n === 1) {
      return {
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null, reasoning_content: 'x'.repeat(50) } }],
        usage: { completion_tokens: 4000 },
      }
    }
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
