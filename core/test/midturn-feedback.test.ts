import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
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
        function: { name: 'write_file', arguments: JSON.stringify({ path: `f${n}.txt`, content: `${n}` }) },
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
  expect([...distinct].join(' ')).toMatch(/todo_write/)
  // Never the same threshold twice.
  expect(distinct.size).toBeLessThanOrEqual(3)
})

test('a passing check SAYS it passed, once, and not after every edit', async () => {
  // The silence was deliberate and was the load-bearing mistake. The old comment argued that
  // "a passing check that announced itself would spend context to say nothing happened" — but
  // a model with no channel telling it the build is green has exactly one way to find out,
  // and it spends a whole step on it. Measured: 95 of 621 recorded tool calls, 15% of
  // everything the model did, were it running `dotnet build`/`dotnet test` on itself, with a
  // median of ONE of its own writes between checks. The five-write gate fired strictly less
  // often than the habit it was meant to displace.
  let call = 0
  const fake = await startFakeServer((_b, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    call++
    return call <= 6 ? write(call) : done
  })
  stop = fake.close

  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    engine: new PermissionEngine({ layers: [], mode: 'autopilot', workspaceRoot: root }),
    verify: { command: 'cmd /c exit 0', timeoutMs: 30_000, source: 'test' },
  })
  await session.send('write some files')

  const notes = session.messages()
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .filter((c) => c.includes('cmd /c exit 0'))

  // It said so — that is the whole change.
  expect(notes.length).toBeGreaterThan(0)
  expect(notes[0]).toContain('ok')
  // And exactly once across six writes: the state never changed, so there was nothing more
  // to report. Repeating "still fine" after each of forty edits is the noise the old silence
  // was avoiding, and this keeps the answer without it.
  expect(notes).toHaveLength(1)
})

test('the same failure twice is reported as unchanged rather than repeated in full', async () => {
  // The middle of a twelve-write refactor is legitimately red. Re-reading the same errors
  // twelve times costs more context than the errors are worth.
  let call = 0
  const fake = await startFakeServer((_b, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    call++
    return call <= 6 ? write(call) : done
  })
  stop = fake.close

  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    engine: new PermissionEngine({ layers: [], mode: 'autopilot', workspaceRoot: root }),
    verify: { command: 'cmd /c exit 1', timeoutMs: 30_000, source: 'test' },
  })
  await session.send('write some files')

  const notes = session.messages()
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .filter((c) => c.includes('cmd /c exit 1'))

  const full = notes.filter((n) => n.includes('Checked while you work'))
  const brief = notes.filter((n) => n.includes('still failing, same errors'))
  expect(full).toHaveLength(1)
  expect(brief.length).toBeGreaterThan(0)
})
