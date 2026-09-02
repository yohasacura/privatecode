/**
 * Does this server's schema-to-grammar honour `maxItems` and `maxLength`? If it does, a
 * contract cannot sprout nine criteria and an audit's evidence cannot run to a paragraph
 * per criterion — structure bounding what prose asks for and gets ignored on.
 *
 *   npx tsx spike/grammar-bounds-probe.mts
 */
import { createToolset } from '../core/src/tools/default-set.js'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const toolset = createToolset({ workspaceRoot: process.cwd() })
const tools = toolset.registry.schemas()

async function ask(label: string, schema: unknown, prompt: string, maxTokens = 700): Promise<void> {
  const t0 = performance.now()
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'kat',
      messages: [
        { role: 'system', content: 'You are PrivateCode, a coding agent working in the local workspace D:\\x.' },
        { role: 'user', content: prompt },
      ],
      tools, tool_choice: 'none',
      response_format: { type: 'json_schema', json_schema: { name: 'b', strict: true, schema } },
      max_tokens: maxTokens, temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0,
      cache_prompt: true, chat_template_kwargs: { enable_thinking: false },
    }),
  })
  const wall = ((performance.now() - t0) / 1000).toFixed(1)
  const text = await res.text()
  if (!res.ok) { console.log(`${label}: HTTP ${res.status} ${wall}s ${text.slice(0, 160)}`); return }
  const data = JSON.parse(text)
  const content = data.choices?.[0]?.message?.content ?? ''
  let parsed: any = null
  try { parsed = JSON.parse(content) } catch { /* shown raw below */ }
  const t = data.timings ?? {}
  console.log(`${label}: ${wall}s gen=${t.predicted_n} finish=${data.choices?.[0]?.finish_reason}`)
  console.log(`   ${content.replace(/\s+/g, ' ').slice(0, 400)}`)
  if (parsed?.items) console.log(`   items=${parsed.items.length}, longest=${Math.max(...parsed.items.map((s: string) => s.length))}`)
  if (parsed?.audit) console.log(`   audit rows=${parsed.audit.length}, evidence lengths=${parsed.audit.map((a: any) => a.evidence.length).join(',')}`)
}

const LIST = 'List every reason a login form might not show the API validation error. Give as many as you can, at least ten. JSON only.'

await ask('maxItems 4 on an array', {
  type: 'object', required: ['items'], additionalProperties: false,
  properties: { items: { type: 'array', maxItems: 4, items: { type: 'string' } } },
}, LIST)

await ask('maxLength 60 on strings', {
  type: 'object', required: ['items'], additionalProperties: false,
  properties: { items: { type: 'array', items: { type: 'string', maxLength: 60 } } },
}, 'Explain in three long sentences why prefix caching matters for a local LLM agent. JSON only, one sentence per item.')

await ask('audit rows with evidence maxLength 160', {
  type: 'object', required: ['audit'], additionalProperties: false,
  properties: {
    audit: {
      type: 'array',
      items: {
        type: 'object', required: ['index', 'evidence', 'met'], additionalProperties: false,
        properties: {
          index: { type: 'integer' },
          evidence: { type: 'string', maxLength: 160 },
          met: { type: 'boolean' },
        },
      },
    },
  },
}, 'Audit these three criteria against an imaginary conversation where only the first was demonstrated by a test run: 1. the counter never repeats a value 2. the build passes 3. a migration was added. For each, write the evidence at length, then met. JSON only.')

await toolset.background.stopAll()
