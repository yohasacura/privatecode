/**
 * A way to force ONE structured answer without touching the prompt.
 *
 * Named `tool_choice` is accepted by this build and not enforced (see
 * `tool-choice-probe.mts`: 5/5 wrong function on an inviting prompt), so the obvious prefix
 * fix — stable tools array, name the wanted function — would silently disable every gate.
 *
 * The alternative is a SAMPLER-level constraint, which is not part of the rendered prompt at
 * all: keep sending the session's own tools array unchanged (so the prefix is a pure append)
 * and constrain the output with `response_format` or a GBNF `grammar`. This asks two
 * questions of each candidate: does it actually constrain, and does it leave the prompt
 * byte-identical (measured by the server's own prompt token total and cache hit).
 *
 *   npx tsx spike/constrain-probe.mts
 */
const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const TRIALS = 5

const t = (name: string, description: string, prop: string) => ({
  type: 'function' as const,
  function: {
    name,
    description,
    parameters: { type: 'object', required: [prop], properties: { [prop]: { type: 'string', description: prop } } },
  },
})
const TOOLS = [
  t('read_file', 'Read a file with line numbers.', 'path'),
  t('search_code', 'Search the workspace with ripgrep.', 'pattern'),
  t('edit_file', 'Apply a SEARCH/REPLACE edit.', 'path'),
]

const ACCEPT_SCHEMA = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'met', 'evidence'],
        additionalProperties: false,
        properties: {
          criterion: { type: 'string' },
          met: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

/** Deliberately inviting: this is the prompt that made named tool_choice fail 5/5. */
const PROMPT =
  'Read the file store0.ts and tell me what it does.\n\n' +
  '[Before this turn may end: audit the work above against the contract, one item per ' +
  'criterion. Reply with JSON only.]'

interface Outcome { calls: string[]; content: string; ok: boolean; err?: string; total?: number; cache?: number }

async function once(extra: Record<string, unknown>, stream: boolean): Promise<Outcome> {
  const body: Record<string, unknown> = {
    model: 'kat',
    messages: [{ role: 'user', content: PROMPT }],
    tools: TOOLS,
    max_tokens: 400,
    stream,
    temperature: 0.6, top_p: 0.95, top_k: 20,
    chat_template_kwargs: { enable_thinking: false },
    ...extra,
  }
  if (stream) { body['cache_prompt'] = true; body['return_progress'] = true }
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!stream) {
    const j = await res.json() as {
      choices?: { message?: { tool_calls?: { function: { name: string } }[]; content?: string } }[]
      error?: { message?: string }
    }
    if (!res.ok) return { calls: [], content: '', ok: false, err: j.error?.message ?? JSON.stringify(j).slice(0, 200) }
    return {
      calls: j.choices?.[0]?.message?.tool_calls?.map((c) => c.function.name) ?? [],
      content: j.choices?.[0]?.message?.content ?? '',
      ok: true,
    }
  }
  if (!res.ok) return { calls: [], content: '', ok: false, err: (await res.text()).slice(0, 200) }
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
  return { calls: [], content: '', ok: true, ...(last ?? {}) }
}

async function trial(label: string, extra: Record<string, unknown>): Promise<void> {
  const tally = new Map<string, number>()
  let firstContent = ''
  let err = ''
  for (let i = 0; i < TRIALS; i++) {
    const o = await once(extra, false)
    if (!o.ok) { err = o.err ?? 'error'; break }
    let kind: string
    if (o.calls.length > 0) kind = `tool_call:${o.calls.join('+')}`
    else {
      try {
        const parsed = JSON.parse(o.content) as { items?: unknown }
        kind = Array.isArray(parsed.items) ? 'JSON with items[]' : 'JSON, wrong shape'
      } catch { kind = 'free text' }
    }
    if (!firstContent) firstContent = o.content.slice(0, 90).replace(/\n/g, ' ')
    tally.set(kind, (tally.get(kind) ?? 0) + 1)
  }
  if (err) { console.log(`${label.padEnd(46)} REJECTED: ${err.slice(0, 110)}`); return }
  const summary = [...tally.entries()].map(([k, c]) => `${k} x${c}`).join(', ')
  console.log(`${label.padEnd(46)} ${summary}`)
  if (firstContent) console.log(`${''.padEnd(46)}   first: ${firstContent}`)
}

console.log(`server ${BASE}, ${TRIALS} trials each\n`)
console.log('--- does it constrain? (tools array stays the SAME in every row) ---')
await trial('baseline: no constraint', {})
await trial('response_format json_object', { response_format: { type: 'json_object' } })
await trial('response_format json_schema', {
  response_format: { type: 'json_schema', json_schema: { name: 'acceptance', strict: true, schema: ACCEPT_SCHEMA } },
})
await trial('llama.cpp json_schema field', { json_schema: ACCEPT_SCHEMA })
await trial('GBNF grammar field', {
  grammar: 'root ::= "{\\"items\\":[" item ("," item)* "]}"\n' +
    'item ::= "{\\"criterion\\":" str ",\\"met\\":" bool ",\\"evidence\\":" str "}"\n' +
    'str ::= "\\"" ([^"\\\\] | "\\\\" .)* "\\""\n' +
    'bool ::= "true" | "false"\n',
})

console.log('\n--- and is the PROMPT untouched? (same tools, so the prefix must survive) ---')
const warm = await once({}, true)
console.log(`warm the slot                                  total ${warm.total}  cached ${warm.cache}`)
for (const [label, extra] of [
  ['response_format json_schema', { response_format: { type: 'json_schema', json_schema: { name: 'acceptance', strict: true, schema: ACCEPT_SCHEMA } } }],
  ['GBNF grammar field', { grammar: 'root ::= "{" ([^}])* "}"\n' }],
] as [string, Record<string, unknown>][]) {
  const o = await once(extra, true)
  const reused = o.total ? ((o.cache ?? 0) / o.total) * 100 : 0
  console.log(`${label.padEnd(46)} total ${o.total}  cached ${o.cache}  (${reused.toFixed(1)}% reused)`)
}
