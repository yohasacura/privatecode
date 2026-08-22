/**
 * What a harness sub-call actually costs, asked of the SERVER rather than of the template.
 *
 * The gates (`checkAcceptance`, `statePremises`, `readThroughLenses`) send the live
 * transcript with a one-tool `tools` array and an appended `user` message. Both of those
 * change the prompt AHEAD of the conversation: the tool block renders before the system
 * prompt, and an appended user message moves the template's `last_query_index`, which
 * strips `<think>` from every assistant message of the current turn. Either one alone
 * moves the longest common prefix backwards, and llama.cpp re-reads everything after it.
 *
 * `prompt_progress.cache` is the server's own count of how much of the prompt it did NOT
 * have to process. It is the only honest instrument for this, and the client already
 * parses it (`llama/client.ts`).
 *
 *   npx tsx spike/prefix-cache-probe.mts
 */
import { writeFileSync } from 'node:fs'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'

interface Msg {
  role: string
  content: string | null
  reasoning_content?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

const tool = (name: string, description: string, props: Record<string, unknown>) => ({
  type: 'function' as const,
  function: {
    name,
    description,
    parameters: { type: 'object', required: Object.keys(props), properties: props },
  },
})
const S = (d: string) => ({ type: 'string', description: d })

/** A stand-in for the registry's 15 built-ins, at roughly their real serialised size. */
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

const ACCEPT_TOOL = [
  tool('report_acceptance', 'Report, criterion by criterion, whether the contract is met.', {
    items: S('One entry per criterion with met and evidence'),
  }),
]

const SYSTEM = 'You are PrivateCode, a coding agent working in a local workspace.\n\n' +
  'Look at the result before deciding the next step. '.repeat(40)

function turn(tag: string, steps: number): Msg[] {
  const out: Msg[] = [{
    role: 'user',
    content: `Task ${tag}: refactor the session store so writes are atomic. `.repeat(6),
  }]
  for (let k = 0; k < steps; k++) {
    const id = `c${tag}${k}`
    out.push({
      role: 'assistant',
      content: '',
      reasoning_content: 'I need to look at how the store writes. '.repeat(60),
      tool_calls: [{
        id,
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: `core/src/session/store${k}.ts` }) },
      }],
    })
    out.push({ role: 'tool', tool_call_id: id, content: 'export class Store { /* body */ } '.repeat(200) })
  }
  out.push({
    role: 'assistant',
    content: 'All steps complete. Here is a summary.',
    reasoning_content: 'Everything checks out. '.repeat(40),
  })
  return out
}

/** Mid-session: a finished earlier task, then eight steps of the current one. */
const MAIN: Msg[] = [{ role: 'system', content: SYSTEM }, ...turn('A', 6), ...turn('B', 8)]

const AUDIT: Msg = {
  role: 'user',
  content: '[Before this turn may end: audit the work above against the task contract with report_acceptance.]',
}

interface Reading { processed: number; total: number; cache: number; ms: number }

async function measure(
  messages: Msg[], tools: unknown[], kwargs?: Record<string, unknown>,
): Promise<Reading> {
  const body: Record<string, unknown> = {
    model: 'kat',
    messages,
    tools,
    // One token: this probe is about the PREFILL, and generating more would only add noise.
    max_tokens: 1,
    stream: true,
    stream_options: { include_usage: true },
    cache_prompt: true,
    return_progress: true,
    timings_per_token: true,
    temperature: 0.6,
    top_p: 0.95,
    top_k: 20,
  }
  if (kwargs) body['chat_template_kwargs'] = kwargs

  const started = performance.now()
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)

  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let last: { processed: number; total: number; cache: number } | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6)
      if (payload === '[DONE]') continue
      try {
        const j = JSON.parse(payload) as {
          prompt_progress?: { processed: number; total: number; cache: number }
        }
        if (j.prompt_progress) last = j.prompt_progress
      } catch { /* a partial SSE frame; the next read completes it */ }
    }
  }
  const ms = performance.now() - started
  if (!last) throw new Error('no prompt_progress in the stream - does this build support return_progress?')
  return { ...last, ms }
}

const rows: { label: string; reading: Reading }[] = []

async function run(
  label: string, messages: Msg[], tools: unknown[], kwargs?: Record<string, unknown>,
): Promise<void> {
  const reading = await measure(messages, tools, kwargs)
  rows.push({ label, reading })
  const reused = reading.total > 0 ? (reading.cache / reading.total) * 100 : 0
  console.log(
    `${label.padEnd(48)} total ${String(reading.total).padStart(6)}` +
    `  cached ${String(reading.cache).padStart(6)}  (${reused.toFixed(1).padStart(5)}% reused)` +
    `  reprefill ${String(reading.total - reading.cache).padStart(6)} tok` +
    `  ${(reading.ms / 1000).toFixed(1).padStart(6)} s`)
}

console.log(`server ${BASE}\n`)

console.log('--- TODAY: the acceptance gate exactly as the harness sends it ---')
await run('main step (warms the slot)', MAIN, FULL_TOOLS)
await run('main step again (control, expect ~100%)', MAIN, FULL_TOOLS)
await run('GATE today: one tool + appended user msg', [...MAIN, AUDIT], ACCEPT_TOOL, { enable_thinking: false })
await run('back to the conversation afterwards', MAIN, FULL_TOOLS)

console.log('\n--- FIX A alone: identical tools array, nothing else ---')
await run('main step (re-warm)', MAIN, FULL_TOOLS)
await run('GATE with the SAME tools array', [...MAIN, AUDIT], FULL_TOOLS, { enable_thinking: false })
await run('back to the conversation afterwards', MAIN, FULL_TOOLS)

console.log('\n--- FIX A+B: same tools AND preserve_thinking on BOTH sides ---')
await run('main step, preserve_thinking on (re-warm)', MAIN, FULL_TOOLS, { preserve_thinking: true })
await run('GATE, same tools + preserve_thinking', [...MAIN, AUDIT], FULL_TOOLS, { enable_thinking: false, preserve_thinking: true })
await run('back to the conversation afterwards', MAIN, FULL_TOOLS, { preserve_thinking: true })

writeFileSync('docs/SPIKE-PREFIX-CACHE.json', JSON.stringify(rows, null, 2))
console.log('\nwrote docs/SPIKE-PREFIX-CACHE.json')
