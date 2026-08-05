import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { LlamaClient } from '../src/llama/client.js'
import { Session } from '../src/session/session.js'
import { SessionStore } from '../src/session/store.js'
import { createToolset } from '../src/tools/default-set.js'
import { startFakeServer } from './fake-server.js'

/**
 * What a turn that runs for hours leaves behind.
 *
 * Found by auditing what removing the step ceiling made load-bearing: three separate lenses
 * arrived at the same defect independently, which is usually a sign it is the real one.
 */

let stop: (() => Promise<void>) | undefined
const roots: string[] = []

afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tool(id: string, name: string, args: string): unknown {
  return {
    choices: [{
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  }
}

function text(body: string, promptTokens = 100): unknown {
  return {
    choices: [{ message: { role: 'assistant', content: body }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 5 },
  }
}

test('a mid-turn compaction writes the work it is about to summarise away', async () => {
  // The `.jsonl` is documented as the full audit trail, never trimmed, and session search
  // reads the whole of it. Until compaction could run between the steps of a running turn
  // that was true by construction: nothing was ever unwritten when a swap happened.
  //
  // Mid-turn it is the opposite — everything since the turn started is in memory only, and
  // the swap advances the persistence cursor straight past it. Without the flush this test
  // holds, every mid-turn compaction permanently deleted the stretch it summarised, and the
  // resumed conversation would look completely normal while it happened.
  const CONTEXT = 40_000
  let streamed = 0
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: CONTEXT } }
    if (req.url === '/health') return { status: 'ok' }
    // The summary request is the non-streaming one. Session with no delta events uses
    // chat() for both, so tell them apart by the instruction the briefing carries.
    const last = body.messages?.[body.messages.length - 1]
    if (typeof last?.content === 'string' && last.content.includes('compacted to free up context')) {
      return text('BRIEFING: the earlier part, summarised.')
    }
    streamed++
    if (streamed <= 3) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: 'x'.repeat(60_000),
            tool_calls: [{
              id: `c${streamed}`, type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: `f${streamed}.txt`, content: `body ${streamed}` }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        // Nearly the whole window, which is what the between-steps check reads.
        usage: { prompt_tokens: streamed <= 2 ? 38_000 : 9_000, completion_tokens: 20 },
      }
    }
    return text('finished')
  })
  stop = fake.close
  const root = mkdtempSync(join(tmpdir(), 'pc-rec-'))
  roots.push(root)

  const store = new SessionStore(root)
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    store,
    compaction: { contextLength: CONTEXT },
  })
  await session.send('do a lot of work')

  const raw = readFileSync(join(root, '.privatecode', 'sessions', `${session.id}.jsonl`), 'utf8')
  const markers = raw.split('\n').filter((l) => l.includes('"__event":"compaction"'))
  expect(markers.length).toBeGreaterThan(0)

  // The proof: work produced BEFORE the marker is still in the file. Without the flush the
  // first thing in the file after the opening request is the marker itself.
  const beforeMarker = raw.slice(0, raw.indexOf(markers[0]!))
  expect(beforeMarker).toContain('do a lot of work')
  expect(beforeMarker).toContain('f1.txt')
})

test('a crash between the two writes leaves the full pre-swap transcript', async () => {
  // The ordering argument, tested for the first time. The flush writes messages and THEN the
  // marker, so a process that dies between them leaves a file with the messages and no
  // marker — and `load()`, which slices at the last marker, rebuilds everything. Nothing is
  // lost; the swap is simply not applied yet.
  //
  // The version this replaces named that argument in its comment and ran no compaction at
  // all: no `compaction` option, so `compactIfOverWindow` returned immediately,
  // `applyCompactionSwap` was never entered, and its single assertion was fed entirely by
  // send()'s ordinary tail write. Deleting the whole flush block left it green.
  const CONTEXT = 40_000
  let streamed = 0
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: CONTEXT } }
    if (req.url === '/health') return { status: 'ok' }
    const last = body.messages?.[body.messages.length - 1]
    if (typeof last?.content === 'string' && last.content.includes('compacted to free up context')) {
      return text('BRIEFING: earlier work, summarised.')
    }
    streamed++
    if (streamed <= 3) {
      return {
        choices: [{
          message: {
            role: 'assistant', content: null,
            reasoning_content: 'x'.repeat(60_000),
            tool_calls: [{
              id: `c${streamed}`, type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: `p${streamed}.txt`, content: 'x' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: streamed <= 2 ? 38_000 : 9_000, completion_tokens: 20 },
      }
    }
    return text('finished')
  })
  stop = fake.close
  const root = mkdtempSync(join(tmpdir(), 'pc-rec2-'))
  roots.push(root)

  const store = new SessionStore(root)
  // The crash: the marker write never lands, exactly as a power cut between the two
  // `appendFileSync` calls would leave it.
  store.appendCompactionSwap = () => { throw new Error('the process died here') }

  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    store,
    compaction: { contextLength: CONTEXT },
  })
  await session.send('do the work')

  const raw = readFileSync(join(root, '.privatecode', 'sessions', `${session.id}.jsonl`), 'utf8')
  // No marker landed...
  expect(raw).not.toContain('"__event":"compaction"')
  // ...and everything the turn had produced up to that point is on disk, so a reload
  // rebuilds the whole conversation rather than half of one.
  const rebuilt = store.load(session.id).transcript.messages()
  expect(rebuilt.some((m) => m.content === 'do the work')).toBe(true)
  expect(rebuilt.filter((m) => m.role === 'tool')).not.toHaveLength(0)
})

