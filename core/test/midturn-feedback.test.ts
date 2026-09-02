import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../src/session/session.js'
import { LlamaClient } from '../src/llama/client.js'
import { createToolset } from '../src/tools/default-set.js'
import { PermissionEngine } from '../src/permissions/engine.js'
import { startFakeServer } from './fake-server.js'

/**
 * Two things the model was never told while it worked: that it had broken the build, and
 * that its context was running out.
 *
 * Measured across fifteen real sessions: a turn runs thirty-odd steps, and the check that
 * would catch a mistake made at step four ran after step thirty — by which point the
 * context explaining it is the context compaction just replaced.
 */

let root: string
let stop: (() => Promise<void>) | undefined
const roots: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-mid-'))
  roots.push(root)
  mkdirSync(join(root, '.privatecode'), { recursive: true })
})
afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

const write = (n: number) => ({
  choices: [{
    message: {
      role: 'assistant',
      tool_calls: [{
        id: `c${n}`, type: 'function',
        function: { name: 'Write', arguments: JSON.stringify({ path: `f${n}.txt`, content: `${n}` }) },
      }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 100, completion_tokens: 5 },
})
const done = { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }

test('a failing project check reaches the model DURING the turn, not after it', async () => {
  let call = 0
  const fake = await startFakeServer((_b, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    call++
    return call <= 8 ? write(call) : done
  })
  stop = fake.close

  const seen: { ok: boolean; attempt: number }[] = []
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    engine: new PermissionEngine({ layers: [], mode: 'autopilot', workspaceRoot: root }),
    // Exits non-zero, so it always "fails" — the point is when the model hears about it.
    verify: { command: 'cmd /c exit 1', timeoutMs: 30_000, source: 'test' },
    onVerify: (info) => seen.push({ ok: info.ok, attempt: info.attempt }),
  })
  await session.send('write some files')

  // At least one check ran while writes were still happening, not only in the end-of-turn
  // fix loop. Both fire here; what matters is that the mid-turn one exists at all.
  expect(seen.length).toBeGreaterThan(1)
  expect(seen.every((s) => !s.ok)).toBe(true)
})

test('a turn that writes nothing never triggers a check', async () => {
  const fake = await startFakeServer((_b, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    return done
  })
  stop = fake.close
  const seen: unknown[] = []
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    engine: new PermissionEngine({ layers: [], mode: 'autopilot', workspaceRoot: root }),
    verify: { command: 'cmd /c exit 1', timeoutMs: 30_000, source: 'test' },
    onVerify: (info) => seen.push(info),
  })
  await session.send('just answer')
  // Nothing was written, so nothing can have been broken — and a build nobody needed is
  // minutes of a turn spent saying so.
  expect(seen).toEqual([])
})

test('the model is told when its context is filling, once per threshold', async () => {
  // The only actor who can act on this — write a note, close a sub-task — and the only one
  // who was never told. The status bar has shown it to the user since the beginning.
  let call = 0
  const bodies: { messages: { role: string; content?: string }[] }[] = []
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 1000 } }
    if (req.url === '/health') return { status: 'ok' }
    bodies.push(body as { messages: { role: string; content?: string }[] })
    call++
    // Prompt tokens climb past 60% and then 75% of a 1000-token window.
    const prompt = call === 1 ? 300 : call === 2 ? 650 : 800
    return {
      ...(call <= 3 ? write(call) : done),
      usage: { prompt_tokens: prompt, completion_tokens: 5 },
    }
  })
  stop = fake.close

  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    engine: new PermissionEngine({ layers: [], mode: 'autopilot', workspaceRoot: root }),
    compaction: { contextLength: 1000, triggerRatio: 0.99 },
  })
  await session.send('write some files')

  const notices = bodies.flatMap((b) => b.messages)
    .filter((m) => typeof m.content === 'string' && m.content.includes('Context is about'))
  // Deduplicated by content: the same appended message reappears in every later request,
  // so what is counted is how many DISTINCT thresholds were announced.
  const distinct = new Set(notices.map((m) => m.content))
  expect(distinct.size).toBeGreaterThan(0)
  expect([...distinct].join(' ')).toMatch(/remember/)
  expect([...distinct].join(' ')).toMatch(/TodoWrite/)
  // Never the same threshold twice.
  expect(distinct.size).toBeLessThanOrEqual(3)
})

