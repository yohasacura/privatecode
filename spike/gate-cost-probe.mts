/**
 * What one acceptance gate costs, four ways, on a realistic mid-session context.
 *
 * Established by the earlier probes:
 *   - swapping the tools array voids the whole prompt cache (the tool block renders at the
 *     very front of the prompt), and that is what every gate does today;
 *   - a named `tool_choice` is accepted by this build and NOT enforced, so "stable array +
 *     name the function" would silently disable the gates;
 *   - `response_format: json_schema` DOES constrain, 5/5, and is a sampler constraint that
 *     leaves the prompt byte-identical.
 *
 * The remaining question is the appended `user` message, which moves the template's
 * `last_query_index` and so strips `<think>` from the current turn's assistant messages.
 * This measures whether pinning `preserve_thinking` on both sides removes that too.
 *
 *   npx tsx spike/gate-cost-probe.mts
 */
import { writeFileSync } from 'node:fs'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
/** Measured on this box by the earlier probes: ~535-577 tok/s of prefill. */
const PREFILL_TOK_PER_S = 555

interface Msg {
  role: string
  content: string | null
  reasoning_content?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

const tool = (name: string, description: string, props: Record<string, unknown>) => ({
  type: 'function' as const,
  function: { name, description, parameters: { type: 'object', required: Object.keys(props), properties: props } },
})
const S = (d: string) => ({ type: 'string', description: d })

const FULL_TOOLS = [
  tool('read_file', 'Read a file with line numbers. Ranges supported.', { path: S('Path'), start: S('First line'), end: S('Last line') }),
  tool('list_dir', 'List a directory.', { path: S('Path') }),
  tool('find_files', 'Find files by glob.', { glob: S('Glob pattern') }),
  tool('search_code', 'Search with ripgrep.', { pattern: S('Regex'), path: S('Where'), glob: S('Filter') }),
  tool('symbol_outline', 'Tree-sitter outline of a file.', { path: S('Path') }),
  tool('git_status', 'Read-only git: status, diff, log, blame.', { action: S('Which'), path: S('Path') }),
  tool('edit_file', 'SEARCH/REPLACE edit.', { path: S('Path'), search_text: S('Exact text'), replace_text: S('Replacement') }),
  tool('write_file', 'Write a whole file.', { path: S('Path'), content: S('Full contents') }),
  tool('move_file', 'Move or rename.', { from: S('Source'), to: S('Destination') }),
  tool('delete_file', 'Delete permanently.', { path: S('Path'), recursive: S('Recurse') }),
  tool('run_command', 'Run a PowerShell command with a timeout.', { command: S('Command'), timeout_ms: S('Timeout') }),
  tool('background_task', 'Start, poll or stop a long-running process.', { action: S('Which'), command: S('Command'), id: S('Task id') }),
  tool('browser', 'Control a browser over CDP. Eleven actions.', { action: S('Which'), url: S('URL'), ref: S('Element ref') }),
  tool('todo_write', 'Write the visible plan.', { todos: S('The plan items') }),
  tool('ask_user', 'Ask the user a question with options.', { question: S('Question'), options: S('Options') }),
]
const ACCEPT_TOOL = [tool('report_acceptance', 'Report, criterion by criterion, whether the contract is met.',
  { items: S('One entry per criterion with met and evidence') })]

const ACCEPT_SCHEMA = {
  type: 'object', required: ['items'], additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', required: ['criterion', 'met', 'evidence'], additionalProperties: false,
        properties: { criterion: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } },
      },
    },
  },
}

const SYSTEM = 'You are PrivateCode, a coding agent working in a local workspace.\n\n' +
  'Look at the result before deciding the next step. '.repeat(40)

function turn(tag: string, steps: number): Msg[] {
  const out: Msg[] = [{ role: 'user', content: `Task ${tag}: refactor the session store so writes are atomic. `.repeat(6) }]
  for (let k = 0; k < steps; k++) {
    const id = `c${tag}${k}`
    out.push({
      role: 'assistant', content: '',
      reasoning_content: 'I need to look at how the store writes this file. '.repeat(60),
      tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `store${k}.ts` }) } }],
    })
    out.push({ role: 'tool', tool_call_id: id, content: 'export class Store { /* body */ } '.repeat(200) })
  }
  out.push({
    role: 'assistant', content: 'All steps complete. Here is a summary.',
    reasoning_content: 'Everything checks out. '.repeat(40),
  })
  return out
}