test('the work log counts the turn\'s steps, not the verify-fixer\'s', async () => {
  // `steps` is the only number in the work log that says how much a turn did — and the only
  // one that can say a turn was six hours long rather than one. `verifyAndFix` replaced the
  // whole TurnResult with the fixer's, so a thirteen-step turn whose verify failed once was
  // logged as "1 step". Every turn that writes and ends cleanly runs verify.
  const root = mkdtempSync(join(tmpdir(), 'pc-rec3-'))
  roots.push(root)
  let call = 0
  const fake = await startFakeServer((_b, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    call++
    // Three working steps, then prose; then the fixer answers in one step.
    if (call <= 3) {
      return tool(`c${call}`, 'write_file', JSON.stringify({ path: `f${call}.txt`, content: 'x' }))
    }
    return text('done')
  })
  stop = fake.close

  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    // A check that always fails, so the fixer definitely runs and its result definitely
    // replaces the turn's.
    verify: {
      command: process.platform === 'win32' ? 'cmd /c exit 1' : 'false',
      timeoutMs: 20_000,
      source: 'test',
    },
  })
  const result = await session.send('write three files')

  // Four model calls made the turn itself (3 tool + 1 prose). The fixer's own step count is
  // added, never substituted — before this, the whole turn was reported as the fixer's one
  // step.
  expect(result.steps).toBeGreaterThanOrEqual(4)
})

test('a failed marker write does not duplicate the turn in the session file', async () => {
  // `persistedCount` used to move only after BOTH writes. If the second one failed — a full
  // disk, a scanner holding the file for a moment on Windows — the cursor still pointed at
  // messages already on disk, and send()'s own tail write appended every one of them again:
  // the request twice, tool ids answered twice, a `system` message in the middle of a
  // conversation. It was not confined to the failure either; the NEXT swap read the same
  // stale cursor, so the self-healing path re-wrote the whole history too.
  const CONTEXT = 40_000
  let streamed = 0
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: CONTEXT } }
    if (req.url === '/health') return { status: 'ok' }
    const last = body.messages?.[body.messages.length - 1]
    if (typeof last?.content === 'string' && last.content.includes('compacted to free up context')) {
      return text('BRIEFING: what happened so far.')
    }
    streamed++
    if (streamed <= 3) {
      return {
        choices: [{
          message: {
            role: 'assistant', content: null,
            reasoning_content: 'x'.repeat(60_000),
            tool_calls: [{
              id: `c${streamed}`, type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: `d${streamed}.txt`, content: 'x' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: streamed <= 2 ? 38_000 : 9_000, completion_tokens: 20 },
      }
    }
    return text('finished')
  })
  stop = fake.close
  const root = mkdtempSync(join(tmpdir(), 'pc-dup-'))
  roots.push(root)

  const store = new SessionStore(root)
  // One injected failure of the marker write, exactly as a transient file lock would look.
  let failed = false
  const realSwap = store.appendCompactionSwap.bind(store)
  store.appendCompactionSwap = (id, marker, messages) => {
    if (!failed) { failed = true; throw new Error('EBUSY: the file was locked') }
    realSwap(id, marker, messages)
  }

  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    store,
    compaction: { contextLength: CONTEXT },
  })
  await session.send('do the work')

  const lines = readFileSync(join(root, '.privatecode', 'sessions', `${session.id}.jsonl`), 'utf8')
    .split('\n').filter((l) => l.trim() !== '')
  const requests = lines.filter((l) => l.includes('do the work')).length
  expect(requests).toBe(1)

  // And no message id is answered twice.
  const toolIds = lines
    .map((l) => { try { return JSON.parse(l) as { role?: string; tool_call_id?: string } } catch { return {} } })
    .filter((m) => m.role === 'tool')
    .map((m) => m.tool_call_id)
  expect(new Set(toolIds).size).toBe(toolIds.length)
})
