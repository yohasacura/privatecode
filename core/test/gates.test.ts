import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { classify, diagnose, renderDiagnosis } from '../src/doctor/diagnose.js'
import { answerFrom, gateStatsFrom, renderGates, type GateEvent } from '../src/doctor/gates.js'
import { splitUserMessage } from '../src/host/replay.js'
import { ACCEPTANCE_FIXER_PREFIX, REVIEW_FIXER_PREFIX } from '../src/session/contract.js'
import {
  MIDTURN_VERIFY_PREFIX, STILL_FAILING_SUFFIX, VERIFY_FAILED_PREFIX, VERIFY_PROBLEM_PREFIX,
} from '../src/verify/runner.js'
import { CONTINUE_NUDGE, TALKED_INSTEAD_OF_ACTING } from '../src/agent/loop.js'
import type { SessionMeta } from '../src/session/store.js'

/**
 * The checks, diagnosed the same way the model is.
 *
 * These are written against the harness's OWN exported constants rather than against copies
 * of its wording, for the reason the classifier tests learned the hard way: a test that
 * asserts on a copied literal keeps passing after the real message is reworded, and what it
 * then proves is that the copy still matches itself.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-gates-'))
  mkdirSync(join(root, '.privatecode', 'state', 'sessions'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Builds one session on disk out of chat messages and returns the diagnosis of it. */
