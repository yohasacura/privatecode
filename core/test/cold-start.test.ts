import { describe, expect, test } from 'vitest'
import { Agent, DEFAULT_STEP_TIMEOUT_MS } from '../src/agent/loop.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { Transcript } from '../src/transcript/transcript.js'
import { Workspace } from '../src/workspace.js'
import type { LlamaClient } from '../src/llama/client.js'
import type { StepStartInfo } from '../src/agent/loop.js'

/**
 * The first step of a turn may have to PREFILL before it generates.
 *
 * `stepTimeoutMs` is sized for generation against a warm prompt cache — "roughly two
 * generations plus headroom". llama.cpp matches its cache by longest common prefix, so a
 * compaction swap (which rewrites the prefix) or a session resumed in a fresh process makes
 * the server re-prefill the whole prompt first. Reported from the running app: a session
 * compacted successfully and the very next step died on the 90 s limit.
 */

/** A client that never answers: the test only needs the deadline the step was given, which
 * is announced at step START. */
function silentClient(): LlamaClient {
  return {
    chat: () => new Promise(() => {}),
    chatStream: () => new Promise(() => {}),
  } as unknown as LlamaClient
}

/**
 * The budget announced at step START, read without waiting for the turn.
 *
 * `onStepStart` fires before the model call, which is the whole point — a UI needs the
 * number in order to count down — so the never-answering client never has to be unwound.
 */
async function firstDeadline(firstStepTimeoutMs?: number): Promise<number | undefined> {
  const seen: number[] = []
  const agent = new Agent({
    client: silentClient(),
    registry: new ToolRegistry(),
    context: { workspace: new Workspace('D:/x') },
    transcript: new Transcript(),
    events: { onStepStart: (info: StepStartInfo) => seen.push(info.timeoutMs) },
    ...(firstStepTimeoutMs !== undefined ? { firstStepTimeoutMs } : {}),
  })
  void agent.runTurn('go').catch(() => { /* it never finishes; the deadline is the answer */ })
  await new Promise((r) => setImmediate(r))
  return seen[0]
}

describe('the deadline a cold first step gets', () => {
  test('without one, the first step gets the ordinary budget — unchanged behaviour', async () => {
    expect(await firstDeadline()).toBe(DEFAULT_STEP_TIMEOUT_MS)
  })

  test('with one, the first step gets it instead', async () => {
    expect(await firstDeadline(400_000)).toBe(400_000)
  })
})
