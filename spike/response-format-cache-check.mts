/**
 * Is a forced-JSON request with `tool_choice: 'none'` still a pure append onto the warm
 * prefix the ordinary steps built? Reads the server's own prompt timings: a cached prefix
 * shows as a prompt_ms of a few hundred milliseconds, a re-read of the tool block as seconds.
 *
 *   npx tsx spike/response-format-cache-check.mts
 */
import { createToolset } from '../core/src/tools/default-set.js'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const toolset = createToolset({ workspaceRoot: process.cwd() })
const tools = toolset.registry.schemas()
const system = {
  role: 'system',
  content: 'You are PrivateCode, a coding agent working in the local workspace D:\\x.\n' + 'Filler text. '.repeat(600),
}
const user = { role: 'user', content: 'Which two files would you open first to fix the login form?' }
const schema = {
  type: 'object', required: ['open'], additionalProperties: false,
  properties: { open: { type: 'array', items: { type: 'string' } } },
}
const forced = {
  tool_choice: 'none',
  response_format: { type: 'json_schema', json_schema: { name: 'p', strict: true, schema } },
}

async function call(label: string, extra: Record<string, unknown>): Promise<void> {
  const t0 = performance.now()
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'kat', messages: [system, user], tools, max_tokens: 120,
      temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false }, ...extra,
    }),
  })
  const wall = ((performance.now() - t0) / 1000).toFixed(1)
  const data = await res.json() as { timings?: Record<string, number>; choices?: { message?: { content?: string } }[] }
  const t = data.timings ?? {}
  console.log(
    `${label.padEnd(34)} ${res.status} ${wall}s prompt_n=${t['prompt_n']} ` +
    `prompt_ms=${Math.round(t['prompt_ms'] ?? 0)} gen=${t['predicted_n']}  ` +
    `${String(data.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 60)}`,
  )
}

await call('ordinary step (tools, auto)', {})
await call('ordinary step again (warm)', {})
await call('forced json, tool_choice none', forced)
await call('forced json again', forced)
await call('ordinary step after forced', {})
await toolset.background.stopAll()
