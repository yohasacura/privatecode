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
  withUnreportedCriteria, UNREPORTED_REASON, resolveReportedCriteria,
  CONTRACT_SCHEMA, distillContract,
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
  /**
   * A general RULE the request states must survive as a criterion, and it arrives in its own
   * field so the grammar has to produce it.
   *
   * Watched live: "slugs contain only lowercase letters, digits and single hyphens" came back
   * as ten example-shaped criteria with the rule stated nowhere, the agent shipped code that
   * passed all ten, and the audit correctly affirmed 10 of 10 while
   * `slug('Hello, World!')` still returned `'hello,-world!'`. Measured on this server, the
   * prose telling the distiller not to do that was ignored 1 run in 2; a required field
   * ordered ahead of `criteria` was not.
   */
  test('rules become criteria, and lead them', () => {
    const c = parseContract(JSON.stringify({
      goal: 'g',
      rules: ['slugs contain only lowercase letters, digits and single hyphens'],
      criteria: ['a test covers the rule'],
      constraints: [],
    }))
    expect(c!.criteria).toEqual([
      'slugs contain only lowercase letters, digits and single hyphens',
      'a test covers the rule',
    ])
  })

  test('a rule restated among the criteria is not audited twice', () => {
    // It is told not to restate one, and it sometimes does. The comparison is on the words
    // that carry meaning, because a restatement is rarely byte-identical.
    const c = parseContract(JSON.stringify({
      goal: 'g',
      rules: ['every amount is rounded before it is summed'],
      criteria: ['Every amount is rounded before it is summed.', 'a test covers the rule'],
      constraints: [],
    }))
    expect(c!.criteria).toEqual([
      'every amount is rounded before it is summed',
      'a test covers the rule',
    ])
  })

  test('a contract with no rules is unchanged — most requests state none', () => {
    const c = parseContract(JSON.stringify({
      goal: 'rename fetchUser to loadUser',
      rules: [],
      criteria: ['every call site uses loadUser', 'the suite passes'],
      constraints: [],
    }))
    expect(c!.criteria).toEqual(['every call site uses loadUser', 'the suite passes'])
  })

  test('rules alone are enough to be a contract', () => {
    // `criteria` empty is not "no contract" when the request stated a rule: the rule IS the
    // done-criterion, and refusing the contract there would drop the strongest thing in it.
    const c = parseContract(JSON.stringify({
      goal: 'g', rules: ['no endpoint returns a raw stack trace'], criteria: [], constraints: [],
    }))
    expect(c!.criteria).toEqual(['no endpoint returns a raw stack trace'])
  })

  test('no goal or no criteria is no contract', () => {
    expect(parseContract(JSON.stringify({ goal: '', criteria: ['a'], constraints: [] }))).toBeNull()
    expect(parseContract(JSON.stringify({ goal: 'g', criteria: [], constraints: [] }))).toBeNull()
    expect(parseContract('{ not json')).toBeNull()
  })
  test('acceptance report splits met from unmet, resolved by NUMBER', () => {
    // The audit answers with the criterion's index, so every string here is the contract's
    // own: there is nothing for the model to paraphrase and nothing to match.
    const r = parseAcceptance(JSON.stringify({
      items: [
        { index: 1, met: true, evidence: 'ran the suite' },
        { index: 2, met: false, evidence: 'never demonstrated' },
      ],
    }), ['a', 'b'])
    expect(r).toEqual({
      met: 1,
      metCriteria: ['a'],
      unmet: [{ criterion: 'b', why: 'never demonstrated' }],
      // Exactly what it spoke about, as a fact rather than an inference.
      reported: [0, 1],
    })
  })

  test('an index outside the contract is dropped, not guessed at', () => {
    const r = parseAcceptance(JSON.stringify({
      items: [
        { index: 1, met: true, evidence: 'ok' },
        { index: 9, met: false, evidence: 'out of range' },
        { index: 1, met: false, evidence: 'a repeat; the first verdict stands' },
      ],
    }), ['a', 'b'])
    expect(r!.metCriteria).toEqual(['a'])
    expect(r!.unmet).toEqual([])
    expect(r!.reported).toEqual([0])
  })
})

