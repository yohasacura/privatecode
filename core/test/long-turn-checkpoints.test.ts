import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { LlamaClient } from '../src/llama/client.js'
import { Session } from '../src/session/session.js'
import { createToolset } from '../src/tools/default-set.js'
import { startFakeServer } from './fake-server.js'

/**
 * A long turn leaves points to come back to, not one.
 *
 * `recordTurn` snapshots once, after the turn ends. That was never more than a few minutes
 * of work while a turn was capped at forty steps — and when the cap came off, it silently
 * became "one undo point for however many hours the turn ran". A rewind is the only thing
 * that makes an autonomous run safe to leave alone, so an undo that can only throw away the
 * entire session is not much of one.
 */

let stop: (() => Promise<void>) | undefined
const roots: string[] = []

afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Plain completions, not SSE: a `Session` with no delta events wired calls `chat()`, and
// this test is about what the turn leaves behind rather than how it is rendered.

/** One step that writes a file. */
function writeStep(path: string, content: string): unknown {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `c-${path}`,
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path, content }) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  }
}

function textStep(text: string): unknown {
  return {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 5 },
  }
}

test('a turn that writes for a long time leaves a checkpoint per stretch of work', async () => {
  let call = 0
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    call++
    return call <= 3 ? writeStep(`file${call}.txt`, `contents ${call}`) : textStep('done')
  })
  stop = fake.close
  const root = mkdtempSync(join(tmpdir(), 'pc-ckpt-'))
  roots.push(root)

  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot', // writes without stopping to ask; the point here is the snapshots
    longRun: true,
    // The real interval is two minutes. Zero is what makes this testable without waiting,
    // and is also the documented setting for a small workspace that can afford it.
    checkpointIntervalMs: 0,
  })

  await session.send('write three files')

  const checkpoints = await session.listCheckpoints()
  const midTurn = checkpoints.filter((c) => c.step !== undefined)

  // Every file landed...
  for (const n of [1, 2, 3]) {
    expect(readFileSync(join(root, `file${n}.txt`), 'utf8')).toBe(`contents ${n}`)
  }
  // ...and the turn was snapshotted as it went, not only at the end. Four is the baseline
  // plus the end-of-turn one; anything above that is the turn checkpointing itself.
  expect(checkpoints.length).toBeGreaterThan(2)
  expect(midTurn.length).toBeGreaterThan(0)
})
