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

test('a long turn leaves a readable timeline, not one entry written at the end', async () => {
  // The work log gets one entry per turn, which described a night exactly while a turn was
  // capped at forty steps. A six-hour turn produced one heading, one collapsed diff and at
  // most eight commands for the whole night — and the morning review, which is the only
  // reason the file exists, had nothing to read.
  let call = 0
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    call++
    return call <= 3 ? writeStep(`note${call}.txt`, `contents ${call}`) : textStep('done')
  })
  stop = fake.close
  const root = mkdtempSync(join(tmpdir(), 'pc-wl-'))
  roots.push(root)

  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    longRun: true,
    checkpointIntervalMs: 0,
  })
  await session.send('write three notes')

  const log = readFileSync(join(root, '.privatecode', 'worklog.md'), 'utf8')
  // The turn's own entry is still there...
  expect(log).toContain('write three notes')
  // ...and so is the progress inside it, naming the step it was at.
  expect(log).toMatch(/still running, at step \d+/)
})

test('only the tools the log actually uses are retained during the turn', async () => {
  // `commandsFrom` discards every entry that is not a command, at the END of the turn — so
  // retaining the rest kept the full result text of every read, search and edit alive until
  // then, plus each call's arguments, which for a write is the entire new file. Bounded at
  // forty entries while a turn was capped; a turn measured in days retained everything it
  // ever did in order to throw almost all of it away.
  let call = 0
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    call++
    // One big write, then done. A write is not a command, so nothing about it should be
    // held for the log.
    return call === 1
      ? writeStep('big.txt', 'y'.repeat(50_000))
      : textStep('done')
  })
  stop = fake.close
  const root = mkdtempSync(join(tmpdir(), 'pc-tc2-'))
  roots.push(root)

  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    longRun: true,
  })
  await session.send('write a big file')

  // Reaching into the private field on purpose: the whole point of the change is what is
  // NOT held there, and there is no public surface for "what did you keep".
  //
  // ARGS as well as content, and args is where the weight actually is — the first version of
  // this test measured `content` alone and passed with the fix removed, because a write's
  // RESULT is one short line while its ARGUMENTS carry the entire new file. A test that
  // cannot fail proves nothing; this one was checked by taking the filter out.
  const held = (session as unknown as { turnCommands: { content: string; args: string }[] }).turnCommands
  const bytes = held.reduce((n, c) => n + c.content.length + c.args.length, 0)
  expect(bytes).toBeLessThan(1_000)
})