/** A step that reads instead of writing — the boundary that ends a run of edits. */
const readStep = (n: number) => ({
  choices: [{
    message: {
      role: 'assistant',
      tool_calls: [{
        id: `r${n}`, type: 'function',
        function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
      }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 100, completion_tokens: 5 },
})

/**
 * Only the notes the MID-TURN check writes, told apart from the end-of-turn fixer's rounds by
 * their wording. The distinction is the whole point of these tests: the fixer running after a
 * turn has ended is not an interruption of anything.
 */
const midTurnNotes = (session: Session): string[] =>
  session.messages()
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .filter((c) => c.startsWith('[Checked while you work')
      || /^\[.*: ok, [\d.]+s\]$/.test(c)
      || c.includes('still failing, same errors'))

async function run(
  script: (call: number) => unknown, command: string,
): Promise<Session> {
  const fake = await startFakeServer((_b, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    return script(0)
  })
  stop = fake.close
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    engine: new PermissionEngine({ layers: [], mode: 'autopilot', workspaceRoot: root }),
    verify: { command, timeoutMs: 30_000, source: 'test' },
  })
  await session.send('do the work')
  return session
}

test('the check runs right after the step that wrote, and a repeat failure costs one line', async () => {
  // This used to wait for the run of writes to END — the first step that read or ran
  // something — so as not to interrupt a multi-file change while it was legitimately red.
  // Measured against what the model does with that step (spike/speed-baseline-probe.mts):
  // it runs the build itself, every time, so the deferred check never arrived before a step
  // had already been spent on it by hand. The check now lands with the edit's own result,
  // and the note says to carry on when the red is unfinished work.
  //
  // Asserted by POSITION: the first note arrives BEFORE the last write, and the same failure
  // is reported in full once and as "still failing" after that — one line, not the error
  // list six times.
  let call = 0
  const session = await run(() => { call++; return call <= 6 ? write(call) : done }, 'cmd /c exit 1')

  const messages = session.messages()
  const lastWrite = messages.map((m, i) => ({ m, i }))
    .filter(({ m }) => (m.tool_calls ?? []).some((c) => c.function.name === 'Write'))
    .map(({ i }) => i)
    .pop()
  expect(lastWrite).toBeDefined()

  const notes = messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === 'user' && typeof m.content === 'string'
      && (m.content.startsWith('[Checked while you work') || m.content.includes('still failing')))
  expect(notes.length).toBeGreaterThan(0)
  expect(notes[0]!.i).toBeLessThan(lastWrite!)
  const full = notes.filter(({ m }) => (m.content as string).startsWith('[Checked while you work'))
  expect(full).toHaveLength(1)
  expect(full[0]!.m.content).toContain('spans several files')
})

test('the check fires the moment the model does something other than write', async () => {
  // A step that reads is the model saying the edit is as done as it is going to get. That is
  // the boundary worth checking on, and it costs at most one step of delay.
  let call = 0
  const session = await run(() => {
    call++
    if (call <= 2) return write(call)
    if (call === 3) return readStep(1)
    return done
  }, 'cmd /c exit 0')

  const notes = midTurnNotes(session)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('ok')
})

test('a very long run of edits is checked anyway, so a mistake is not carried twenty files', async () => {
  // The other half. A rename touching twenty files must not go unchecked for twenty steps:
  // the whole value of the check is that it fires near the mistake.
  let call = 0
  const session = await run(() => { call++; return call <= 12 ? write(call) : done }, 'cmd /c exit 1')

  expect(midTurnNotes(session).length).toBeGreaterThan(0)
})