describe('an audit that does not cover every criterion', () => {
  const contract = {
    goal: 'g',
    criteria: ['the counter never repeats a number', 'the suite passes on Windows', 'no public API changes'],
    constraints: [],
  }

  test('a criterion the audit never mentioned is UNMET, not met', () => {
    // The report is well-formed and parses clean; it just says nothing about criterion 3.
    // Read literally that used to mean "no gap recorded", which every reader downstream
    // treated as an affirmation -- so a short report ended the turn, ticked the plan and
    // retired the gate over work nothing had looked at.
    const raw = parseAcceptance(JSON.stringify({
      items: [
        { index: 1, met: true, evidence: 'the repro passes' },
        { index: 2, met: true, evidence: 'npm test, 1114 passing' },
      ],
    }), contract.criteria)!
    expect(raw.unmet).toEqual([])

    const full = withUnreportedCriteria(contract.criteria, raw)
    expect(full.unmet.map((u) => u.criterion)).toEqual(['no public API changes'])
    expect(full.unmet[0]!.why).toBe(UNREPORTED_REASON)
    // ...so the gate cannot close, and the note says where the task actually stands.
    expect(renderCheckedState(contract, full)).toContain('3 UNMET')
  })

  test('a report that covers everything is passed through untouched', () => {
    const raw = parseAcceptance(JSON.stringify({
      items: contract.criteria.map((_c, i) => ({ index: i + 1, met: true, evidence: 'shown above' })),
    }), contract.criteria)!
    expect(withUnreportedCriteria(contract.criteria, raw)).toBe(raw)
    expect(renderCheckedState(contract, raw)).toBe('1,2,3 met')
  })

  test('a paraphrase can no longer produce a phantom gap, because there is no text to match', () => {
    // This is what the numbering retires. Asked to retype each criterion, the model
    // paraphrased; a paraphrase the matcher could not place stayed in `unmet` AND its
    // criterion was appended as unreported, so the fixer received the same criterion twice
    // with contradictory reasons -- one of which ("the audit did not report on this") no
    // edit could ever close -- and `unmet.length` could exceed `criteria.length`.
    const raw = parseAcceptance(JSON.stringify({
      items: [
        { index: 1, met: true, evidence: 'ok' },
        { index: 2, met: false, evidence: 'not run' },
        { index: 3, met: true, evidence: 'diff is internal' },
      ],
    }), contract.criteria)!
    const full = withUnreportedCriteria(contract.criteria, raw)
    expect(full.unmet.map((u) => u.why)).not.toContain(UNREPORTED_REASON)
    expect(full.unmet).toHaveLength(1)
    expect(full.unmet.length).toBeLessThanOrEqual(contract.criteria.length)
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

/**
 * The distiller's ask, read as text.
 *
 * Both halves have to be there, because they guard opposite errors and each was found the
 * hard way. The VERBATIM half stops a specific requirement from being widened into something
 * easier. The RULES half stops a general one from being narrowed into a list of instances —
 * measured live: "slugs contain only lowercase letters, digits and single hyphens" came back
 * as example-shaped criteria with the rule stated nowhere, and the audit then affirmed every
 * one of them over an implementation that still returned `'hello,-world!'`.
 *
 * Read from the PROMPT, never from the schema: a `response_format` schema is compiled to a
 * grammar and contributes zero prompt tokens, so a rule written into a `description` is
 * declared, tested and invisible.
 */
describe('what the distiller is actually told', () => {
  async function askText(): Promise<string> {
    let body: any
    const fake = await startFakeServer((b) => {
      body = b
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }] }
    })
    try {
      await distillContract(
        new LlamaClient({ baseUrl: fake.url, model: 'test' }), [],
        'make the invoice numbering gap-free, and add a test for it, and do not touch the schema',
      )
    } finally {
      await fake.close()
    }
    const messages = (body?.messages ?? []) as { content?: string | null }[]
    return messages.map((m) => m.content ?? '').join(' ')
  }

  test('it is told to keep a specific requirement VERBATIM', async () => {
    expect(await askText()).toContain('VERBATIM')
  })

  test('it is told a rule stays a rule, with the failure named', async () => {
    const sent = await askText()
    // The field, and what goes in it.
    expect(sent).toContain('rules —')
    expect(sent).toMatch(/EVERY input/)
    // The two ways a rule gets lost, both named so a reword cannot quietly drop one.
    expect(sent).toMatch(/do not split it into the parts you would implement/)
    expect(sent).toMatch(/is not a criterion/)
  })

  test('the rules field is declared, and ahead of criteria so it is generated first', () => {
    // Property ORDER is enforced by the grammar -- verified against the live server when the
    // acceptance schema was reordered -- so `rules` coming first is what makes the model
    // isolate them before it writes the criteria list.
    const shape = CONTRACT_SCHEMA as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect(shape.required).toContain('rules')
    const keys = Object.keys(shape.properties)
    expect(keys.indexOf('rules')).toBeLessThan(keys.indexOf('criteria'))
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
    const schemaName = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name

    // The distiller: a forced `contract` schema, before any work.
    if (schemaName === 'contract') {
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({
              goal: 'clamp exists, is covered, everything stays green',
              criteria: ['clamp added and exported', 'three assertions added', 'existing checks stay green'],
              constraints: ['no renames of existing symbols'],
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 900, completion_tokens: 60 },
      }
    }

    // The gate: first call reports one criterion unmet, the re-check affirms everything.
    // Recognised by the SCHEMA it forces, not by a one-tool array -- the gate now sends the
    // session's own tools unchanged so its request stays a warm append (see forced-json.ts),
    // and answers as JSON content rather than as a tool call.
    if (schemaName === 'acceptance') {
      acceptanceCalls++
      const allMet = acceptanceCalls > 1
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({
              items: [
                { index: 1, met: true, evidence: 'write landed' },
                { index: 2, met: allMet, evidence: allMet ? 'write landed' : 'no assertion write happened' },
                { index: 3, met: true, evidence: 'nothing removed' },
              ],
            }),
          },
          finish_reason: 'stop',
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
    const schemaName = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name
    if (schemaName === 'contract') {
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({ goal: 'clamp exists and is covered', criteria, constraints: [] }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 900, completion_tokens: 20 },
      }
    }
    if (schemaName === 'acceptance') {
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({
              items: criteria.map((_c, i) => ({ index: i + 1, met: true, evidence: 'the write landed' })),
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1_500, completion_tokens: 20 },
      }
    }
    if (schemaName === 'review') {
      reviewed.push(JSON.stringify(body.messages))
      return {
        choices: [{
          message: { role: 'assistant', content: JSON.stringify({ issues: [] }) },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1_500, completion_tokens: 20 },
      }
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

/**
 * The independent read is skipped when the conversation has crept up on the window.
 *
 * Its prompt shares nothing with the conversation, so the server has to hold two prefixes.
 * Measured against the live server, one foreign prompt after a warm conversation:
 *
 *    92,183 tokens -> cached 92,179    123,103 -> cached 123,099    160,023 -> cached 160,019
 *   193,343 tokens -> cached 0         EVICTED, 841 s to rebuild
 *
 * Free for almost every session, fourteen minutes for one that is nearly full -- and the
 * compaction trigger is 0.8, so there is a live band between it and the cliff. A numeric
 * guard, because this is arithmetic and not a judgement.
 */
test('the diff review stands down when there is no room for a second prefix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-reviewroom-'))
  dirs.push(root)
  const CONTEXT = 40_000
  const CREATED = `export function clamp() {}
${'z'.repeat(3_000)}`

  const mkTool = (name: string, content: string, readOnly: boolean): Tool<Record<string, unknown>> => ({
    name, readOnly, description: name,
    parameters: { type: 'object', properties: {} },
    validate: (args) => ({ ok: true, args: args as Record<string, unknown> }),
    execute: async () => ({ ok: true, content }),
  })
  const registry = new ToolRegistry()
  registry.register(mkTool('write_file', 'wrote', false))

  const criteria = ['clamp exists']
  let reviews = 0
  let turnCall = 0
  /** The prompt size the session believes it is at when the turn ends. */
  let finalPromptTokens = 1_000

  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: CONTEXT } }
    if (req.url === '/health') return { status: 'ok' }
    const schemaName = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name
    if (schemaName === 'contract') {
      return {
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ goal: 'clamp exists', criteria, constraints: [] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 900, completion_tokens: 20 },
      }
    }
    if (schemaName === 'acceptance') {
      return {
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ items: [{ index: 1, evidence: 'the write landed', met: true }] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1_500, completion_tokens: 20 },
      }
    }
    if (schemaName === 'review') {
      reviews++
      return {
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ goalMet: true, goalGap: '', issues: [] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1_500, completion_tokens: 20 },
      }
    }
    turnCall++
    if (turnCall === 1) {
      return {
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'clamp.ts', content: CREATED }) } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1_000, completion_tokens: 20 },
      }
    }
    return {
      choices: [{ message: { role: 'assistant', content: 'All done, everything works.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: finalPromptTokens, completion_tokens: 5 },
    }
  })
  stop = fake.close

  const run = async (): Promise<void> => {
    const session = new Session({
      client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
      toolset: { registry } as Toolset,
      workspaceRoot: root,
      mode: 'autopilot',
      store: new SessionStore(root),
      // No compaction trigger in the way: this test is about the reviewer's own guard.
      compaction: { contextLength: CONTEXT, triggerRatio: 0.99 },
    })
    await session.send(BIG_TASK)
  }

  // Room to spare: the review runs, exactly as it always has.
  finalPromptTokens = 1_000
  turnCall = 0
  await run()
  expect(reviews).toBe(1)

  // Nearly the whole window: it stands down rather than costing a second prefix.
  reviews = 0
  turnCall = 0
  finalPromptTokens = CONTEXT - 2_000
  await run()
  expect(reviews).toBe(0)
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

test('a criterion the audit did not report on is not treated as an asserted gap', () => {
  // The two guards interact. `withUnreportedCriteria` fills the audit's silence by appending
  // the criterion VERBATIM, which is what makes the gate refuse to close — correctly. But
  // verbatim means it matches, so it lands in `unmetByIndex` looking exactly like a finding
  // the audit actually made, and the plan sync then un-ticked a step the user had watched
  // complete. "Not audited this round" is not evidence that the work came undone.
  const criteria = ['the counter never repeats', 'the suite passes', 'no API changes']
  const raw = parseAcceptance(JSON.stringify({
    items: [
      { index: 1, met: true, evidence: 'repro passes' },
      { index: 2, met: false, evidence: 'not run' },
    ],
  }), criteria)!
  const full = withUnreportedCriteria(criteria, raw)

  const { unmetByIndex } = resolveReportedCriteria(criteria, full)
  // Both are held open...
  expect([...unmetByIndex.keys()].sort()).toEqual([1, 2])
  // ...but only one of them is something the audit actually asserted.
  expect(unmetByIndex.get(1)).not.toBe(UNREPORTED_REASON)
  expect(unmetByIndex.get(2)).toBe(UNREPORTED_REASON)
})

test('the distiller clips a write-heavy tail, where the bulk is in tool_call arguments', async () => {
  // `content` is only half of a message's size, and on a write-heavy tail it is the empty
  // half: a write_file call carries the whole file in arguments with content: null. The clip
  // short-circuited on `typeof content !== 'string'`, so those were never clipped at all and
  // this deliberately-small context became tens of thousands of tokens.
  const huge = 'x'.repeat(50_000)
  let sent: any
  const fake = await startFakeServer((body: any) => {
    sent = body
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'no' } }] }
  })
  const client = new LlamaClient({ baseUrl: fake.url, model: 'test' })
  const transcript = [
    { role: 'system' as const, content: 'sys' },
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{
        id: 'w1', type: 'function' as const,
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.ts', content: huge }) },
      }],
    },
  ]

  const { distillContract } = await import('../src/session/contract.js')
  await distillContract(client, transcript, 'do the thing, and several other things too')
  await fake.close()

  const wire = JSON.stringify(sent.messages)
  expect(wire).toContain('clipped for contract distillation')
  // Nowhere near the 50k it used to carry.
  expect(wire.length).toBeLessThan(12_000)
})
