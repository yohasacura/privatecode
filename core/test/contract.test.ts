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
  looksLikeTask, parseAcceptance, parseContract, renderCheckedState, renderContract,
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

/**
 * The audit reports criteria back in the model's own words, and the contract is scored
 * against them by NAME. Exact string equality made every restatement a silent pass: the
 * gap matched nothing, so nothing was recorded as unmet and `checkedState` was promoted
 * into message 0 as "Last audit: 1,2,3 met" at every later compaction — while the fix
 * round for the gap was still running.
 */
describe('matching an audit report back to the contract criteria', () => {
  const contract = {
    goal: 'fix the crash',
    criteria: [
      'The reported crash no longer happens',
      'A reproduction (script or test) demonstrably FAILED before the fix — its red run ' +
      'is in the conversation — and passes after it',
      'No existing check regressed',
    ],
    constraints: [],
  }

  test('a shortened restatement of a criterion is still recorded as UNMET', () => {
    const state = renderCheckedState(contract, {
      met: 2,
      unmet: [{
        criterion: 'Reproduction test failed before and passes after.',
        why: 'no red run is in the conversation',
      }],
    })
    expect(state).toBe('1,3 met; 2 UNMET (no red run is in the conversation)')
  })

  test('case, trailing punctuation and dash style are not a different criterion', () => {
    const state = renderCheckedState(contract, {
      met: 2,
      unmet: [{ criterion: 'the reported crash no longer happens.', why: 'still crashes' }],
    })
    expect(state).toBe('2,3 met; 1 UNMET (still crashes)')
  })

  test('a gap naming no recognisable criterion is spelled out instead of vanishing', () => {
    const state = renderCheckedState(contract, {
      met: 3,
      unmet: [{ criterion: 'the docs were never updated', why: 'nothing here touches docs' }],
    })
    expect(state).toContain('not matched to a criterion')
    expect(state).toContain('the docs were never updated')
    expect(state).toContain('nothing here touches docs')
  })

  test('a restatement that fits two criteria equally well ticks neither', () => {
    // The whole point of the looser match is that it must stay unable to tick the WRONG
    // line: "tests pass" sits inside both of these, so it names neither.
    const twins = {
      goal: 'green everywhere',
      criteria: ['the tests pass on Windows', 'the tests pass on Linux'],
      constraints: [],
    }
    const state = renderCheckedState(twins, {
      met: 1, unmet: [{ criterion: 'tests pass', why: 'never run' }],
    })
    expect(state).toContain('1,2 met')
    expect(state).toContain('not matched to a criterion')
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

/**
 * Where the turn STARTS, once a compaction has landed in the middle of it.
 *
 * The swap rebuilds the transcript as [system, briefing, (ack,) ...kept tail], and the ack
 * is skipped whenever the tail already opens on an assistant message — which is the ordinary
 * shape of a mid-turn boundary. The remap used to clamp the turn-start index to a fixed 3,
 * so in that case it pointed one message PAST the first kept message; when that message
 * carried the turn's `write_file` calls, the created file's body — the only source
 * `turnDiffText` has for a file that did not exist before — was silently missing from the
 * independent review, and the review passed on an empty diff.
 */
test('a mid-turn compaction leaves the diff review reading the turn it belongs to', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-turnstart-'))
  dirs.push(root)

  /** Big enough on its own to clear DIFF_REVIEW_MIN_CHARS, so the review runs iff the
   * write_file CALL is inside the reviewed slice. */
  const CREATED = `export function clamp() {}\n${'z'.repeat(3_000)}`
  const CONTEXT = 40_000

  const mkTool = (name: string, content: string, readOnly: boolean): Tool<Record<string, unknown>> => ({
    name, readOnly, description: name,
    parameters: { type: 'object', properties: {} },
    validate: (args) => ({ ok: true, args: args as Record<string, unknown> }),
    execute: async () => ({ ok: true, content }),
  })
  const registry = new ToolRegistry()
  registry.register(mkTool('read_file', 'q'.repeat(20_000), true))
  registry.register(mkTool('write_file', 'wrote', false))

  const criteria = ['clamp exists', 'clamp is covered']
  const reviewed: string[] = []
  let turnCall = 0
  const call = (name: string, args: unknown, promptTokens: number) => ({
    choices: [{
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: `t${turnCall}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 20 },
  })

  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: CONTEXT } }
    if (req.url === '/health') return { status: 'ok' }
    const names = ((body.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name)
    const forced = names.length === 1 ? names[0] : undefined
    if (forced === 'set_contract') {
      return call('set_contract', { goal: 'clamp exists and is covered', criteria, constraints: [] }, 900)
    }
    if (forced === 'report_acceptance') {
      return call('report_acceptance', {
        items: criteria.map((c) => ({ criterion: c, met: true, evidence: 'the write landed' })),
      }, 1_500)
    }
    if (forced === 'review_verdict') {
      reviewed.push(JSON.stringify(body.messages))
      return call('review_verdict', { issues: [] }, 1_500)
    }
    const last = (body.messages as { content?: string | null }[]).at(-1)
    if (typeof last?.content === 'string' && last.content.includes('compacted to free up context')) {
      return { choices: [{ message: { role: 'assistant', content: 'BRIEFING: a file was created.' }, finish_reason: 'stop' }] }
    }
    turnCall++
    // Turn one is only there to push the second turn's start index past the fixed 3 the
    // remap used to clamp to — on the very first turn of a session the clamp was harmless.
    if (turnCall === 1) {
      return {
        choices: [{ message: { role: 'assistant', content: 'It reads files.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 5 },
      }
    }
    // Two fat reads build a middle worth summarising, then the write, and only then a
    // prompt count the pre-step check reads as "this no longer fits".
    if (turnCall === 2) return call('read_file', { path: 'a.ts' }, 2_000)
    if (turnCall === 3) return call('read_file', { path: 'b.ts' }, 3_000)
    if (turnCall === 4) return call('write_file', { path: 'clamp.ts', content: CREATED }, 37_000)
    return {
      choices: [{ message: { role: 'assistant', content: 'All done, everything works.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9_000, completion_tokens: 5 },
    }
  })
  stop = fake.close

  const states: string[] = []
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: { registry } as Toolset,
    workspaceRoot: root,
    mode: 'autopilot',
    store: new SessionStore(root),
    // keepRecent 2 walks the tail back onto the assistant message carrying the write call,
    // which is the boundary shape where the ack is skipped and the old clamp lost a message.
    compaction: { contextLength: CONTEXT, keepRecent: 2 },
    onCompaction: (e) => states.push(e.state),
  })

  await session.send('what does read_file do?')
  const result = await session.send(BIG_TASK)

  expect(result.stoppedBecause).toBe('done')
  expect(states).toContain('applied')
  // The swap really did land mid-turn: the briefing is in the transcript the turn finished on.
  expect(session.messages().some((m) =>
    typeof m.content === 'string' && m.content.includes('BRIEFING: a file was created'))).toBe(true)
  // And the review ran on THIS turn's creation rather than on an empty diff.
  expect(reviewed).toHaveLength(1)
  expect(reviewed[0]).toContain('export function clamp')
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

describe('parseExpanded', () => {
  test('returns the trimmed brief, and null for garbage or emptiness', async () => {
    const { parseExpanded } = await import('../src/session/contract.js')
    expect(parseExpanded('not json')).toBeNull()
    expect(parseExpanded(JSON.stringify({ expanded: '   ' }))).toBeNull()
    expect(parseExpanded(JSON.stringify({ expanded: 42 }))).toBeNull()
    expect(parseExpanded(JSON.stringify({ expanded: '  Сделай кнопку через --accent из App.css.  ' })))
      .toBe('Сделай кнопку через --accent из App.css.')
  })
})