const MAIN: Msg[] = [{ role: 'system', content: SYSTEM }, ...turn('A', 6), ...turn('B', 8)]
const AUDIT: Msg = {
  role: 'user',
  content: '[Before this turn may end: audit the work above against the task contract, one item per criterion.]',
}

async function measure(messages: Msg[], tools: unknown[], extra: Record<string, unknown> = {}): Promise<{ total: number; cache: number }> {
  const body: Record<string, unknown> = {
    model: 'kat', messages, tools, max_tokens: 1, stream: true,
    cache_prompt: true, return_progress: true, temperature: 0.6, top_p: 0.95, top_k: 20, ...extra,
  }
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let last: { total: number; cache: number } | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line.startsWith('data: ')) continue
      const p = line.slice(6)
      if (p === '[DONE]') continue
      try {
        const j = JSON.parse(p) as { prompt_progress?: { total: number; cache: number } }
        if (j.prompt_progress) last = { total: j.prompt_progress.total, cache: j.prompt_progress.cache }
      } catch { /* partial */ }
    }
  }
  if (!last) throw new Error('no prompt_progress')
  return last
}

const results: { variant: string; reprefill: number; seconds: number }[] = []

async function scenario(
  variant: string, gateTools: unknown[], gateExtra: Record<string, unknown>, warmExtra: Record<string, unknown> = {},
): Promise<void> {
  // Re-warm twice: the first request re-establishes the prefix, the second proves it is warm,
  // so the gate reading that follows is measured against a known-good cache.
  await measure(MAIN, FULL_TOOLS, warmExtra)
  const control = await measure(MAIN, FULL_TOOLS, warmExtra)
  const gate = await measure([...MAIN, AUDIT], gateTools, { ...warmExtra, ...gateExtra })
  const reprefill = gate.total - gate.cache
  const seconds = reprefill / PREFILL_TOK_PER_S
  results.push({ variant, reprefill, seconds })
  console.log(
    `${variant.padEnd(52)} control ${((control.cache / control.total) * 100).toFixed(0).padStart(3)}% |` +
    ` gate cached ${String(gate.cache).padStart(6)}/${String(gate.total).padStart(6)}` +
    ` = ${((gate.cache / gate.total) * 100).toFixed(1).padStart(5)}% |` +
    ` re-prefill ${String(reprefill).padStart(6)} tok ~ ${seconds.toFixed(1).padStart(5)} s`)
}

console.log(`server ${BASE}\n`)
await scenario('TODAY: one-tool array + tool_choice required', ACCEPT_TOOL,
  { tool_choice: 'required', chat_template_kwargs: { enable_thinking: false } })

await scenario('FIX: same tools + response_format json_schema', FULL_TOOLS,
  { response_format: { type: 'json_schema', json_schema: { name: 'acceptance', strict: true, schema: ACCEPT_SCHEMA } },
    chat_template_kwargs: { enable_thinking: false } })

await scenario('FIX + preserve_thinking on BOTH sides', FULL_TOOLS,
  { response_format: { type: 'json_schema', json_schema: { name: 'acceptance', strict: true, schema: ACCEPT_SCHEMA } },
    chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } },
  { chat_template_kwargs: { preserve_thinking: true } })

const today = results[0]!
console.log(`\nper gate:  today ${today.seconds.toFixed(1)} s`)
for (const r of results.slice(1)) {
  console.log(`           ${r.variant.replace(/^FIX/, 'fix').padEnd(48)} ${r.seconds.toFixed(1)} s` +
    `  (saves ${(today.seconds - r.seconds).toFixed(1)} s)`)
}
const best = results.slice(1).reduce((a, b) => (b.seconds < a.seconds ? b : a))
console.log(`\n4 gates per task: ${(today.seconds * 4 / 60).toFixed(1)} min -> ${(best.seconds * 4).toFixed(1)} s`)
writeFileSync('docs/SPIKE-GATE-COST.json', JSON.stringify(results, null, 2))
