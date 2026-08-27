/**
 * What does switching between two agents cost on this server?
 *
 * The sub-agent idea rests on a guess about context: give each sub-agent a small task, and
 * the orchestrator stays cheap. That is true about TOKENS and says nothing about TIME, and on
 * this setup time is what the whole architecture is built around. `/slots` reports one slot,
 * so there is exactly one KV cache: whichever agent speaks next displaces the other's prefix,
 * and the other pays to be read back in when its turn comes.
 *
 * This measures that directly. A prompt of realistic session size, sent three ways:
 *
 *   cold        first time, nothing cached — what a sub-agent's first word costs
 *   warm        the same prompt again — the append case the harness is built around
 *   displaced   the same prompt again, after a DIFFERENT prompt has used the slot
 *
 * The third is the switch. If `displaced` looks like `cold`, alternating agents pay a full
 * prefill each way and the token saving is bought with silence.
 *
 *   npx tsx spike/agent-switch-cost-probe.mts
 */
const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'

/** Roughly the size of a session that has done some work. */
function filler(words: number, salt: string): string {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(`${salt}${i % 977}`)
  return out.join(' ')
}

const AGENT_A = {
  role: 'system' as const,
  content: `You are the orchestrator.\n${filler(9000, 'alpha')}`,
}
const AGENT_B = {
  role: 'system' as const,
  content: `You are a sub-agent that reviews diffs.\n${filler(9000, 'beta')}`,
}

async function ask(label: string, system: { role: 'system'; content: string }): Promise<void> {
  const started = Date.now()
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [system, { role: 'user', content: 'Reply with the single word: ready' }],
      max_tokens: 4,
      temperature: 0,
      stream: false,
    }),
  })
  const body = await res.json() as {
    usage?: { prompt_tokens?: number }
    timings?: { prompt_n?: number; prompt_ms?: number; predicted_ms?: number }
  }
  const ms = Date.now() - started
  const t = body.timings ?? {}
  console.log(
    `  ${label.padEnd(28)} ${String(ms).padStart(6)} ms total` +
    `   prompt ${String(t.prompt_n ?? body.usage?.prompt_tokens ?? '?').padStart(6)} tok` +
    `   prefill ${String(Math.round(t.prompt_ms ?? 0)).padStart(6)} ms`,
  )
}

console.log('one slot, so one KV cache — these run in order and share it:\n')
await ask('A cold (nothing cached)', AGENT_A)
await ask('A warm (same prompt again)', AGENT_A)
await ask('B cold (the sub-agent)', AGENT_B)
await ask('A again, after B ran', AGENT_A)
await ask('B again, after A ran', AGENT_B)

/**
 * How MANY distinct prefixes does that cache hold?
 *
 * The five lines above overturned the assumption this probe was written to confirm: with one
 * slot, two alternating prompts still both came back warm. So the cache is not the slot — it
 * is llama.cpp's RAM prompt cache, and the question becomes its capacity, which is what
 * decides how many sub-agents can exist before one of them starts paying 60 s to speak.
 *
 * Six agents, each ~35k tokens, then all six asked again in the same order.
 */
console.log('\nsix agents, then all six again — where does it start evicting?\n')
const AGENTS = ['one', 'two', 'three', 'four', 'five', 'six'].map((n) => ({
  role: 'system' as const,
  content: `You are sub-agent ${n}.\n${filler(9000, n)}`,
}))

for (const [i, a] of AGENTS.entries()) await ask(`agent ${i + 1} cold`, a)
console.log()
for (const [i, a] of AGENTS.entries()) await ask(`agent ${i + 1} again`, a)
