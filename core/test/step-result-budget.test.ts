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
 * One step must not be able to bury the context window.
 *
 * Found by the first honest run at the real 131,072 window, not by reading. The model —
 * invited by the prompt to batch — proposed TWELVE `read_file` calls in one step; the loop
 * (which runs every proposed call since 6f116d0) appended ~198k tokens of results in one
 * go, and the next request was 201,584 tokens against a 131,072 window. Every guard failed
 * at once, each for its own reason:
 *  - the between-steps compaction check reads the server's own prompt count from the LAST
 *    call, which predates everything the current step appended — stale by exactly the
 *    damage;
 *  - compaction could not have helped anyway: the fresh results are the protected TAIL, and
 *    a tail bigger than the window leaves nothing to summarise away ("nothing-to-gain");
 *  - the overflow retry then met the same 400 and its throw escaped `send()` uncaught —
 *    which in an unattended run is the whole night dying with a stack trace.
 *
 * The fix is the same shape as halt-on-failure: once a step's executed results pass a
 * budget, the remaining calls are answered `Not run:` instead of executed, and the model
 * re-issues them on a later step — on the far side of a compaction check that can now see
 * what happened.
 */

let stop: (() => Promise<void>) | undefined
const dirs: string[] = []
afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Returns `size` characters per call and counts executions. */
function bulkTool(size: number): { tool: Tool<{ name: string }>; calls: () => string[] } {
  const executed: string[] = []
  return {
    calls: () => executed,
    tool: {
      name: 'bulk_read',
      readOnly: true,
      description: 'returns a lot of text',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      validate: (raw) => ({ ok: true, args: { name: String((raw as { name?: unknown })?.name ?? '') } }),
      execute: async (args) => {
        executed.push(args.name)
        return { ok: true, content: `${args.name}\n${'x'.repeat(size)}` }
      },
    },
  }
}

function multiCall(names: string[]): unknown {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content: null,
        tool_calls: names.map((name, i) => ({
          id: `c${i}`, type: 'function',
          function: { name: 'bulk_read', arguments: JSON.stringify({ name }) },
        })),
      },
    }],
    usage: { completion_tokens: 40, prompt_tokens: 100 },
  }
}

function text(body: string): unknown {
  return {
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: body } }],
    usage: { completion_tokens: 5, prompt_tokens: 120 },
  }
}

async function runAgent(
  names: string[], size: number, budgetChars?: number,
): Promise<{ executed: string[]; replies: { id: string; content: string }[] }> {
  const bulk = bulkTool(size)
  let n = 0
  const fake = await startFakeServer(() => {
    n++
    return n === 1 ? multiCall(names) : text('done')
  })
  stop = fake.close
  const registry = new ToolRegistry()
  registry.register(bulk.tool)
  const root = mkdtempSync(join(tmpdir(), 'pc-budget-'))
  dirs.push(root)

  const agent = new Agent({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    registry,
    context: { workspace: new Workspace(root) },
    maxSteps: 3,
    ...(budgetChars !== undefined ? { stepResultBudgetChars: budgetChars } : {}),
  })
  await agent.runTurn('read them all')

  const replies = (fake.requests[1].body.messages as { role: string; tool_call_id?: string; content?: string }[])
    .filter((m) => m.role === 'tool')
    .map((m) => ({ id: m.tool_call_id ?? '', content: m.content ?? '' }))
  return { executed: bulk.calls(), replies }
}

test('a step stops executing once its results pass the budget, and answers the rest', async () => {
  // Six calls of 30k chars against a 100k budget: the fourth crosses the line (120k), so
  // the fifth and sixth never run. Crossing the budget is discovered AFTER a call returns —
  // the loop cannot know a result's size before executing it — so the call that crosses
  // still lands; only what follows is refused.
  const { executed, replies } = await runAgent(
    ['a', 'b', 'c', 'd', 'e', 'f'], 30_000, 100_000,
  )
  expect(executed).toEqual(['a', 'b', 'c', 'd'])

  // Every proposed call is still ANSWERED — an unanswered tool_call poisons the session —
  // and the refused ones carry the `Not run:` contract plus the reason, so the model
  // re-issues them rather than concluding they failed.
  expect(replies).toHaveLength(6)
  expect(replies[4]!.content).toMatch(/^Not run: this step's results already/)
  expect(replies[5]!.content).toMatch(/re-issue/i)
})

test('under the budget, every call runs — the budget is a ceiling, not a rate', async () => {
  const { executed } = await runAgent(['a', 'b', 'c'], 10_000, 100_000)
  expect(executed).toEqual(['a', 'b', 'c'])
})

test('with no budget configured, nothing is refused', async () => {
  // Callers that never heard of the option keep exactly the old behaviour.
  const { executed } = await runAgent(['a', 'b', 'c', 'd', 'e', 'f'], 30_000)
  expect(executed).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
})
