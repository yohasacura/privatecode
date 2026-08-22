/**
 * What each gate costs, in seconds, on a WARM conversation of a realistic size.
 *
 * The question this answers is not "how many tokens does it generate" — the caps are in the
 * source and easy to read. It is: how much wall-clock does the turn pay for each gate once
 * the server is already holding the conversation, which is the state every gate but the first
 * actually runs in. A gate that appends to the warm prefix pays for its own generation; a gate
 * that sends a DIFFERENT prompt pays to prefill the whole thing again.
 *
 * Every gate below is the shipped function, called against the live server, timed end to end.
 *
 *   npx tsx spike/gate-price-probe.mts [transcriptTokens]
 */
import { checkAcceptance, distillContract } from '../core/src/session/contract.js'
import { statePremises } from '../core/src/session/premises.js'
import { foldAnswerWithModel, readThroughLenses } from '../core/src/session/understanding.js'
import { LlamaClient } from '../core/src/llama/client.js'
import type { ChatMessage } from '../core/src/llama/types.js'
import { createToolset } from '../core/src/tools/default-set.js'

const BASE = process.env.LLAMA_URL ?? 'http://127.0.0.1:8080'
const client = new LlamaClient({ baseUrl: BASE, model: process.env.LLAMA_MODEL ?? 'local' })
const tools = createToolset({ workspaceRoot: process.cwd() } as never).registry.schemas()

const REQUEST =
  'In src/util/slug.js the slug() function does not strip punctuation, so "Hello, World!" ' +
  'becomes "hello,-world!". Make slugs contain only lowercase letters, digits and single ' +
  'hyphens, with no leading or trailing hyphen. Read the file first, then change it, and ' +
  'add a test that fails before the change and passes after.'

const CONTRACT = {
  goal: 'slug() produces slugs that hold the charset rule',
  criteria: [
    'slugs contain only lowercase letters, digits and single hyphens',
    'no leading or trailing hyphen',
    'a test exists that fails before the change and passes after',
  ],
  constraints: [],
}

/** A conversation of roughly the requested size, shaped like a real one: reads and writes. */
function transcript(targetTokens: number): ChatMessage[] {
  const out: ChatMessage[] = [
    { role: 'system', content: 'You are PrivateCode, a coding agent working in one workspace.' },
    { role: 'user', content: REQUEST },
  ]
  let tokens = 60
  let n = 0
  while (tokens < targetTokens) {
    n++
    const body = Array.from({ length: 60 }, (_, i) =>
      `${i + 1}\tconst value_${n}_${i} = compute(${i}, "block ${n}");`).join('\n')
    out.push({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: `c${n}`,
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: `src/mod${n}.ts` }) },
      }],
    } as ChatMessage)
    out.push({ role: 'tool', tool_call_id: `c${n}`, content: body } as ChatMessage)
    tokens += Math.ceil(body.length / 3.6) + 30
  }
  out.push({
    role: 'assistant',
    content: 'I read the files and rewrote slug() to strip punctuation. The test passes.',
  })
  return out
}

/** Push the conversation through the server once, so the prefix is genuinely warm. */
async function warm(messages: ChatMessage[]): Promise<number> {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, tools, max_tokens: 1, stream: false, cache_prompt: true }),
  })
  const j = await r.json() as { usage?: { prompt_tokens?: number } }
  return j.usage?.prompt_tokens ?? 0
}

interface Row { gate: string; seconds: number; gens: number; note: string }
const rows: Row[] = []

async function time(gate: string, gens: number, note: string, run: () => Promise<unknown>): Promise<void> {
  const t0 = Date.now()
  const out = await run()
  const seconds = (Date.now() - t0) / 1000
  rows.push({ gate, seconds, gens, note: out === null ? `${note} (returned null)` : note })
  console.log(`  ${gate.padEnd(34)} ${seconds.toFixed(1).padStart(6)}s  ${gens} gen  ${note}`)
}

const target = Number(process.argv[2] ?? 20_000)
const messages = transcript(target)
const promptTokens = await warm(messages)
console.log(`conversation: ${promptTokens} prompt tokens, warm\n`)

// Each gate is re-warmed before it runs, so what is measured is that gate alone rather than
// the damage the previous one did to the cache.
await time('contract distillation', 1, 'once per task-shaped message', async () => {
  await warm(messages)
  return await distillContract(client, messages, REQUEST, undefined, tools)
})

await time('understanding: 3 lenses + grouping', 4, 'once, before the first write', async () => {
  await warm(messages)
  return await readThroughLenses(client, messages, REQUEST, undefined, tools)
})

await time('premise check', 1, 'once, before the first write', async () => {
  await warm(messages)
  return await statePremises(client, messages, undefined, tools)
})

await time('acceptance audit (one round)', 1, 'every turn that says it is finished', async () => {
  await warm(messages)
  return await checkAcceptance(client, messages, CONTRACT as never, undefined, tools)
})

// The restates merge only runs when a question was actually answered.
await time('restates merge', 1, 'only when a question was answered', async () => {
  await warm(messages)
  const u = { shared: [], contested: ['slugs never contain punctuation'] }
  return await foldAnswerWithModel(client, u, u.contested[0]!, CONTRACT.criteria)
})

// The reviewer's own prompt shares NOTHING with the conversation: a fresh transcript. What it
// costs is a cold prefill of its brief plus its read loop, and -- the part that is invisible
// here -- it leaves the session's cache displaced for the NEXT turn.
await time('diff reviewer: one cold verdict', 1, 'turns whose diff clears the threshold', async () => {
  const brief: ChatMessage[] = [
    { role: 'system', content: 'You are reviewing a change you did not make.' },
    { role: 'user', content: `Review this diff against the contract.\n\n${'+ const x = 1;\n'.repeat(400)}` },
  ]
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: brief, tools, max_tokens: 300, stream: false, cache_prompt: true }),
  })
  return await r.json()
})

// And the bill the reviewer hands the NEXT turn: the conversation is no longer cached.
const coldStart = Date.now()
const coldTokens = await warm(messages)
const coldSeconds = (Date.now() - coldStart) / 1000
console.log(`\n  re-prefill of the conversation after the reviewer: ${coldSeconds.toFixed(1)}s for ${coldTokens} tokens`)

const total = rows.reduce((n, r) => n + r.seconds, 0)
console.log(`\n  every gate once, on a ${promptTokens}-token conversation: ${total.toFixed(0)}s`)
console.log(`  plus the reviewer's cold-prefill bill on the next turn: ${coldSeconds.toFixed(0)}s`)
