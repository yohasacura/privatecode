import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { diagnose, renderDiagnosis } from '../src/doctor/diagnose.js'
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
function diagnosisOf(lines: unknown[]): ReturnType<typeof diagnose> {
  writeFileSync(
    join(root, '.privatecode', 'state', 'sessions', 's.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8',
  )
  writeFileSync(join(root, '.privatecode', 'state', 'sessions', 's.ui.jsonl'), '', 'utf8')
  const meta: SessionMeta = {
    id: 's', title: 'something confidential', createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z', workspaceRoot: root, mode: 'normal',
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
    expect(answerFrom(1, ['edit_file'])).toBe('edited')
    expect(answerFrom(1, ['read_file', 'edit_file'])).toBe('edited')
    expect(answerFrom(1, ['run_command'])).toBe('ran')
    expect(answerFrom(1, ['read_file', 'search_code'])).toBe('looked')
    expect(answerFrom(1, [])).toBe('words-only')
    expect(answerFrom(0, [])).toBe('nothing')
  })

  test('an unrecognised tool understates a fix rather than inventing one', () => {
    // `unknown-tool` is what a hallucinated or MCP name collapses to. It may well have
    // changed a file; calling that an edit would be a guess reported as a count.
    expect(answerFrom(1, ['unknown-tool'])).toBe('looked')
    expect(answerFrom(1, ['mcp-tool'])).toBe('looked')
  })

  test('replying in prose to a build log is counted, per check', () => {
    // The failure this project already has a nudge for, measured against the check that
    // provoked it — which is the part that says WHICH check the model argues with.
    const d = diagnosisOf([
      person('make it build'),
      calls('edit_file'),
      harness(`${VERIFY_FAILED_PREFIX}\nerror CS1002`),
      says('The build failure is unrelated to my change.'),
    ])
    const verify = d.gates.find((g) => g.kind === 'verify')
    expect(verify?.fired).toBe(1)
    expect(verify?.answers['words-only']).toBe(1)
  })
})

describe('whether the answer satisfied the check', () => {
  test('a check that fires again in the same person-turn was not satisfied', () => {
    const d = diagnosisOf([
      person('make it build'),
      calls('edit_file'),
      harness(`${VERIFY_FAILED_PREFIX}\nerror CS1002`),
      calls('edit_file'),
      harness(`${VERIFY_FAILED_PREFIX}\nerror CS1002`),
      calls('edit_file'),
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
      calls('edit_file'),
      harness('[dotnet build: 3.2s]'),
      harness(`${VERIFY_FAILED_PREFIX}\nerror CS1002`),
      calls('edit_file'),
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
      calls('edit_file'),
      person('second'),
      harness(`${VERIFY_FAILED_PREFIX}\nred`),
      calls('edit_file'),
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
      calls('edit_file'),
      person('ok'),
    ])
    expect(d.gates.find((g) => g.kind === 'verify')?.answers['preempted']).toBe(1)
    expect(d.gates.find((g) => g.kind === 'verify')?.answers['nothing']).toBeUndefined()
  })

  test('a session that ends on an unanswered check says so', () => {
    const d = diagnosisOf([
      person('build it'),
      harness(`${ACCEPTANCE_FIXER_PREFIX}\n- the tests still fail`),
    ])
    const gate = d.gates.find((g) => g.kind === 'acceptance')
    expect(gate?.answers['nothing']).toBe(1)
  })
})

describe('what the checking cost', () => {
  test('turns and calls spent answering are attributed to the check that caused them', () => {
    const d = diagnosisOf([
      person('do it'),
      calls('write_file'),               // the work itself — not the gate's cost
      harness(`${REVIEW_FIXER_PREFIX}\n- a leak`),
      calls('read_file', 'edit_file'),   // one turn, two calls
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
      { kind: 'verify', answer: 'edited', refired: false, round: 1, steps: 1, calls: 1 },
      { kind: 'note', answer: 'nothing', refired: false, round: 1, steps: 0, calls: 0 },
      { kind: 'note', answer: 'nothing', refired: false, round: 1, steps: 0, calls: 0 },
    ]))
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
      calls('edit_file'),
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
    'truncation', 'talked-not-acted', 'step-timeout', 'max-steps', 'undone', 'note',
    'other-harness']
  const text = renderGates(gateStatsFrom(kinds.map((kind) => (
    { kind, answer: 'edited', refired: false, round: 1, steps: 1, calls: 1 } as GateEvent
  )))).join('\n')
  expect(text).not.toContain('undefined')
  for (const line of text.split('\n')) expect(line).not.toMatch(/^ {2}\s*\d+ times/)
})
