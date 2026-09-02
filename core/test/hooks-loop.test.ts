import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.js'
import type { ToolCallInfo, ToolHooks } from '../src/hooks/engine.js'
import { LlamaClient } from '../src/llama/client.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { Tool } from '../src/tools/types.js'
import { Workspace } from '../src/workspace.js'
import { startFakeServer } from './fake-server.js'

/**
 * The hook engine's contract as the agent loop honours it (docs/PLUGINS-2026-09.md §5): a
 * PreToolUse deny is a deny the model reads, rewritten arguments are validated again, hook
 * notes ride on the tool result, and a Stop hook sends the model back exactly once.
 */

let stop: (() => Promise<void>) | undefined
const workspaces: string[] = []
afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let pings: string[] = []
const ping: Tool<{ value: string }> = {
  name: 'ping',
  readOnly: true,
  description: 'ping',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  validate: (raw) => {
    const v = (raw as { value?: unknown })?.value
    return typeof v === 'string' && v.trim() !== '' ? { ok: true, args: { value: v } } : { ok: false, error: 'value must be non-empty' }
  },
  execute: async (args) => { pings.push(args.value); return { ok: true, content: `pong:${args.value}` } },
}

function toolCall(name: string, args: string) {
  return {
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: args } }] } }],
    usage: { completion_tokens: 30 },
  }
}
function text(t: string) {
  return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: t } }], usage: { completion_tokens: 10 } }
}

function makeAgent(url: string, hooks: ToolHooks, extra: { stopHook?: (finalText: string, active: boolean) => Promise<{ block?: string }> } = {}) {
  const registry = new ToolRegistry()
  registry.register(ping)
  const root = mkdtempSync(join(tmpdir(), 'pc-hook-loop-'))
  workspaces.push(root)
  return new Agent({
    client: new LlamaClient({ baseUrl: url, model: 'm', slotsTimeoutMs: 300 }),
    registry,
    context: { workspace: new Workspace(root) },
    maxSteps: 6,
    prefillRecheckMs: 100,
    hooks,
    ...extra,
  })
}

test('a PreToolUse deny stops the call and tells the model who refused it', async () => {
  pings = []
  let n = 0
  const fake = await startFakeServer(() => (++n === 1 ? toolCall('ping', '{"value":"secret"}') : text('ok')))
  stop = fake.close
  const seen: ToolCallInfo[] = []
  const hooks: ToolHooks = {
    async beforeTool(call) {
      seen.push(call)
      return { verdict: 'deny', reason: 'pings are off today', by: 'plugin:guard', notes: [] }
    },
    async afterTool(_key, result) { return result },
  }
  const agent = makeAgent(fake.url, hooks)
  await agent.runTurn('go')
  expect(pings).toEqual([])
  expect(seen[0]).toMatchObject({ name: 'ping', args: { value: 'secret' }, key: { tool: 'ping' } })
  const reply = fake.requests[1]?.body.messages.at(-1)
  expect(reply.role).toBe('tool')
  expect(reply.content).toBe('Not run. Refused by hook plugin:guard: pings are off today')
})

test('rewritten arguments are validated again, and hook notes ride on the result', async () => {
  pings = []
  let n = 0
  const fake = await startFakeServer(() => (++n === 1 ? toolCall('ping', '{"value":"a"}') : n === 2 ? toolCall('ping', '{"value":"b"}') : text('ok')))
  stop = fake.close
  let calls = 0
  const hooks: ToolHooks = {
    async beforeTool(call) {
      calls++
      const value = (call.args as { value: string }).value
      if (value === 'a') return { updatedArgs: { value: 'A' }, notes: ['[hook plugin:x] changed the arguments of ping'] }
      return { updatedArgs: { value: '' }, notes: [] } // no longer validates
    },
    async afterTool(_key, result, _signal, call) {
      return { ...result, content: `${result.content}\n\n[after ${call?.name} ${JSON.stringify(call?.args)}]` }
    },
  }
  const agent = makeAgent(fake.url, hooks)
  await agent.runTurn('go')
  expect(calls).toBe(2)
  expect(pings).toEqual(['A'])
  const first = fake.requests[1]?.body.messages.at(-1)
  expect(first.content).toBe('pong:A\n\n[hook plugin:x] changed the arguments of ping\n\n[after ping {"value":"A"}]')
  const second = fake.requests[2]?.body.messages.at(-1)
  expect(second.content).toContain('Not run: a PreToolUse hook rewrote the arguments and they no longer validate.')
})

test('a Stop hook sends the model back once, then the turn ends whatever it says', async () => {
  let n = 0
  const fake = await startFakeServer(() => (++n === 1 ? text('I am done') : text('now I am really done')))
  stop = fake.close
  const asked: [string, boolean][] = []
  const agent = makeAgent(fake.url, { async afterTool(_k, r) { return r } }, {
    stopHook: async (finalText, active) => {
      asked.push([finalText, active])
      return { block: 'run the tests first' }
    },
  })
  const result = await agent.runTurn('go')
  expect(result.stoppedBecause).toBe('done')
  expect(result.steps).toBe(2)
  expect(result.finalText).toBe('now I am really done')
  // Consulted once: the second answer is final, so a hook cannot loop the turn.
  expect(asked).toEqual([['I am done', false]])
  const continuation = fake.requests[1]?.body.messages.at(-1)
  expect(continuation).toEqual({ role: 'user', content: '[A Stop hook asked you to continue]\n\nrun the tests first' })
})
