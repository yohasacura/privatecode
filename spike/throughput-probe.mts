/**
 * The two numbers every design decision in this project is derived from, re-measured
 * against the model that is actually loaded.
 *
 * `docs/DESIGN.md` §2 records 545 tok/s prefill and 60.6 tok/s generation, measured against
 * Qwen3.6-35B-A3B. The server now serves KAT-Coder-V2.5-Dev. Everything downstream — the
 * step timeout, the cold-start budget, the prefill allowance, "output tokens are 13x input"
 * — is arithmetic on those two numbers.
 *
 *   npx tsx spike/throughput-probe.mts
 */
const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'

interface Timings {
  prompt_n?: number; prompt_per_second?: number; prompt_ms?: number
  predicted_n?: number; predicted_per_second?: number; predicted_ms?: number
  draft_n?: number; draft_n_accepted?: number
}

async function run(label: string, prompt: string, maxTokens: number): Promise<void> {
  const started = performance.now()
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'kat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      stream: false,
      temperature: 0.6, top_p: 0.95, top_k: 20,
      cache_prompt: false,
      timings_per_token: true,
      chat_template_kwargs: { enable_thinking: false },
    }),
  })
  const seconds = (performance.now() - started) / 1000
  const j = await res.json() as { timings?: Timings; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  const t = j.timings ?? {}
  const accept = t.draft_n && t.draft_n > 0 ? (t.draft_n_accepted ?? 0) / t.draft_n : null
  console.log(
    `${label.padEnd(34)} prefill ${String(t.prompt_n ?? j.usage?.prompt_tokens ?? '?').padStart(6)} tok` +
    ` @ ${(t.prompt_per_second ?? 0).toFixed(0).padStart(5)} tok/s  |` +
    ` generated ${String(t.predicted_n ?? j.usage?.completion_tokens ?? '?').padStart(5)} tok` +
    ` @ ${(t.predicted_per_second ?? 0).toFixed(1).padStart(6)} tok/s  |` +
    ` wall ${seconds.toFixed(1)} s` +
    (accept !== null ? `  | MTP draft acceptance ${(accept * 100).toFixed(0)}%` : ''))
}

console.log(`server ${BASE}\n`)

const filler = 'The session store writes each checkpoint as a separate file on disk. '
await run('short prompt, long generation', 'Write a 400-word explanation of what a write-ahead log is.', 700)
await run('short prompt, long generation (2)', 'Explain, in about 400 words, how a B-tree index works.', 700)
await run('long prompt (~8k), short generation', filler.repeat(600) + '\n\nReply with the single word: ok.', 8)
await run('long prompt (~24k), short generation', filler.repeat(1800) + '\n\nReply with the single word: ok.', 8)
