/**
 * Does `response_format: json_schema` still constrain on THIS server build when the
 * session's `tools` array rides along? Every harness gate depends on it (forced-json.ts),
 * and `forcedJson` swallows a refusal into `null` — so if the server started refusing the
 * combination, every gate would have switched itself off without a trace.
 *
 *   npx tsx spike/response-format-check.mts
 */
import { createToolset } from '../core/src/tools/default-set.js'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const toolset = createToolset({ workspaceRoot: process.cwd() })
const realTools = toolset.registry.schemas()

const simple = {
  type: 'object', required: ['answer'], additionalProperties: false,
  properties: { answer: { type: 'string' } },
}
const nested = {
  type: 'object', required: ['open', 'search'], additionalProperties: false,
  properties: {
    open: { type: 'array', items: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string' } } } },
    search: { type: 'array', items: { type: 'string' } },
  },
}
const withEnum = {
  type: 'object', required: ['open'], additionalProperties: false,
  properties: {
    open: { type: 'array', items: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', enum: ['src/a.ts', 'src/b.ts', 'docs/readme.md'] } } } },
  },
}

async function attempt(label: string, body: Record<string, unknown>): Promise<void> {
  const started = performance.now()
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const wall = ((performance.now() - started) / 1000).toFixed(1)
  const text = await res.text()
  if (!res.ok) { console.log(`${label.padEnd(44)} HTTP ${res.status} ${wall}s ${text.slice(0, 120)}`); return }
  const data = JSON.parse(text)
  const content = String(data.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 100)
  const calls = data.choices?.[0]?.message?.tool_calls?.length ?? 0
  console.log(`${label.padEnd(44)} ok ${wall}s  tool_calls=${calls}  content=${content}`)
}

const messages = [
  { role: 'system', content: 'You are PrivateCode, a coding agent working in the local workspace D:\\x.' },
  { role: 'user', content: 'Which two files would you open first to fix the login form? Answer as JSON only.' },
]

async function main(): Promise<void> {
  const base = { model: 'kat', messages, max_tokens: 200, temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, cache_prompt: true }
  const rf = (schema: unknown, strict = true) => ({ type: 'json_schema', json_schema: { name: 'probe', ...(strict ? { strict: true } : {}), schema } })
  const think = { chat_template_kwargs: { enable_thinking: false } }
  await attempt('no tools, simple schema', { ...base, response_format: rf(simple) })
  await attempt('no tools, simple, thinking off', { ...base, ...think, response_format: rf(simple) })
  await attempt('no tools, nested schema', { ...base, ...think, response_format: rf(nested) })
  await attempt('no tools, enum schema', { ...base, ...think, response_format: rf(withEnum) })
  await attempt('REAL tools, simple schema', { ...base, ...think, tools: realTools, response_format: rf(simple) })
  await attempt('REAL tools, simple, strict absent', { ...base, ...think, tools: realTools, response_format: rf(simple, false) })
  await attempt('REAL tools, nested schema', { ...base, ...think, tools: realTools, response_format: rf(nested) })
  await attempt('REAL tools, enum schema', { ...base, ...think, tools: realTools, response_format: rf(withEnum) })
  await attempt('REAL tools, no response_format', { ...base, ...think, tools: realTools })
  await attempt('REAL tools, tool_choice none + schema', { ...base, ...think, tools: realTools, tool_choice: 'none', response_format: rf(nested) })
  await toolset.background.stopAll()
}

main().catch((e) => { console.error(e); process.exit(1) })