function diagnosisOf(
  lines: unknown[], extraMeta: Partial<SessionMeta> = {},
): ReturnType<typeof diagnose> {
  writeFileSync(
    join(root, '.privatecode', 'state', 'sessions', 's.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8',
  )
  writeFileSync(join(root, '.privatecode', 'state', 'sessions', 's.ui.jsonl'), '', 'utf8')
  const meta: SessionMeta = {
    id: 's', title: 'something confidential', createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z', workspaceRoot: root, mode: 'normal',
    ...extraMeta,
  }
  return diagnose(root, [meta])
}

const person = (text: string): unknown => ({ role: 'user', content: text })
const harness = (text: string): unknown => ({ role: 'user', content: text })
const says = (text: string): unknown => ({ role: 'assistant', content: text })
const calls = (...names: string[]): unknown => ({
  role: 'assistant',
  content: '',
  tool_calls: names.map((name, i) => ({
    id: `c${i}`, type: 'function', function: { name, arguments: '{}' },
  })),
})

describe('naming which check spoke', () => {
  test('each hand-back is told apart, not lumped into one harness count', () => {
    expect(splitUserMessage(`${VERIFY_FAILED_PREFIX} the build is red`).harnessKind)
      .toBe('verify')
    // A DIFFERENT kind from a failed build, and the difference is the point: one says the
    // code is wrong, the other says nothing was checked at all.
    expect(splitUserMessage(`${VERIFY_PROBLEM_PREFIX} no build command`).harnessKind)
      .toBe('verify-broken')
    expect(splitUserMessage(`${ACCEPTANCE_FIXER_PREFIX}\n- one`).harnessKind).toBe('acceptance')
    expect(splitUserMessage(`${REVIEW_FIXER_PREFIX}\n- two`).harnessKind).toBe('review')
    expect(splitUserMessage(CONTINUE_NUDGE).harnessKind).toBe('continue')
  })

  test('a status note is harness, and is NOT a hand-back', () => {
    // The distinction the single `harnessMessages` number could not make. A note is a line;
    // an acceptance failure is a turn of work. Counting them together said the checking was
    // expensive in sessions where it was not.
    const note = splitUserMessage('[dotnet build: ok, 3.2s]')
    expect(note.harness).toBe(true)
    expect(note.harnessKind).toBe('note')
  })

  test('the MID-TURN verifier is a hand-back, though it arrives in brackets', () => {
    // The check this app runs most, and the one the bracket rule silently mis-sorted:
    // everything wrapped in brackets was a `note`, so a build breaking nine times during
    // work counted as nine status lines and the report said the checking cost nothing.
    const midturn = splitUserMessage(
      `[${MIDTURN_VERIFY_PREFIX}${VERIFY_FAILED_PREFIX} \`npm test\` exited 1]`)
    expect(midturn.harnessKind).toBe('verify-working')
    // And its suppressed repeat is a third thing again: a hand-back that is cheap by
    // design, because it deliberately does not spend the log a second time.
    expect(splitUserMessage(`[npm test${STILL_FAILING_SUFFIX}]`).harnessKind)
      .toBe('verify-unchanged')
    // The ordinary note is still a note.
    expect(splitUserMessage('[Context is about 80% full, and will be summarised.]').harnessKind)
      .toBe('note')
  })

  test('what a person types is never given a kind', () => {
    expect(splitUserMessage('fix the build').harnessKind).toBeUndefined()
    // The shapes that USED to be misread as harness, kept here because they are ordinary
    // things to type and the bracket rule is what protects them.
    expect(splitUserMessage('[HttpGet] is missing').harnessKind).toBeUndefined()
    expect(splitUserMessage('[Fact]').harnessKind).toBeUndefined()
  })

  test('a folder prefix cannot hide which check spoke', () => {
    // The multi-folder shape. Without the prefix strip this fell through to `other-harness`
    // and a whole workspace layout's worth of build failures went unnamed.
    expect(splitUserMessage(`In the "api" folder: ${VERIFY_FAILED_PREFIX} red`).harnessKind)
      .toBe('verify')
  })
})

describe('what the model did about it', () => {
  test('the five answers are told apart by what was called', () => {
    expect(answerFrom(1, ['Edit'])).toBe('edited')
    expect(answerFrom(1, ['Read', 'Edit'])).toBe('edited')
    expect(answerFrom(1, ['Bash'])).toBe('ran')
    expect(answerFrom(1, ['Read', 'Grep'])).toBe('looked')
    expect(answerFrom(1, [])).toBe('words-only')
    expect(answerFrom(0, [])).toBe('nothing')
  })

  test('an unrecognised tool understates a fix rather than inventing one', () => {
    // `unknown-tool` is what a hallucinated or MCP name collapses to. It may well have
    // changed a file; calling that an edit would be a guess reported as a count. But
    // `looked` is a claim that NOTHING changed, and it cannot be made about a tool we do
    // not recognise either — so the honest middle is that it did something.
    expect(answerFrom(1, ['unknown-tool'])).toBe('ran')
    expect(answerFrom(1, ['mcp-tool'])).toBe('ran')
  })

  test('"only looked" is granted by membership, never by falling through', () => {
    // An audit found this asserting "changed nothing" about a check answered by delegating
    // the fix to a sub-agent. Every one of these can change the workspace; none is an
    // editing tool, and under the old fall-through all four printed as `only looked`.
    for (const tool of ['Agent', 'sql_deploy', 'background_task', 'browser']) {
      expect(answerFrom(1, [tool])).toBe('ran')
    }
    // And one read-only tool mixed in does not launder the rest.
    expect(answerFrom(1, ['Read', 'Agent'])).toBe('ran')
  })

  test('replying in prose to a build log is counted, per check', () => {
    // The failure this project already has a nudge for, measured against the check that
    // provoked it — which is the part that says WHICH check the model argues with.
    const d = diagnosisOf([
      person('make it build'),
      calls('Edit'),
      harness(`${VERIFY_FAILED_PREFIX}\nerror CS1002`),
      says('The build failure is unrelated to my change.'),
    ])
    const verify = d.gates.find((g) => g.kind === 'verify')
    expect(verify?.fired).toBe(1)
    // Answered in prose, once — and the session ended there, so whether the check was
    // satisfied is NOT known. Calling it satisfied would be the flattering guess, on the
    // one line a reader uses to decide whether an answer worked.
    expect(verify?.answers['words-only']).toEqual({ times: 1, observed: 0, satisfied: 0 })
  })
})

describe('whether the answer satisfied the check', () => {
  test('a check that fires again in the same person-turn was not satisfied', () => {
    const d = diagnosisOf([
      person('make it build'),
      calls('Edit'),
      harness(`${VERIFY_FAILED_PREFIX}\nerror CS1002`),
      calls('Edit'),
      harness(`${VERIFY_FAILED_PREFIX}\nerror CS1002`),
      calls('Edit'),
      person('thanks'),
    ])
    const verify = d.gates.find((g) => g.kind === 'verify')
    expect(verify?.fired).toBe(2)
    expect(verify?.refired).toBe(1)   // the first was not satisfied; the second was
    expect(verify?.longestRun).toBe(2)
  })

  test('a run is counted through an interleaved note', () => {
    // The shape that adjacency gets wrong: fail, edit, the runner prints its note, fail
    // again. Comparing only neighbours calls that two unrelated first firings and reports a
    // worst run of 1 for a check that refused twice over one request.
    const d = diagnosisOf([
      person('make it build'),
      harness(`${VERIFY_FAILED_PREFIX}\nerror CS1002`),
      calls('Edit'),
      harness('[dotnet build: 3.2s]'),
      harness(`${VERIFY_FAILED_PREFIX}\nerror CS1002`),
      calls('Edit'),
      person('ok'),
    ])
    expect(d.gates.find((g) => g.kind === 'verify')?.longestRun).toBe(2)
  })

  test('the person speaking starts the count over', () => {
    // Two separate requests that each hit the build once is a different, and much better,
    // state than one request the build refused twice.
    const d = diagnosisOf([
      person('first'),
      harness(`${VERIFY_FAILED_PREFIX}\nred`),
      calls('Edit'),
      person('second'),
      harness(`${VERIFY_FAILED_PREFIX}\nred`),
      calls('Edit'),
    ])
    const verify = d.gates.find((g) => g.kind === 'verify')
    expect(verify?.fired).toBe(2)
    expect(verify?.longestRun).toBe(1)
    expect(verify?.refired).toBe(0)
  })

  test('a check the chain moved past is not called unanswered', () => {
    // `nothing` is a claim that the check was abandoned. When another check simply spoke
    // first — the chain running on, or a compaction retry replacing the turn — that claim
    // is wrong, and it would be wrong on the line a reader looks at to decide whether the
    // gates are being ignored.
    const d = diagnosisOf([
      person('ship it'),
      harness(`${VERIFY_FAILED_PREFIX}
red`),
      harness(`${ACCEPTANCE_FIXER_PREFIX}
- not met`),
      calls('Edit'),
      person('ok'),
    ])
    expect(d.gates.find((g) => g.kind === 'verify')?.answers['preempted']?.times).toBe(1)
    expect(d.gates.find((g) => g.kind === 'verify')?.answers['nothing']).toBeUndefined()
  })

  test('a session that ends on an unanswered check says so', () => {
    const d = diagnosisOf([
      person('build it'),
      harness(`${ACCEPTANCE_FIXER_PREFIX}\n- the tests still fail`),
    ])
    const gate = d.gates.find((g) => g.kind === 'acceptance')
    expect(gate?.answers['nothing']?.times).toBe(1)
  })
})

describe('what the checking cost', () => {
  test('turns and calls spent answering are attributed to the check that caused them', () => {
    const d = diagnosisOf([
      person('do it'),
      calls('Write'),               // the work itself — not the gate's cost
      harness(`${REVIEW_FIXER_PREFIX}\n- a leak`),
      calls('Read', 'Edit'),   // one turn, two calls
      says('fixed'),                     // a second turn
      person('good'),
    ])
    const review = d.gates.find((g) => g.kind === 'review')
    expect(review?.steps).toBe(2)
    expect(review?.calls).toBe(2)
    // And the work done BEFORE any check fired is not charged to one.
    expect(d.toolCalls).toBe(3)
  })
})

describe('the report itself', () => {
  test('notes are reported apart from hand-backs, never inside them', () => {
    const rendered = renderGates(gateStatsFrom([
      { kind: 'verify', answer: 'edited', refired: false, outcomeKnown: true, round: 1, steps: 1, calls: 1 },
    ]), 2)
    const text = rendered.join('\n')
    expect(text).toContain('build or tests failed')
    expect(text).toContain('status notes')
    // The notes line is parenthetical, not a row in the table with a "not satisfied" column.
    expect(text).not.toMatch(/status note\s+\d+ times/)
  })

  test('nothing but our own words and numbers reaches the page', () => {
    // The same leak question the rest of the doctor answers, asked of the gate section: it
    // is handed a literal union and a membership-checked tool name, so a build log has no
    // route in. Proven on a transcript stuffed with things that must not travel.
    const d = diagnosisOf([
      person('deploy the ZebraCorp ledger'),
      harness(`${VERIFY_FAILED_PREFIX}\nD:/clients/zebracorp/Ledger.csproj(42): error CS1002`),
      says('AcmeBank.Ledger.PostingEngine needs the merger flag'),
      harness(`${VERIFY_FAILED_PREFIX}\nD:/clients/zebracorp/Ledger.csproj(42): error CS1002`),
      calls('Edit'),
      harness(`${TALKED_INSTEAD_OF_ACTING}`),
      calls('mcp__acmebank_prod__query_ledger'),
      person('stop'),
    ])
    const report = renderDiagnosis(d)
    for (const secret of ['zebracorp', 'ZebraCorp', 'AcmeBank', 'Ledger', 'PostingEngine',
      'merger', 'CS1002', 'csproj', 'clients', 'acmebank_prod', 'query_ledger', 'deploy']) {
      expect(report).not.toContain(secret)
    }
    // And it still said something worth reading: the check refused twice and the model
    // answered one of them with prose.
    expect(report).toContain('build or tests failed')
    expect(report).toContain('worst run 2')
    expect(report).toContain('replied in words')
  })
})

/**
 * A hand-built stat is the only way to reach the render for a kind no fixture produces, and
 * every kind must render — a `Record` missing a member prints `undefined` in a report.
 *
 * The list is written out rather than derived, on purpose: a kind added to `HarnessKind`
 * without being added here is exactly the omission this catches, and deriving the list from
 * the type would make the test agree with whatever the type says.
 */
test('every harness kind has a label', () => {
  const kinds: GateEvent['kind'][] = ['acceptance', 'review', 'premises', 'verify',
    'verify-broken', 'verify-working', 'verify-unchanged', 'overflow-retry', 'continue',
    'truncation', 'talked-not-acted', 'step-timeout', 'max-steps', 'undone',
    'compaction-briefing', 'note', 'other-harness']
  const text = renderGates(gateStatsFrom(kinds.map((kind) => (
    { kind, answer: 'edited', refired: false, outcomeKnown: true, round: 1, steps: 1, calls: 1 } as GateEvent
  )))).join('\n')
  expect(text).not.toContain('undefined')
  for (const line of text.split('\n')) expect(line).not.toMatch(/^ {2}\s*\d+ times/)
})

/**
 * What a compaction does to the accounting.
 *
 * The swap writes two synthetic messages: a briefing in the USER role and an acknowledgement
 * in the ASSISTANT role. `replayEntries` has always recognised both — the briefing becomes a
 * compaction card, the ack is dropped as a message no model generated — but the diagnosis
 * read the raw file and saw a person speaking and a model answering.
 *
 * That is three wrong numbers from one event: an inflated `userMessages`, an inflated
 * `assistantMessages`, and — since a person speaking ENDS a turn — a check that refused on
 * both sides of a compaction reported as two unrelated first firings, which is the exact
 * opposite of the finding.
 */
describe('a compaction is the machine talking to itself', () => {
  test('the briefing is not the person, and does not end the person\'s turn', async () => {
    const { COMPACTION_BRIEFING_PREFIX, COMPACTION_ACK_TEXT } =
      await import('../src/session/compaction.js')

    const d = diagnosisOf([
      person('make the import work'),
      harness(`${VERIFY_FAILED_PREFIX}\nred`),
      calls('Edit'),
      // The window filled and the earlier history was replaced, mid-request.
      harness(`${COMPACTION_BRIEFING_PREFIX}\n\nThe user asked about the ledger import.`),
      says(COMPACTION_ACK_TEXT),
      harness(`${VERIFY_FAILED_PREFIX}\nred`),
      calls('Edit'),
      person('thanks'),
    ])

    // Two person messages in this fixture — the request and the thanks. Three would mean
    // the briefing had been counted as one of them.
    expect(d.userMessages).toBe(2)
    // The run survives the compaction: this is one request the build refused twice.
    const verify = d.gates.find((g) => g.kind === 'verify')
    expect(verify?.longestRun).toBe(2)
    expect(verify?.refired).toBe(1)
    // And the briefing is not listed as a check that took a turn back.
    expect(renderGates(d.gates).join('\n')).not.toContain('context compacted')
  })

  test('the synthetic acknowledgement is not a turn the model took', async () => {
    const { COMPACTION_BRIEFING_PREFIX, COMPACTION_ACK_TEXT } =
      await import('../src/session/compaction.js')

    const d = diagnosisOf([
      person('go'),
      harness(`${ACCEPTANCE_FIXER_PREFIX}\n- not met`),
      harness(`${COMPACTION_BRIEFING_PREFIX}\n\nearlier history`),
      says(COMPACTION_ACK_TEXT),
      calls('Edit'),
      person('ok'),
    ])
    // The model generated exactly one assistant message here; the ack it "said" was written
    // by the compaction code. Charging it to the open check made compaction look like a
    // cost of checking.
    expect(d.assistantMessages).toBe(1)
  })
})

test('an answer is reported together with whether it worked', () => {
  // The defect the live model found by misreading the report: given `1 not satisfied` on one
  // line and `words 1, edits 1` on another, it concluded the edit "apparently didn't get it
  // right" — inverting which of the two had worked. The pairing has to be on one line.
  const d = diagnosisOf([
    person('fix the build'),
    harness(`${VERIFY_FAILED_PREFIX}\nred`),
    says('That failure is unrelated to my change.'),
    harness(`${VERIFY_FAILED_PREFIX}\nred`),
    calls('Edit'),
    person('thanks'),
  ])
  const text = renderGates(d.gates).join('\n')
  expect(text).toContain('replied in words, called nothing: 1, which satisfied the check 0 of 1')
  expect(text).toContain('changed files: 1, which satisfied the check 1 of 1')
})

test('a percentage is not printed off a sample too small to carry one', () => {
  // The live model read `400% of what the person sent` off a one-message fixture and wrote
  // "the agent is spinning rather than making progress" into its summary for the maintainer.
  // The count is a fact; the ratio at that sample size is an invitation to a wrong reading.
  const one = renderDiagnosis(diagnosisOf([
    person('go'),
    harness(`${VERIFY_FAILED_PREFIX}\nred`),
    calls('Edit'),
  ]))
  expect(one).toContain('harness turns')
  expect(one).not.toMatch(/% of what the person sent/)

  const many = renderDiagnosis(diagnosisOf([
    ...Array.from({ length: 6 }, () => person('go')),
    harness(`${VERIFY_FAILED_PREFIX}\nred`),
    calls('Edit'),
  ]))
  expect(many).toMatch(/% of what the person sent/)
})

/**
 * What an adversarial audit found, pinned so it cannot come back.
 *
 * Each of these was a report making a confident, specific, WRONG statement — not a missing
 * number. That is the failure mode this whole module is written against, because the page is
 * forwarded as evidence and nobody who receives it can check it against the machine it came
 * from.
 */
describe('the audit findings', () => {
  test('a compaction does not double every gate number, nor invent a run', async () => {
    const { COMPACTION_BRIEFING_PREFIX, COMPACTION_ACK_TEXT } =
      await import('../src/session/compaction.js')

    // The file a swap actually leaves behind: the whole history, a marker, then the new
    // transcript — which re-appends the retained tail that is already above the marker.
    const tail = [
      harness(`${VERIFY_FAILED_PREFIX}\nred`),
      calls('Edit'),
      { role: 'tool', tool_call_id: 'c0', content: 'edited' },
      says('fixed it'),
    ]
    const d = diagnosisOf([
      { role: 'system', content: 'you are an agent' },
      person('please fix the build'),
      calls('Read'),
      { role: 'tool', tool_call_id: 'c0', content: '1\tx' },
      ...tail,
      // 8 messages so far; the tail starts at index 4, floor is 1, so droppedMessages is 3.
      { __event: 'compaction', summary: 's', droppedMessages: 3, at: '2026-08-20T09:00:00.000Z' },
      { role: 'system', content: 'you are an agent' },
      harness(`${COMPACTION_BRIEFING_PREFIX}\n\nearlier history`),
      says(COMPACTION_ACK_TEXT),
      ...tail,
    ])

    const verify = d.gates.find((g) => g.kind === 'verify')
    expect(verify?.fired).toBe(1)              // not 2
    expect(verify?.longestRun).toBe(1)         // not 2 — the run was pure fabrication
    expect(verify?.refired).toBe(0)            // not 1
    expect(verify?.steps).toBe(2)              // not 4
    expect(verify?.calls).toBe(1)              // not 2
    // And the report's own waste metric stops inventing a repeat the model never made.
    expect(d.tools.find((t) => t.name === 'Edit')?.repeats).toBe(0)
    expect(d.compactions).toBe(1)
  })

  test('a status note between a check and the answer does not steal the answer', () => {
    // `beforeStep` writes a bracketed note before the model's FIRST generation of a turn, so
    // on any session with a contract this is the ordinary order on disk. Closing the check
    // on it reported every gate at `cost 0 model turns and 0 tool calls`, as `preempted`,
    // with the real work charged to `note` — which the report then hides.
    const d = diagnosisOf([
      person('make it build'),
      harness(`${ACCEPTANCE_FIXER_PREFIX}\n- the tests still fail`),
      harness('[Plan focus — step 2 of 5: fix the parser]'),
      calls('Read', 'Edit'),
      says('done'),
      person('thanks'),
    ])
    const gate = d.gates.find((g) => g.kind === 'acceptance')
    expect(gate?.steps).toBe(2)
    expect(gate?.calls).toBe(2)
    expect(gate?.answers['edited']?.times).toBe(1)
    expect(gate?.answers['preempted']).toBeUndefined()
    // The note is still reported, just not as a check that took a turn back.
    expect(d.harnessNotes).toBe(1)
    expect(renderGates(d.gates, d.harnessNotes).join('\n')).toContain('1 status note')
  })

  test('a build log full of brackets cannot turn a hand-back into a user request', async () => {
    const { MIDTURN_VERIFY_PREFIX } = await import('../src/verify/runner.js')
    // Real compiler output: an MSBuild project tag and a timestamp, neither of which
    // balances against the wrapper's own bracket. The depth scan gave up and returned the
    // whole build log as something the person had typed.
    const log = `[${MIDTURN_VERIFY_PREFIX}${VERIFY_FAILED_PREFIX}\n` +
      'Program.cs(9,5): error CS1002: ; expected [D:/w/App.csproj\n' +
      '[12:34:56] build ended]'
    expect(splitUserMessage(log).harnessKind).toBe('verify-working')

    const d = diagnosisOf([person('fix it'), { role: 'user', content: log }, calls('Edit')])
    expect(d.userMessages).toBe(1)
    expect(d.gates.find((g) => g.kind === 'verify-working')?.fired).toBe(1)
  })

  test('the suppressed repeat survives a command with brackets in it', async () => {
    const { STILL_FAILING_SUFFIX } = await import('../src/verify/runner.js')
    // The command is the user's own and sits between two constants, so only the suffix can
    // be matched — and it must be matched before the depth scan, not after.
    const msg = `[dotnet test /p:Filter="Category!=[Slow]"${STILL_FAILING_SUFFIX}]`
    expect(splitUserMessage(msg).harnessKind).toBe('verify-unchanged')
  })

  test('an overnight run\'s nudges are the runner, not the person', async () => {
    const { nudgeFor } = await import('../src/cli/unattended.js')
    const withTodos = nudgeFor([{ text: 'finish the parser', status: 'pending' }] as never)
    const withNone = nudgeFor([])
    expect(splitUserMessage(withTodos).harnessKind).toBe('unattended-nudge')
    expect(splitUserMessage(withNone).harnessKind).toBe('unattended-nudge')

    // And the consequence that made it matter: a nudge read as the person ENDS the turn, so
    // a build refusing three times running was reported as three satisfied first firings.
    const d = diagnosisOf([
      person('work through the list'),
      harness(`${VERIFY_FAILED_PREFIX}\nred`), says('looking'),
      harness(withTodos), calls('Edit'),
      harness(`${VERIFY_FAILED_PREFIX}\nred`), says('looking'),
      harness(withTodos), calls('Edit'),
      harness(`${VERIFY_FAILED_PREFIX}\nred`), calls('Edit'),
      person('stop'),
    ])
    expect(d.userMessages).toBe(2)
    expect(d.gates.find((g) => g.kind === 'verify')?.longestRun).toBe(3)
  })

  test('a premise veto is its own category, not the `other` bucket', async () => {
    const { PREMISE_FAILURE_PREFIX } = await import('../src/session/premises.js')
    expect(classify(`${PREMISE_FAILURE_PREFIX}\n\nsrc/a.ts does not contain that line`))
      .toBe('unverified-premise')
  })
})

/**
 * The version, checked by membership rather than by shape — third attempt.
 *
 * An audit refuted the leak on reachability: `appVersion` is written by our own shell from
 * Tauri's `getVersion()`, so nobody hostile chooses it. The refutation is sound and the
 * check was still wrong, because the law in this file is not "is it reachable" — it is
 * `membership admits what we shipped`, and a twelve-character lowercase tail is a shape.
 * Twice now that shape has been tightened rather than replaced, and twice a reviewer has
 * walked through what was left.
 */
describe('app version', () => {
  const versionsIn = (appVersion: string): string => {
    const d = diagnosisOf([person('hi')], { appVersion })
    return renderDiagnosis(d)
  }

  test('a plain version prints, and so does a pre-release tag we ship', () => {
    expect(versionsIn('0.1.5')).toContain('0.1.5')
    expect(versionsIn('1.2.3.4')).toContain('1.2.3.4')
    expect(versionsIn('0.2.0-rc1')).toContain('0.2.0-rc1')
    expect(versionsIn('0.2.0-beta')).toContain('0.2.0-beta')
  })

  test('a tag we do not ship a name for is dropped, and the loss is declared', () => {
    const report = versionsIn('0.1.5-zebracorp')
    expect(report).not.toContain('zebracorp')
    // The numbers survive, because they answer the only question anybody asks of this line.
    expect(report).toContain('0.1.5')
    // And the reader is told, so two builds do not silently collapse into one.
    expect(report).toContain('does not ship a name for')
  })

  test('anything that is not a version at all loses everything', () => {
    for (const bad of ['D:/clients/zebracorp', 'ProjectAtlas.MergerWith.ZebraCorp', '']) {
      const report = versionsIn(bad)
      for (const secret of ['zebracorp', 'ZebraCorp', 'clients', 'Atlas', 'Merger']) {
        expect(report).not.toContain(secret)
      }
    }
  })
})

/**
 * The question the version was recorded to answer.
 *
 * `SessionMeta.appVersion` says in its own doc comment that it exists so the doctor can tell
 * "whether a failure pattern belongs to a version — the question 'did that get better after
 * 0.1.5' is unanswerable without it, and it is the first question anybody asks." The report
 * recorded the version and then answered how many SESSIONS ran under each, which is the one
 * thing nobody asks.
 */
describe('did it get better', () => {
  /** Two builds on disk, one clumsy and one not. */
  function twoBuilds(): ReturnType<typeof diagnose> {
    const write = (id: string, appVersion: string, failures: number, calls: number): void => {
      const lines: unknown[] = [person('go')]
      const outcomes: { id: string; ok: boolean }[] = []
      for (let i = 0; i < calls; i++) {
        const cid = `${id}-c${i}`
        lines.push({ role: 'assistant', tool_calls: [{ id: cid, type: 'function',
          function: { name: 'Read', arguments: JSON.stringify({ path: `src/a${i}.ts` }) } }] })
        const failed = i < failures
        lines.push({ role: 'tool', tool_call_id: cid,
          content: failed ? `File not found: src/a${i}.ts` : `1\tconst a${i} = 1` })
        outcomes.push({ id: cid, ok: !failed })
      }
      writeFileSync(join(root, '.privatecode', 'state', 'sessions', `${id}.jsonl`),
        lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
      writeFileSync(join(root, '.privatecode', 'state', 'sessions', `${id}.ui.jsonl`),
        outcomes.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
      metas.push({
        id, title: 'confidential', createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-02T10:00:00.000Z', workspaceRoot: root, mode: 'normal',
        appVersion,
      } as SessionMeta)
    }
    const metas: SessionMeta[] = []
    write('old', '0.1.4', 12, 40)
    write('new', '0.1.5', 2, 40)
    return diagnose(root, metas)
  }

  test('failures are attributed to the build that made them', () => {
    const d = twoBuilds()
    expect(d.versions['0.1.4']).toEqual({ sessions: 1, toolCalls: 40, toolFailures: 12, handBacks: 0 })
    expect(d.versions['0.1.5']).toEqual({ sessions: 1, toolCalls: 40, toolFailures: 2, handBacks: 0 })
  })

  test('the report shows them oldest first, so it reads as a before and after', () => {
    const report = renderDiagnosis(twoBuilds())
    expect(report).toContain('per build — did it get better')
    expect(report.indexOf('0.1.4')).toBeLessThan(report.indexOf('0.1.5'))
    expect(report).toContain('30%')   // the old build
    expect(report).toContain('5%')    // the new one
  })

  test('a build with too few calls is not given a rate to be compared on', () => {
    // The failure this ordering invites: two calls, one failed, printed as 50% next to a
    // build with four hundred — and read as a catastrophic regression.
    const d = diagnosisOf([
      person('go'),
      calls('Read'),
      { role: 'tool', tool_call_id: 'c0', content: 'File not found: src/a.ts' },
    ], { appVersion: '0.2.0' })
    const buildLine = renderDiagnosis(d).split('\n').find((l) => l.includes('0.2.0'))
    expect(buildLine).toContain('too few to rate')
    // The per-tool table above still rates that one call at 100%, which is fine there — it
    // is not read as a comparison between builds, and the raw counts sit beside it.
    expect(buildLine).not.toContain('%')
  })

  test('one build alone says so rather than implying a trend', () => {
    expect(renderDiagnosis(diagnosisOf([person('go')], { appVersion: '0.1.5' })))
      .toContain('nothing here to compare it against yet')
  })
})
