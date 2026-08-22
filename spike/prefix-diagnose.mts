/**
 * One variable at a time, to find where a gate's prompt actually diverges.
 *
 * The whole-scenario probe (`prefix-cache-probe.mts`) showed the gate costing a full
 * re-prefill and an identical tools array recovering most of it — but also that
 * `preserve_thinking` changed nothing at all, which only makes sense if the reasoning is
 * not in the prompt to begin with. This asks each question separately, using the server's
 * OWN prompt token count (`prompt_progress.total`) as the measure: two prompts with the
 * same total and a shared prefix are the same prompt.
 *
 *   npx tsx spike/prefix-diagnose.mts
 */
const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'

interface Msg {
  role: string
  content: string | null
  reasoning_content?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

const TOOL = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description: 'Read a file with line numbers.',
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'Path' } } },
  },
}
const OTHER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'report_acceptance',
    description: 'Report, criterion by criterion, whether the contract is met.',
    parameters: { type: 'object', required: ['items'], properties: { items: { type: 'string', description: 'Items' } } },
  },
}

const THINK = 'I need to look at how the store writes this file and whether it is atomic. '.repeat(40)

function conversation(withReasoning: boolean): Msg[] {
  const out: Msg[] = [
    { role: 'system', content: 'You are a coding agent. ' + 'Work in small steps. '.repeat(20) },
    { role: 'user', content: 'Refactor the session store so writes are atomic. '.repeat(6) },
  ]
  for (let k = 0; k < 4; k++) {
    const id = `c${k}`
    const a: Msg = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `store${k}.ts` }) } }],
    }
    if (withReasoning) a.reasoning_content = THINK
    out.push(a)
    out.push({ role: 'tool', tool_call_id: id, content: 'export class Store { /* body */ } '.repeat(120) })
  }
  const tail: Msg = { role: 'assistant', content: 'All steps complete. Here is a summary.' }
  if (withReasoning) tail.reasoning_content = THINK
  out.push(tail)
  return out
}

const AUDIT: Msg = { role: 'user', content: '[Audit the work above against the contract.]' }

async function probe(
  label: string, messages: Msg[], tools: unknown[], kwargs?: Record<string, unknown>,
): Promise<{ total: number; cache: number }> {
  const body: Record<string, unknown> = {
    model: 'kat', messages, tools, max_tokens: 1, stream: true,
    cache_prompt: true, return_progress: true, temperature: 0.6, top_p: 0.95, top_k: 20,
  }
  if (kwargs) body['chat_template_kwargs'] = kwargs
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
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
      const p = line.slice(6)
      if (p === '[DONE]') continue
      try {
        const j = JSON.parse(p) as { prompt_progress?: { processed: number; total: number; cache: number } }
        if (j.prompt_progress) last = j.prompt_progress
      } catch { /* partial frame */ }
    }
  }
  if (!last) throw new Error('no prompt_progress')
  console.log(`${label.padEnd(56)} total ${String(last.total).padStart(6)}  cached ${String(last.cache).padStart(6)}`)
  return { total: last.total, cache: last.cache }
}

console.log('Q1. Does reasoning_content on INPUT messages reach the prompt at all?\n')
const withR = await probe('conversation WITH reasoning_content', conversation(true), [TOOL])
const withoutR = await probe('conversation WITHOUT reasoning_content', conversation(false), [TOOL])
console.log(`\n  -> totals ${withR.total} vs ${withoutR.total}: ` +
  (withR.total === withoutR.total
    ? 'IDENTICAL. The server DISCARDS input reasoning_content; it never enters the prompt.'
    : `DIFFERENT by ${Math.abs(withR.total - withoutR.total)} tokens; reasoning IS carried.`))

console.log('\nQ2. Does preserve_thinking change the prompt?\n')
const noKw = await probe('no chat_template_kwargs', conversation(true), [TOOL])
const preserve = await probe('preserve_thinking: true', conversation(true), [TOOL], { preserve_thinking: true })
console.log(`\n  -> ${noKw.total} vs ${preserve.total}: ` +
  (noKw.total === preserve.total ? 'no effect on this build.' : 'it changes the prompt.'))

console.log('\nQ3. Which of the two changes a gate makes actually costs the prefix?\n')
const base = conversation(true)
await probe('re-warm the conversation', base, [TOOL])
await probe('A) swap the tools array ONLY (no appended msg)', base, [OTHER_TOOL])
await probe('re-warm the conversation', base, [TOOL])
await probe('B) append the user message ONLY (same tools)', [...base, AUDIT], [TOOL])
await probe('re-warm the conversation', base, [TOOL])
await probe('A+B) both, i.e. the gate as sent today', [...base, AUDIT], [OTHER_TOOL])

console.log('\nQ4. Is a named tool_choice accepted by this build?\n')
try {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'kat',
      messages: [{ role: 'user', content: 'Read store0.ts and report.' }],
      tools: [TOOL, OTHER_TOOL],
      tool_choice: { type: 'function', function: { name: 'report_acceptance' } },
      max_tokens: 200, stream: false, temperature: 0.6, top_p: 0.95, top_k: 20,
    }),
  })
  const j = await res.json() as { choices?: { message?: { tool_calls?: { function: { name: string } }[] } }[]; error?: unknown }
  if (!res.ok) console.log('  named tool_choice REJECTED:', JSON.stringify(j).slice(0, 300))
  else {
    const called = j.choices?.[0]?.message?.tool_calls?.map((c) => c.function.name)
    console.log('  named tool_choice ACCEPTED. tools offered: read_file + report_acceptance;',
      `forced report_acceptance; model called: ${JSON.stringify(called)}`)
  }
} catch (e) {
  console.log('  named tool_choice request failed:', (e as Error).message)
}
