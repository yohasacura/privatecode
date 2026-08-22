/**
 * Every converted gate, against the real model, in one run.
 *
 * The whole harness now forces its structure with `response_format` and carries the
 * session's own tool array (see `forced-json.ts`). That was six separate conversions, and
 * the failure mode they share is silent: a gate that cannot parse its answer returns null
 * and the turn simply proceeds unchecked. So each one is asked for a real answer here.
 *
 *   npx tsx spike/gates-live-probe.mts
 */
import { LlamaClient } from '../core/src/llama/client.js'
import {
  distillContract, decomposeTodos, improveDraft, expandDraft,
} from '../core/src/session/contract.js'
import type { ChatMessage, ToolSchema } from '../core/src/llama/types.js'

const client = new LlamaClient({
  baseUrl: process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080',
  model: 'kat',
})

/** Stands in for the session's own array: what matters is that one IS sent. */
const TOOLS: ToolSchema[] = ['read_file', 'search_code', 'edit_file', 'write_file', 'run_command'].map((name) => ({
  type: 'function',
  function: {
    name,
    description: `The ${name} tool.`,
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'Path' } } },
  },
}))

const TRANSCRIPT: ChatMessage[] = [
  { role: 'system', content: 'You are PrivateCode, a coding agent in D:\Projects\Demo.' },
]

const REQUEST =
  'Invoice numbers sometimes skip a value when several requests come in at once. Fix the ' +
  'race in src/invoice.ts, add a test that fails before the fix and passes after it, and ' +
  'do not change the public signature of allocate().'

let failures = 0
const check = (label: string, ok: boolean, detail: string): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(28)} ${detail}`)
}

const started = Date.now()

const contract = await distillContract(client, TRANSCRIPT, REQUEST, undefined, TOOLS)
check('distillContract', contract !== null && contract.criteria.length >= 2,
  contract === null ? 'returned null' : `${contract.criteria.length} criteria, kind=${contract.kind ?? '-'}`)

if (contract !== null) {
  const todos = await decomposeTodos(client, TRANSCRIPT, contract, undefined, TOOLS)
  check('decomposeTodos', todos !== null && todos.length >= 2,
    todos === null ? 'returned null' : `${todos.length} steps, first: ${todos[0]?.text.slice(0, 46)}`)
  const english = (todos ?? []).every((t) => !/[а-яё]/i.test(t.text))
  check('  steps in English', english, english ? 'no Cyrillic' : 'CYRILLIC LEAKED')
}

const suggestions = await improveDraft(client, TRANSCRIPT, 'почини гонку в счётчике счетов', undefined, TOOLS)
check('improveDraft', suggestions !== null,
  suggestions === null ? 'returned null'
    : `${suggestions.criteria.length} criteria, ${suggestions.questions.length} questions`)

const expanded = await expandDraft(client, TRANSCRIPT, 'сделай кнопку красной', undefined, TOOLS)
check('expandDraft', expanded !== null && expanded.length > 40,
  expanded === null ? 'returned null' : `${expanded.length} chars`)
check('  brief in English', expanded !== null && !/[а-яё]/i.test(expanded),
  expanded !== null && !/[а-яё]/i.test(expanded) ? 'no Cyrillic' : 'CYRILLIC LEAKED')

console.log(`\n${failures === 0 ? 'all gates answered' : `${failures} FAILED`}  (${((Date.now() - started) / 1000).toFixed(1)}s)`)
