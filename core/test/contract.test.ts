import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { LlamaClient } from '../src/llama/client.js'
import { Session } from '../src/session/session.js'
import { SessionStore } from '../src/session/store.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { Toolset } from '../src/tools/default-set.js'
import {
  looksLikeTask, parseAcceptance, parseContract, renderContract,
} from '../src/session/contract.js'
import { collapseSupersededReads } from '../src/session/compaction.js'
import type { ChatMessage } from '../src/llama/types.js'
import { startFakeServer } from './fake-server.js'
import type { Tool } from '../src/tools/types.js'

/**
 * The task contract: distilled once, held everywhere, enforced at the end.
 *
 * The failure it exists for, measured in the recorded corpus: a turn that made 38 edits
 * across 11 files and ended "done" with criteria the user stated plainly simply unmet.
 */

let stop: (() => Promise<void>) | undefined
const dirs: string[] = []
afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('looksLikeTask', () => {
  test('a one-liner is not a contract-worthy task', () => {
    expect(looksLikeTask('поправь опечатку в README')).toBe(false)
    expect(looksLikeTask('what does this function do?')).toBe(false)
  })
  test('length alone qualifies', () => {
    expect(looksLikeTask('x'.repeat(220))).toBe(true)
  })
  test('shorter but visibly multi-part qualifies', () => {
    expect(looksLikeTask(
      'Rename the cache module to store. Update every import to match. Keep the tests green afterwards.',
    )).toBe(true)
  })
})

describe('parsing generated documents', () => {
  test('a healthy contract round-trips', () => {
    const c = parseContract(JSON.stringify({
      goal: 'g', criteria: ['tests pass', 'file exists'], constraints: ['do not touch x'],
      interfaces: 'foo(a: string): number',
    }))
    expect(c).toMatchObject({ goal: 'g', criteria: ['tests pass', 'file exists'] })
    expect(renderContract(c!)).toContain('Done only when')
    expect(renderContract(c!)).toContain('do not touch x')
  })
  test('no goal or no criteria is no contract', () => {
    expect(parseContract(JSON.stringify({ goal: '', criteria: ['a'], constraints: [] }))).toBeNull()
    expect(parseContract(JSON.stringify({ goal: 'g', criteria: [], constraints: [] }))).toBeNull()
    expect(parseContract('{ not json')).toBeNull()
  })
  test('acceptance report splits met from unmet', () => {
    const r = parseAcceptance(JSON.stringify({
      items: [
        { criterion: 'a', met: true, evidence: 'ran the suite' },
        { criterion: 'b', met: false, evidence: 'never demonstrated' },
      ],
    }))
    expect(r).toEqual({ met: 1, unmet: [{ criterion: 'b', why: 'never demonstrated' }] })
  })
})

describe('renderCheckedState', () => {
  test('met by number, unmet by number with the reason', async () => {
    const { renderCheckedState } = await import('../src/session/contract.js')
    const contract = { goal: 'g', criteria: ['a', 'b', 'c'], constraints: [] }
    const state = renderCheckedState(contract, {
      met: 2,
      unmet: [{ criterion: 'b', why: 'no assertion write happened' }],
    })
    expect(state).toBe('1,3 met; 2 UNMET (no assertion write happened)')
    expect(renderContract({ ...contract, checkedState: state })).toContain('Last audit: 1,3 met')
  })
})

describe('collapseSupersededReads', () => {
  const read = (id: string, path: string, body: string): ChatMessage[] => [
    { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] },
    { role: 'tool', tool_call_id: id, content: body },
  ]
  const edit = (id: string, path: string): ChatMessage[] => [
    { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path }) } }] },
    { role: 'tool', tool_call_id: id, content: '--- x\n+++ x\n@@ line 1 @@\n+y' },
  ]
  const big = 'x'.repeat(1_000)

  test('an early read superseded by a later read of the same path is stubbed, and says so', () => {
    const tail = [...read('r1', 'a.ts', big), ...read('r2', 'a.ts', big)]
    const out = collapseSupersededReads(tail)
    expect(out[1]!.content).toContain('superseded read of a.ts')
    expect(out[1]!.content).toContain('re-read')
    expect(out[3]!.content).toBe(big) // the LAST read is the current belief and stays whole
  })

  test('a read followed by an edit of the same path is stubbed as edited', () => {
    const tail = [...read('r1', 'a.ts', big), ...edit('e1', 'a.ts')]
    expect(collapseSupersededReads(tail)[1]!.content).toContain('edited')
  })

  test('a small read, a different path, and an un-superseded read all stay whole', () => {
    const tail = [
      ...read('r1', 'small.ts', 'tiny'),
      ...read('r2', 'b.ts', big),
      ...read('r3', 'c.ts', big),
    ]
    const out = collapseSupersededReads(tail)
    expect(out[1]!.content).toBe('tiny')
    expect(out[3]!.content).toBe(big)
    expect(out[5]!.content).toBe(big)
  })
})

