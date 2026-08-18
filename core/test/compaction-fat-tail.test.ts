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
 * `/compact` must work on the session shape it exists for: one fat turn.
 *
 * Watched live at the real 262,144 window: a turn whose search results totalled ~40k
 * tokens filled the context, and `/compact` answered "nothing to compact yet — this
 * conversation is still shorter than the briefing that would replace it" to a 55k-token
 * session. Two causes, both pinned here:
 *
 *  - the kept-verbatim tail was budgeted as a SHARE of the window (a fifth), so the budget
 *    grew to 52k on the very windows where compaction matters most, and the whole fat turn
 *    hid inside it — `TAIL_TOKEN_CAP` bounds it absolutely now;
 *  - the nothing-to-gain gate counted only the summarised MIDDLE, and a session whose bulk
 *    sits inside the tail read as "nothing to gain" even though clipping the tail's
 *    oversized messages is where the real gain was.
 */

let stop: (() => Promise<void>) | undefined
const dirs: string[] = []
afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** The user's real window, where the share-based tail budget was largest. */
const CONTEXT = 262_144

/** ~50k tokens in ONE message: bigger than any sane tail, all of it inside the kept-recent
 * six messages, none of it in the middle the old gate measured. */
const CHUNK = 200_000

test('a session whose bulk sits in the tail still compacts on demand', async () => {
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
        choices: [{ message: { role: 'assistant', content: 'BRIEFING: one huge read happened.' }, finish_reason: 'stop' }],
      }
    }
    call++
    if (call === 1) {
      return {
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bulk_read', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 2_000, completion_tokens: 20 },
      }
    }
    return {
      choices: [{ message: { role: 'assistant', content: 'read it' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 52_000, completion_tokens: 5 },
    }
  })
  stop = fake.close
  const root = mkdtempSync(join(tmpdir(), 'pc-fat-tail-'))
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
  const result = await session.send('read the big thing')
  expect(result.stoppedBecause).toBe('done')
  const before = session.contextUsage().approxTokens
  expect(before).toBeGreaterThan(40_000) // the fat turn really is in the transcript

  await session.forceCompact()

  // The old share-sized budget kept the 50k message whole inside the tail, the old gate saw
  // an empty middle, and this was 'postponed' with "nothing to compact yet" — at 50k tokens.
  expect(states).toContain('applied')
  expect(states).not.toContain('postponed')
  // The swap must actually have freed the window, not merely reported success: the kept
  // tail is clipped to the absolute cap, so most of the 50k message is gone.
  expect(session.contextUsage().approxTokens).toBeLessThan(before / 2 + 4_000)
})
