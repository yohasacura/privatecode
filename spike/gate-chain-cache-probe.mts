/**
 * Do the gates evict each OTHER?
 *
 * A single reviewer-shaped request does not evict a 78k conversation — measured 3/3 with
 * `spike/reviewer-cache-probe.mts`, `cached 77779/77783` afterwards. So the harness's own
 * claim that the diff review costs the next turn a full cold prefill does not reproduce in
 * isolation.
 *
 * But the gate-price probe measured a premise check at 204 s on a 107k conversation, which is
 * a full re-prefill, and it ran right after the understanding check. The suspect is
 * `groupLines`: the one call in the codebase that still swaps the tools array, and a swapped
 * array renders at the FRONT of the prompt, so it is a different prefix from the first token.
 *
 * This runs the gates in the order a real turn runs them and reads `prompt_progress.cache`
 * after each one — the server's own statement of how much of the conversation it still had.
 *
 *   npx tsx spike/gate-chain-cache-probe.mts [blocks]
 */
import { createToolset } from '../core/src/tools/default-set.js'

const BASE = process.env.LLAMA_URL ?? 'http://127.0.0.1:8080'
const tools = createToolset({ workspaceRoot: process.cwd() } as never).registry.schemas()

function conversation(blocks: number, salt: string): any[] {
  const msgs: any[] = [{ role: 'system', content: 'You are PrivateCode.' }]
  for (let n = 0; n < blocks; n++) {
    msgs.push({ role: 'user', content: Array.from({ length: 60 }, (_, i) =>
      `${i + 1}\t${salt} const value_${n}_${i} = compute(${i});`).join('\n') })
    msgs.push({ role: 'assistant', content: 'read.' })
  }
  msgs.push({ role: 'user', content: 'Say ok.' })
  return msgs
}

async function send(body: Record<string, unknown>): Promise<{ total: number; cache: number; ms: number }> {
  const started = Date.now()
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ max_tokens: 1, stream: true, return_progress: true, cache_prompt: true, ...body }),
  })
  let total = 0, cache = 0
  const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = ''
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    for (const line of buf.split('\n')) {
      const t = line.trim(); if (!t.startsWith('data: ') || t === 'data: [DONE]') continue
      try {
        const j = JSON.parse(t.slice(6))
        if (j.prompt_progress) {
          total = j.prompt_progress.total ?? total
          cache = j.prompt_progress.cache ?? cache
        }
      } catch { /* partial frame */ }
    }
    buf = buf.slice(buf.lastIndexOf('\n') + 1)
  }
  return { total, cache, ms: Date.now() - started }
}

const blocks = Number(process.argv[2] ?? 60)
const salt = `gc${process.pid}`
const convo = conversation(blocks, salt)

/** Each entry is what one gate SENDS, in the shape that matters for the cache. */
const chain: { name: string; body: Record<string, unknown> }[] = [
  {
    name: 'a gate that appends (contract / premise / audit)',
    body: { messages: [...convo, { role: 'user', content: '[Audit the work above. Answer with JSON only.]' }], tools },
  },
  {
    name: 'a lens reading (appends, same tools)',
    body: { messages: [...convo, { role: 'user', content: '[Read the request literally. Answer with JSON only.]' }], tools },
  },
  {
    name: 'groupLines (SWAPS the tools array)',
    body: {
      messages: [{ role: 'user', content: '1. a\n2. b\n3. c\n\nGroup the ones that mean the same thing.' }],
      tools: [{ type: 'function', function: { name: 'group_lines', description: 'Group lines.', parameters: { type: 'object', properties: { groups: { type: 'array', items: { type: 'array', items: { type: 'number' } } } }, required: ['groups'] } } }],
    },
  },
  {
    name: 'restates merge (sends NO tools)',
    body: { messages: [{ role: 'user', content: 'Criteria:\n1. x\nTicked:\n1. y\nAnswer with JSON only.' }] },
  },
  {
    name: 'the diff reviewer (fresh transcript, own tool set)',
    body: {
      messages: [{ role: 'system', content: 'You are reviewing a change you did not make.' },
        { role: 'user', content: `Review this diff.\n${'+ const x = 1;\n'.repeat(400)}` }],
      tools: tools.slice(0, 5),
    },
  },
]

const first = await send({ messages: convo, tools })
console.log(`conversation: ${first.total} tokens\n`)
await send({ messages: convo, tools })

for (const step of chain) {
  await send({ messages: convo, tools })            // conversation warm again
  await send(step.body)                              // the gate
  const after = await send({ messages: convo, tools }) // what survived
  const lost = after.total - after.cache
  console.log(
    `  after ${step.name.padEnd(48)} cached ${after.cache}/${after.total}` +
    `  ${lost <= 5 ? 'SURVIVED' : `LOST ${lost} tok -> ${(after.ms / 1000).toFixed(1)}s to re-prefill`}`,
  )
}