/** ~230 chars, multi-part: crosses the looksLikeTask threshold deliberately. */
const BIG_TASK =
  'Add a clamp function to the math module and export it. Then add three assertions to ' +
  'the checks file covering the ordinary case, the boundary case and the error case. ' +
  'Keep every existing check green, and do not rename anything that already exists.'

test('the whole arc: distilled up front, gate catches a missed criterion, fix round closes it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-contract-'))
  dirs.push(root)

  const writeTool: Tool<Record<string, unknown>> = {
    name: 'write_file',
    readOnly: false,
    description: 'write',
    parameters: { type: 'object', properties: {} },
    validate: (args) => ({ ok: true, args: args as Record<string, unknown> }),
    execute: async () => ({ ok: true, content: 'wrote' }),
  }
  const registry = new ToolRegistry()
  registry.register(writeTool)

  let acceptanceCalls = 0
  let fixerSawGaps = false
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 131_072 } }
    if (req.url === '/health') return { status: 'ok' }
    const tools = (body.tools ?? []) as { function: { name: string } }[]
    const toolNames = tools.map((t) => t.function.name)

    // The distiller: forced set_contract, before any work.
    if (toolNames.length === 1 && toolNames[0] === 'set_contract') {
      return {
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'd1', type: 'function',
              function: {
                name: 'set_contract',
                arguments: JSON.stringify({
                  goal: 'clamp exists, is covered, everything stays green',
                  criteria: ['clamp added and exported', 'three assertions added', 'existing checks stay green'],
                  constraints: ['no renames of existing symbols'],
                }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 900, completion_tokens: 60 },
      }
    }

    // The gate: first call reports one criterion unmet, the re-check affirms everything.
    if (toolNames.length === 1 && toolNames[0] === 'report_acceptance') {
      acceptanceCalls++
      const allMet = acceptanceCalls > 1
      return {
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{
              id: `a${acceptanceCalls}`, type: 'function',
              function: {
                name: 'report_acceptance',
                arguments: JSON.stringify({
                  items: [
                    { criterion: 'clamp added and exported', met: true, evidence: 'write landed' },
                    { criterion: 'three assertions added', met: allMet, evidence: allMet ? 'write landed' : 'no assertion write happened' },
                    { criterion: 'existing checks stay green', met: true, evidence: 'nothing removed' },
                  ],
                }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1_500, completion_tokens: 80 },
      }
    }

    // Ordinary turn traffic. The fixer round's request carries the gap message.
    const last = (body.messages as { role: string; content?: string | null }[])
      .filter((m) => m.role === 'user').at(-1)
    // Latched: after the fixer's write lands, the same user message is still the newest
    // one, and answering it with another write forever would loop the fixer turn.
    if (!fixerSawGaps && typeof last?.content === 'string' && last.content.includes('Unmet criteria')) {
      fixerSawGaps = true
      return {
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'w2', type: 'function', function: { name: 'write_file', arguments: '{"path":"checks.js"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1_600, completion_tokens: 30 },
      }
    }
    const wroteAlready = (body.messages as { role: string }[]).some((m) => m.role === 'tool')
    if (!wroteAlready) {
      return {
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"math.js"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1_200, completion_tokens: 30 },
      }
    }
    return {
      // A CLAIMED finish — the gate deliberately runs only on one (saysFinished), so an
      // intermediate "done, moving on" turn does not pay the audit's cache displacement.
      choices: [{ message: { role: 'assistant', content: 'All done, everything works.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1_400, completion_tokens: 10 },
    }
  })
  stop = fake.close

  const store = new SessionStore(root)
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: { registry } as Toolset,
    workspaceRoot: root,
    mode: 'autopilot',
    store,
  })
  const result = await session.send(BIG_TASK)

  expect(result.stoppedBecause).toBe('done')
  // The contract was distilled, persisted, and its note reached the transcript.
  expect(store.load(session.id).meta.contract?.criteria).toHaveLength(3)
  const noteInTranscript = session.messages().some((m) =>
    typeof m.content === 'string' && m.content.includes('TASK CONTRACT'))
  expect(noteInTranscript).toBe(true)
  // The gate ran, found the gap, the fixer was told EXACTLY the gap, and the re-check passed.
  expect(acceptanceCalls).toBe(2)
  expect(fixerSawGaps).toBe(true)
})

describe('parseSuggestions', () => {
  test('caps lists, trims, and treats an empty answer as nothing to show', async () => {
    const { parseSuggestions } = await import('../src/session/contract.js')
    expect(parseSuggestions('not json')).toBeNull()
    expect(parseSuggestions(JSON.stringify({ criteria: [], constraints: [], questions: [] }))).toBeNull()
    const s = parseSuggestions(JSON.stringify({
      criteria: [' a ', '', 3, 'b'], constraints: ['x'], questions: ['q1', 'q2', 'q3', 'q4', 'q5'],
    }))
    expect(s).toEqual({ criteria: ['a', 'b'], constraints: ['x'], questions: ['q1', 'q2', 'q3', 'q4'] })
  })
})
