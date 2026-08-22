/**
 * Does a reviewer-shaped request evict the conversation from the slot?
 *
 * The gate-price probe measured 77s of re-prefill at 38k tokens and 6s at 107k, which cannot
 * both be right. `--np 1`: one slot, so a foreign prompt should displace whatever it held.
 * This asks the question on its own, three times, reading `prompt_progress.cache` — the
 * server's own statement of how much of the prompt it already had.
 *
 *   npx tsx spike/reviewer-cache-probe.mts [tokens] [rounds]
 */
const BASE = process.env.LLAMA_URL ?? 'http://127.0.0.1:8080'

function conversation(blocks: number, salt: string) {
  const msgs: any[] = [{ role: 'system', content: 'You are PrivateCode.' }]
  for (let n = 0; n < blocks; n++) {
    msgs.push({ role: 'user', content: Array.from({ length: 60 }, (_, i) =>
      `${i + 1}\t${salt} const value_${n}_${i} = compute(${i});`).join('\n') })
    msgs.push({ role: 'assistant', content: 'read.' })
  }
  msgs.push({ role: 'user', content: 'Say ok.' })
  return msgs
}

/** One streamed request; returns what the server said it already had cached. */
async function send(messages: any[]): Promise<{ total: number; cache: number; ms: number }> {
  const started = Date.now()
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: 1, stream: true, return_progress: true, cache_prompt: true }),
  })
  let total = 0, cache = 0
  const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = ''
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    for (const line of buf.split('\n')) {
      const t = line.trim(); if (!t.startsWith('data: ') || t === 'data: [DONE]') continue
      try { const j = JSON.parse(t.slice(6)); if (j.prompt_progress) {
        total = j.prompt_progress.total ?? total; cache = j.prompt_progress.cache ?? cache } } catch {}
    }
    buf = buf.slice(buf.lastIndexOf('\n') + 1)
  }
  return { total, cache, ms: Date.now() - started }
}

const blocks = Number(process.argv[2] ?? 60)
const rounds = Number(process.argv[3] ?? 3)
const salt = `rc${process.pid}`
const convo = conversation(blocks, salt)
const reviewer = [
  { role: 'system', content: 'You are reviewing a change you did not make.' },
  { role: 'user', content: `Review this diff.\n${'+ const x = 1;\n'.repeat(400)}` },
]

for (let i = 1; i <= rounds; i++) {
  const warm1 = await send(convo)
  const warm2 = await send(convo)
  const rev = await send(reviewer)
  const after = await send(convo)
  console.log(
    `round ${i}: convo ${warm2.total} tok, cached ${warm2.cache} (${warm2.ms}ms)` +
    `  -> reviewer ${rev.total} tok` +
    `  -> convo again: cached ${after.cache}/${after.total} (${after.ms}ms)` +
    `  ${after.cache >= after.total - 5 ? 'STILL CACHED' : 'EVICTED'}`,
  )
}
