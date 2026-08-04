import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvents, type StepStartInfo } from '../src/agent/loop.js'
import { LlamaClient } from '../src/llama/client.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { Transcript } from '../src/transcript/transcript.js'
import { Workspace } from '../src/workspace.js'
import { startFakeServer } from './fake-server.js'
import type { Tool } from '../src/tools/types.js'

/**
 * A turn that outlives its own limits.
 *
 * Two things used to end a long turn, and neither was the work being finished. It stopped
 * after 40 steps — about ten minutes — and said so. And a turn long enough to fill the
 * context window could not compact, because compaction replaces the transcript OBJECT while
 * a running Agent holds a reference to the old one, so the only safe moment was between
 * turns. The window filled, the server refused the request, and the turn died on an
 * exception.
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

function toolCall(): unknown {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `c${Math.floor(performance.now() * 1000) % 100000}`, type: 'function', function: { name: 'ping', arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  }
}

function text(body: string): unknown {
  return { choices: [{ message: { role: 'assistant', content: body }, finish_reason: 'stop' }] }
}

function makeAgent(url: string, extra: Record<string, unknown> = {}): Agent {
  const registry = new ToolRegistry()
  registry.register(ping)
  const root = mkdtempSync(join(tmpdir(), 'pc-long-'))
  workspaces.push(root)
  return new Agent({
    client: new LlamaClient({ baseUrl: url, model: 'm' }),
    registry,
    context: { workspace: new Workspace(root) },
    ...extra,
  })
}

test('a turn is not stopped for being long', async () => {
  // The old default was 40, which is roughly ten minutes of work. Nothing about step 41 is
  // less healthy than step 39, and counting could not tell the difference — the only thing
  // it caught reliably was a task that was simply large.
  const WANTED = 45
  let calls = 0
  const fake = await startFakeServer(() => {
    calls += 1
    return calls <= WANTED ? toolCall() : text('finished')
  })
  stop = fake.close

  const result = await makeAgent(fake.url).runTurn('do something large')

  expect(result.stoppedBecause).toBe('done')
  expect(result.steps).toBe(WANTED + 1)
  expect(result.finalText).toBe('finished')
})

test('a caller that asks for a ceiling still gets one', async () => {
  // Unbounded is the default, not the law: the CLI's `--steps` is a deliberate ceiling for a
  // one-shot run, and reaching one is still reported as itself.
  const fake = await startFakeServer(() => toolCall())
  stop = fake.close

  const result = await makeAgent(fake.url, { maxSteps: 3 }).runTurn('loop please')

  expect(result.stoppedBecause).toBe('max_steps')
  expect(result.steps).toBe(3)
})

test('a transcript swapped in mid-turn is what the rest of the turn runs on', async () => {
  // The heart of it. Compaction cannot edit a transcript in place — the append-only law
  // holds per object — so it builds a new one. Before this, a running Agent kept writing to
  // the object it was constructed with, which is why compaction had to wait for the turn to
  // end, which is why a turn could never make room for itself.
  let calls = 0
  const fake = await startFakeServer(() => {
    calls += 1
    return calls <= 2 ? toolCall() : text('done')
  })
  stop = fake.close

  const replacement = new Transcript()
  replacement.append({ role: 'system', content: 'you are an agent' })
  replacement.append({ role: 'user', content: 'BRIEFING: the conversation so far, summarised' })

  const agent = makeAgent(fake.url, {
    beforeStep: async (step: number) =>
      (step === 2 ? { transcript: replacement, timeoutMs: 600_000 } : undefined),
  })
  await agent.runTurn('start')

  // Step 1 ran on the original; step 2 onwards on the replacement.
  const first = fake.requests[0].body.messages as { content: string }[]
  const second = fake.requests[1].body.messages as { content: string }[]
  expect(first.some((m) => m.content === 'start')).toBe(true)
  expect(first.some((m) => m.content?.startsWith('BRIEFING:'))).toBe(false)
  expect(second.some((m) => m.content?.startsWith('BRIEFING:'))).toBe(true)

  // And the work carried on into it, rather than into the abandoned object.
  expect(agent.transcript).toBe(replacement)
  expect(replacement.messages().some((m) => m.role === 'tool')).toBe(true)
})

test('the step after a swap is given room to re-prefill, and only that step', async () => {
  // llama.cpp matches its cache by longest common prefix, so replacing the transcript means
  // the whole prompt is processed again before a token appears. The ordinary per-step budget
  // is sized for a warm cache — this is the reported "a step took longer than its time
  // limit", arriving immediately after a successful compaction.
  let calls = 0
  const fake = await startFakeServer(() => {
    calls += 1
    return calls <= 3 ? toolCall() : text('done')
  })
  stop = fake.close

  const replacement = new Transcript()
  replacement.append({ role: 'system', content: 'you are an agent' })
  replacement.append({ role: 'user', content: 'briefing' })

  const starts: StepStartInfo[] = []
  const events: AgentEvents = { onStepStart: (i) => { starts.push(i) } }

  await makeAgent(fake.url, {
    stepTimeoutMs: 90_000,
    events,
    beforeStep: async (step: number) =>
      (step === 2 ? { transcript: replacement, timeoutMs: 540_000 } : undefined),
  }).runTurn('start')

  expect(starts.map((s) => s.timeoutMs)).toEqual([90_000, 540_000, 90_000, 90_000])
})

test('a compaction that changed nothing costs the next step nothing', async () => {
  // `beforeStep` returning nothing is the common case — it runs before every step and most
  // of the time there is nothing to do. A postponed or failed compaction reports the same
  // way, and neither is a reason to hand the next step a nine-minute budget.
  let calls = 0
  const fake = await startFakeServer(() => {
    calls += 1
    return calls <= 1 ? toolCall() : text('done')
  })
  stop = fake.close

  const starts: StepStartInfo[] = []
  let asked = 0
  await makeAgent(fake.url, {
    stepTimeoutMs: 90_000,
    events: { onStepStart: (i: StepStartInfo) => { starts.push(i) } } satisfies AgentEvents,
    beforeStep: async () => { asked += 1; return undefined },
  }).runTurn('start')

  expect(asked).toBe(2)
  expect(starts.map((s) => s.timeoutMs)).toEqual([90_000, 90_000])
})
