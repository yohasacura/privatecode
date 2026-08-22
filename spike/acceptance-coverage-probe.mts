/**
 * Does the audit actually report on every criterion — and does the harness notice when it
 * does not?
 *
 * `parseAcceptance` derives its verdicts only from the items the model returns, and the
 * schema cannot force one item per criterion (no `minItems`). So a short report used to
 * parse perfectly clean and every unreported criterion was recorded as MET. That is the
 * fix `withUnreportedCriteria` exists for; this asks the real model how often the case
 * actually arises, and proves the guard fires when it does.
 *
 *   npx tsx spike/acceptance-coverage-probe.mts
 */
import { LlamaClient } from '../core/src/llama/client.js'
import type { ChatMessage } from '../core/src/llama/types.js'
import {
  checkAcceptance, withUnreportedCriteria, renderCheckedState, UNREPORTED_REASON,
  type TaskContract,
} from '../core/src/session/contract.js'

const client = new LlamaClient({
  baseUrl: process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080',
  model: 'kat',
})

const CONTRACT: TaskContract = {
  goal: 'Invoice numbers are gap-free under concurrency, and the fix is covered by a test.',
  criteria: [
    'The root cause of invoice number skipping under concurrent requests is identified',
    'The race condition causing invoice numbers to skip values is fixed',
    'Invoice numbers are gap-free when multiple requests arrive concurrently',
    'No other functionality is changed beyond fixing the invoice numbering race condition',
    'A reproduction test demonstrably FAILED before the fix and passes after it',
    'The existing suite still passes',
  ],
  constraints: ['Do not change any other functionality'],
}

/** A turn that genuinely did SOME of the work — the shape the gate actually meets. */
const TRANSCRIPT: ChatMessage[] = [
  { role: 'system', content: 'You are PrivateCode, a coding agent working in a local workspace.' },
  { role: 'user', content: 'Fix the invoice numbering race condition and cover it with a test.' },
  {
    role: 'assistant', content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/invoice.ts"}' } }],
  },
  {
    role: 'tool', tool_call_id: 'c1',
    content: '   9  async allocate(year: number): Promise<number> {\n' +
      '  10    const row = await db.query("select last from counters where year = $1", [year])\n' +
      '  11    const next = (row?.last ?? 0) + 1\n' +
      '  12    await db.query("update counters set last = $1 where year = $2", [next, year])\n' +
      '  13    return next\n  14  }',
  },
  {
    role: 'assistant', content: 'The read and the write are two statements with no transaction.',
    tool_calls: [{ id: 'c2', type: 'function', function: { name: 'edit_file', arguments: '{"path":"src/invoice.ts"}' } }],
  },
  {
    role: 'tool', tool_call_id: 'c2',
    content: 'edited src/invoice.ts\n@@\n-    const row = await db.query("select last from counters where year = $1", [year])\n' +
      '-    const next = (row?.last ?? 0) + 1\n-    await db.query("update counters set last = $1 where year = $2", [next, year])\n' +
      '+    const row = await db.query("update counters set last = last + 1 where year = $1 returning last", [year])\n' +
      '+    const next = row.last',
  },
  { role: 'assistant', content: 'All done, everything works. The race condition is fixed.' },
]

const ROUNDS = 5
let short = 0

console.log(`contract has ${CONTRACT.criteria.length} criteria; ${ROUNDS} rounds\n`)

for (let i = 1; i <= ROUNDS; i++) {
  const started = performance.now()
  const raw = await checkAcceptance(client, TRANSCRIPT, CONTRACT)
  const seconds = (performance.now() - started) / 1000
  if (raw === null) { console.log(`round ${i}: the audit could not run`); continue }

  const reported = raw.met + raw.unmet.length
  const full = withUnreportedCriteria(CONTRACT.criteria, raw)
  const unreported = full.unmet.filter((u) => u.why === UNREPORTED_REASON)
  if (unreported.length > 0) short++

  console.log(
    `round ${i} (${seconds.toFixed(1)}s): the audit reported on ${reported}/${CONTRACT.criteria.length} criteria` +
    ` — ${raw.met} met, ${raw.unmet.length} unmet` +
    (unreported.length > 0 ? `  ->  GUARD FIRED: ${unreported.length} never reported on` : '  ->  full coverage'))
  for (const u of full.unmet) {
    const tag = u.why === UNREPORTED_REASON ? 'NOT REPORTED' : 'UNMET'
    console.log(`    ${tag.padEnd(13)} ${u.criterion.slice(0, 78)}`)
  }
  console.log(`    checkedState: ${renderCheckedState(CONTRACT, full).slice(0, 200)}`)
  // What the gate would decide. Before the guard, an unreported criterion closed the task.
  console.log(`    gate would close the task: ${full.unmet.length === 0}` +
    ` (without the guard: ${raw.unmet.length === 0})\n`)
}

console.log(`\n${short}/${ROUNDS} rounds returned an INCOMPLETE audit that used to read as a full pass.`)
