import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { LlamaClient } from '../src/llama/client.js'
import { Session } from '../src/session/session.js'
import { SessionStore } from '../src/session/store.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { Toolset } from '../src/tools/default-set.js'
import { startFakeServer } from './fake-server.js'
import type { Tool } from '../src/tools/types.js'

/**
 * The between-steps fill check must see what the CURRENT step appended.
 *
 * It reads `latestPromptTokens` — the server's own count, ground truth — but that truth is
 * from the last model call, which predates every tool result the step then appended. With
 * one call per step the staleness was bounded by one read; with batching it is bounded by
 * nothing. Watched at the real window: a step appended ~198k tokens of results, the check
 * compared 3,552 against 131,072 and passed, and the next request was refused by the server
 * at 201,584 tokens.
 *
 * The check now carries the staleness correction: server truth PLUS the estimate of what
 * has been appended since that truth was measured.
 */

let stop: (() => Promise<void>) | undefined
const dirs: string[] = []
afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const CONTEXT = 40_000

/** ~25k tokens per read: two of them cross a 40k window while each single one fits. */
const CHUNK = 100_000

test('a step\'s appended results count against the window before the next step runs', async () => {
  const bulk: Tool<Record<string, never>> = {
    name: 'bulk_read',
    readOnly: true,
    description: 'returns a lot of text',
    parameters: { type: 'object', properties: {} },
    validate: () => ({ ok: true, args: {} }),
    execute: async () => ({ ok: true, content: 'y'.repeat(CHUNK) }),
  }

  let call = 0
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: CONTEXT } }
    if (req.url === '/health') return { status: 'ok' }
    const last = (body.messages as { content?: string | null }[]).at(-1)
    if (typeof last?.content === 'string' && last.content.includes('compacted to free up context')) {
      return {
        choices: [{ message: { role: 'assistant', content: 'BRIEFING: two large reads happened.' }, finish_reason: 'stop' }],
      }
    }
    call++
    if (call <= 2) {
      return {
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: `c${call}`, type: 'function', function: { name: 'bulk_read', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        // The server's honest count for THIS call: it has seen the previous step's result
        // (call 2's prompt carries read 1) but never the result its own step is about to
        // append. 28,000 sits safely under the 36,000 the flat check compares against —
        // the stale reading passes; the corrected one (28k + ~25k appended) does not.
        usage: { prompt_tokens: call === 1 ? 3_000 : 28_000, completion_tokens: 20 },
      }
    }
    return {
      choices: [{ message: { role: 'assistant', content: 'finished' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30_000, completion_tokens: 5 },
    }
  })
  stop = fake.close
  const root = mkdtempSync(join(tmpdir(), 'pc-fill-'))
  dirs.push(root)

  const registry = new ToolRegistry()
  registry.register(bulk)
  const states: string[] = []
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: { registry } as Toolset,
    workspaceRoot: root,
    mode: 'autopilot',
    store: new SessionStore(root),
    compaction: { contextLength: CONTEXT },
    onCompaction: (e) => states.push(e.state),
  })
  const result = await session.send('read the two big things')

  // The turn survives AND the room was made mid-turn: without the staleness correction the
  // check passes on the stale number and no compaction ever runs.
  expect(result.stoppedBecause).toBe('done')
  expect(states).toContain('applied')
})
