import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Agent } from '../src/agent/loop.js'
import { LlamaClient } from '../src/llama/client.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { Workspace } from '../src/workspace.js'
import { startFakeServer } from './fake-server.js'
import type { Tool } from '../src/tools/types.js'

/**
 * The single largest throughput property this system has, and nothing was holding it.
 *
 * llama.cpp reuses its KV cache by LONGEST COMMON PREFIX. A step whose prompt extends the
 * previous one is prefilled only for the tokens it added — a few hundred — and generation
 * starts at once. A step whose prompt DIVERGES anywhere before its end throws the cache away
 * and re-prefills the whole thing: measured on this machine at 393 tok/s, a 100k-token
 * conversation costs about four minutes before the first new token appears.
 *
 * So the difference between a stable prefix and an unstable one is the difference between a
 * step costing seconds and a step costing minutes — on EVERY step, for as long as the turn
 * runs. It is invisible in every test that asserts on behaviour, because the answers are
 * identical either way; the only symptom is that the agent is slow, which reads as the model
 * being slow.
 *
 * One `new Date()` in the system prompt, one re-sorted tool list, one repo map rebuilt
 * mid-turn, and it is gone. This is the test that says so.
 */

let stop: (() => Promise<void>) | undefined
const workspaces: string[] = []

afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ping: Tool<Record<string, never>> = {
  name: 'ping',
  readOnly: true,
  description: 'ping',
  parameters: { type: 'object', properties: {} },
  validate: () => ({ ok: true, args: {} }),
  execute: async () => ({ ok: true, content: 'pong' }),
}

const other: Tool<Record<string, never>> = {
  name: 'other',
  readOnly: true,
  description: 'other',
  parameters: { type: 'object', properties: {} },
  validate: () => ({ ok: true, args: {} }),
  execute: async () => ({ ok: true, content: 'ok' }),
}

function toolCall(n: number): unknown {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'ping', arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  }
}

function text(body: string): unknown {
  return { choices: [{ message: { role: 'assistant', content: body }, finish_reason: 'stop' }] }
}

/** The part of a request the server's cache is keyed on, in the order it is sent. */
function cacheKey(body: { messages: unknown[]; tools?: unknown }): string {
  return JSON.stringify({ tools: body.tools ?? null, messages: body.messages })
}

test('every step of a turn extends the previous prompt instead of diverging from it', async () => {
  const STEPS = 8
  let calls = 0
  const fake = await startFakeServer(() => {
    calls += 1
    return calls <= STEPS ? toolCall(calls) : text('done')
  })
  stop = fake.close
  const root = mkdtempSync(join(tmpdir(), 'pc-cache-'))
  workspaces.push(root)

  const registry = new ToolRegistry()
  registry.register(ping)
  registry.register(other)
  const agent = new Agent({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    registry,
    context: { workspace: new Workspace(root) },
  })
  await agent.runTurn('do several things')

  const bodies = fake.requests.map((r) => r.body as { messages: { role: string }[]; tools?: unknown })
  expect(bodies.length).toBe(STEPS + 1)

  for (let i = 1; i < bodies.length; i++) {
    const previous = bodies[i - 1]!
    const current = bodies[i]!

    // The tool list is part of the prompt for every chat template that supports tools, and
    // it sits BEFORE the messages — so a list that differs by even one character moves the
    // divergence point to the very front and costs the whole cache.
    expect(JSON.stringify(current.tools)).toBe(JSON.stringify(previous.tools))

    // And the messages must be an APPEND. Not "the same length plus more" — the earlier
    // messages have to be untouched, because rewriting message 3 of 40 is exactly as
    // expensive as rewriting all of them.
    expect(current.messages.length).toBeGreaterThan(previous.messages.length)
    const sharedPrefix = JSON.stringify(current.messages.slice(0, previous.messages.length))
    expect(sharedPrefix).toBe(JSON.stringify(previous.messages))
  }
})

test('the system message is byte-identical on every step, including its own text', async () => {
  // Separately from the prefix check, because this is the one that would be introduced by
  // accident: anything time-dependent, machine-dependent or freshly-serialised in the system
  // prompt breaks the cache at message 0, which is the worst possible place.
  let calls = 0
  const fake = await startFakeServer(() => {
    calls += 1
    return calls <= 3 ? toolCall(calls) : text('done')
  })
  stop = fake.close
  const root = mkdtempSync(join(tmpdir(), 'pc-cache-'))
  workspaces.push(root)

  const registry = new ToolRegistry()
  registry.register(ping)
  await new Agent({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    registry,
    context: { workspace: new Workspace(root) },
  }).runTurn('go')

  const systems = fake.requests.map((r) => {
    const first = (r.body as { messages: { role: string; content: string }[] }).messages[0]
    return first?.role === 'system' ? first.content : '(no system message)'
  })
  expect(new Set(systems).size).toBe(1)
  expect(systems[0]).not.toBe('(no system message)')
})

test('two turns in a row keep the shared prefix, so a turn starts warm', async () => {
  // A second turn re-sends the whole conversation. If anything about the first turn's
  // portion changed, the second turn pays a full re-prefill of everything before it has
  // said a word — which is the cost this whole design is arranged to avoid.
  const fake = await startFakeServer(() => text('done'))
  stop = fake.close
  const root = mkdtempSync(join(tmpdir(), 'pc-cache-'))
  workspaces.push(root)

  const registry = new ToolRegistry()
  registry.register(ping)
  const agent = new Agent({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    registry,
    context: { workspace: new Workspace(root) },
  })
  await agent.runTurn('first')
  await agent.runTurn('second')

  const [firstTurn, secondTurn] = fake.requests.map((r) => r.body as { messages: unknown[] })
  const shared = JSON.stringify(secondTurn!.messages.slice(0, firstTurn!.messages.length))
  expect(shared).toBe(JSON.stringify(firstTurn!.messages))
})

test('the cache key is stable across identical builds, tools included', async () => {
  // This is the one with teeth against the classic mistake, and the three above are not —
  // checked by putting `new Date().toISOString()` into `buildSystemPrompt` and running all
  // four: only this one failed. The reason is worth writing down, because it is also why the
  // design survives the mistake better than expected. `buildSystemPrompt` is called ONLY
  // when the transcript is empty (loop.ts) and at a compaction swap (session.ts) — so
  // within a turn, and across turns, message 0 is the one already in the transcript, not a
  // fresh build. A timestamp would therefore not drift mid-turn.
  //
  // What it WOULD do is make the prompt non-deterministic, which is what this asserts: the
  // same inputs must produce the same bytes. That matters at the compaction swap, which
  // rebuilds message 0 for real — a swap should change the prefix exactly as much as it
  // means to, and not by one character more.
  const fake = await startFakeServer(() => text('done'))
  stop = fake.close
  const root = mkdtempSync(join(tmpdir(), 'pc-cache-'))
  workspaces.push(root)

  const build = async (): Promise<string> => {
    const registry = new ToolRegistry()
    registry.register(ping)
    registry.register(other)
    await new Agent({
      client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
      registry,
      context: { workspace: new Workspace(root) },
    }).runTurn('same words every time')
    return cacheKey(fake.requests.at(-1)!.body as { messages: unknown[]; tools?: unknown })
  }

  expect(await build()).toBe(await build())
})
