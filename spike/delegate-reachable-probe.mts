/**
 * Can the model call `delegate` AT ALL?
 *
 * Every measurement so far asked whether it CHOOSES to, and read the answer as a judgement
 * the model declines to make. That reading assumes the call is available and merely not
 * picked — which was never checked. If a direct instruction cannot produce one either, the
 * problem is mechanical and everything concluded from the other probes is wrong.
 *
 *   npx tsx spike/delegate-reachable-probe.mts
 */
import { delegateTool } from '../core/src/tools/delegate.js'
import { buildRegistry } from '../core/src/tools/default-set.js'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const del = {
  type: 'function',
  function: {
    name: delegateTool.name,
    description: delegateTool.description,
    parameters: delegateTool.parameters,
  },
}
const others = buildRegistry().schemas().map((s) => ({ type: 'function', function: s.function }))

async function ask(label: string, tools: unknown[], text: string): Promise<void> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: text }],
      tools, temperature: 0.7, top_p: 0.8, max_tokens: 300, stream: false,
    }),
  })
  if (!res.ok) { console.log(`  ${label.padEnd(34)} HTTP ${res.status} ${(await res.text()).slice(0, 120)}`); return }
  const body = await res.json() as {
    choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[]; content?: string } }[]
  }
  const call = body.choices?.[0]?.message?.tool_calls?.[0]?.function
  const got = call
    ? `${call.name} ${(call.arguments ?? '').replace(/\s+/g, ' ').slice(0, 70)}`
    : `(no call) ${(body.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 70)}`
  console.log(`  ${label.padEnd(34)} ${got}`)
}

const DIRECT = 'Call the delegate tool. Use role "investigate" and ask it to find out where ' +
  'the slug helper lives in this codebase.'

console.log('is it reachable when told outright?\n')
await ask('alone in the array', [del], DIRECT)
await ask('alone, and no role enum', [{
  type: 'function',
  function: {
    name: 'delegate',
    description: delegateTool.description,
    parameters: {
      type: 'object',
      required: ['role', 'task'],
      properties: { role: { type: 'string' }, task: { type: 'string' } },
    },
  },
}], DIRECT)
await ask('beside the other 21', [del, ...others], DIRECT)
