/**
 * Is a gate's append now as cheap as an ORDINARY step's append?
 *
 * After the tools array was made constant, one acceptance gate still re-prefills ~4,186
 * tokens of a 35k prompt (88.2% cached). The first guess was the template's
 * `last_query_index` stripping `<think>` from the current turn — but the launcher passes
 * `--reasoning-preserve` ("preserve reasoning trace in the full history, not just the last")
 * and `/props` reports `supports_preserve_reasoning: true`, so thinking is preserved for the
 * WHOLE history already and nothing is being stripped.
 *
 * So the right question is not "why is it not zero" but "is it more than a normal step
 * costs". A turn appends an assistant message and a tool reply every step and pays whatever
 * that costs; if a gate's appended user message costs the same, the gate is now exactly as
 * expensive as one more step and there is nothing left to win.
 *
 *   npx tsx spike/append-cost-probe.mts
 */
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
  function: { name, description, parameters: { type: 'object', required: Object.keys(props), properties: props } },
})
const S = (d: string) => ({ type: 'string', description: d })
const TOOLS = [
  tool('read_file', 'Read a file with line numbers.', { path: S('Path') }),
  tool('search_code', 'Search with ripgrep.', { pattern: S('Regex') }),
  tool('edit_file', 'SEARCH/REPLACE edit.', { path: S('Path'), search_text: S('Find'), replace_text: S('Replace') }),
  tool('write_file', 'Write a whole file.', { path: S('Path'), content: S('Contents') }),
  tool('run_command', 'Run a PowerShell command.', { command: S('Command') }),
]

function turn(tag: string, steps: number): Msg[] {
  const out: Msg[] = [{ role: 'user', content: `Task ${tag}: make the session store write atomically. `.repeat(6) }]
  for (let k = 0; k < steps; k++) {
    const id = `c${tag}${k}`
    out.push({
      role: 'assistant', content: '',
      reasoning_content: 'I need to look at how the store writes this file. '.repeat(60),
      tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `store${k}.ts` }) } }],
    })
    out.push({ role: 'tool', tool_call_id: id, content: 'export class Store { /* body */ } '.repeat(200) })
  }
  out.push({ role: 'assistant', content: 'All steps complete.', reasoning_content: 'Everything checks out. '.repeat(40) })
  return out
}

const MAIN: Msg[] = [
  { role: 'system', content: 'You are PrivateCode. ' + 'Look at the result before deciding the next step. '.repeat(40) },
  ...turn('A', 6), ...turn('B', 8),
]

/** What a gate appends: one user message. */
const GATE_APPEND: Msg[] = [{
  role: 'user',
  content: '[Before this turn may end: audit the work above against the task contract, one item per criterion.]',
}]

/** What an ORDINARY step appends: the assistant's call and the tool's reply. */
const STEP_APPEND: Msg[] = [
  {
    role: 'assistant', content: '',
    reasoning_content: 'One more file to check before I finish. '.repeat(20),
    tool_calls: [{ id: 'cX', type: 'function', function: { name: 'read_file', arguments: '{"path":"storeX.ts"}' } }],
  },
  { role: 'tool', tool_call_id: 'cX', content: 'export class Store { /* body */ } '.repeat(60) },
]

async function measure(messages: Msg[], extra: Record<string, unknown> = {}): Promise<{ total: number; cache: number }> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'kat', messages, tools: TOOLS, max_tokens: 1, stream: true,
      cache_prompt: true, return_progress: true, temperature: 0.6, top_p: 0.95, top_k: 20, ...extra,
    }),
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

const RATE = 730
async function row(label: string, messages: Msg[], extra: Record<string, unknown> = {}): Promise<number> {
  await measure(MAIN)               // re-warm the conversation
  const r = await measure(messages, extra)
  const re = r.total - r.cache
  console.log(`${label.padEnd(50)} cached ${String(r.cache).padStart(6)}/${String(r.total).padStart(6)}` +
    ` = ${((r.cache / r.total) * 100).toFixed(1).padStart(5)}%   re-prefill ${String(re).padStart(5)} tok ~ ${(re / RATE).toFixed(1)} s`)
  return re
}

console.log(`server ${BASE}\n`)
console.log(`--- what does an append cost, now that the tools array is constant? ---`)
const step = await row('ORDINARY STEP: + assistant call + tool reply', [...MAIN, ...STEP_APPEND])
const gate = await row('GATE: + one user message', [...MAIN, ...GATE_APPEND])
const gateNoThink = await row('GATE + enable_thinking:false (what it sends)', [...MAIN, ...GATE_APPEND],
  { chat_template_kwargs: { enable_thinking: false } })

console.log(`\n--- and the control: is the conversation itself still warm? ---`)
await row('the conversation unchanged', MAIN)

console.log(`\nA gate now costs ${gate <= step * 1.5 ? 'about what an ordinary step costs' : 'MORE than an ordinary step'}` +
  ` (${gate} vs ${step} tokens).`)
if (gateNoThink > gate * 1.5) {
  console.log(`NOTE: enable_thinking:false alone adds ${gateNoThink - gate} tokens of re-prefill — the ` +
    `generation prefix differs, so the gate diverges from the warm prompt at the very tail.`)
}
