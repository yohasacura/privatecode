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

test('a long turn that is cut off still has its work on disk', async () => {
  // The crash case, and the reason the flush is ordered messages-then-marker: if the process
  // dies between the two writes the file holds the messages and no marker, so a reload
  // rebuilds the full pre-swap transcript. Nothing is lost either way.
  const root = mkdtempSync(join(tmpdir(), 'pc-rec2-'))
  roots.push(root)
  const fake = await startFakeServer((_b, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    return tool('c1', 'write_file', JSON.stringify({ path: 'a.txt', content: 'hi' }))
  })
  stop = fake.close

  const store = new SessionStore(root)
  const controller = new AbortController()
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    maxSteps: 3,
    store,
  })
  setTimeout(() => controller.abort(), 50)
  await session.send('write something', controller.signal).catch(() => {})

  // Whatever the abort did to the turn, the session exists and is loadable — the failure
  // this guards against is a session file that cannot be resumed at all.
  const { transcript } = store.load(session.id)
  expect(transcript.messages().length).toBeGreaterThan(0)
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
