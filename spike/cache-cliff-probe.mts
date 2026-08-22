/**
 * Where does the conversation stop surviving a gate?
 *
 * Measured: at 78k and 90k tokens every gate shape leaves the conversation fully cached, so
 * the harness's "the next turn pays a cold prefill" is false there. But the gate-price probe
 * saw a full re-prefill on a 107k conversation, and a note from an earlier session records a
 * live eviction at 179k with "the state outgrew --cache-ram".
 *
 * So there is a size above which the RAM cache stops holding it, and BELOW that size every
 * gate costs only its own generation. That number decides whether the gates are expensive.
 *
 *   npx tsx spike/cache-cliff-probe.mts
 */
const BASE = process.env.LLAMA_URL ?? 'http://127.0.0.1:8080'

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
        if (j.prompt_progress) { total = j.prompt_progress.total ?? total; cache = j.prompt_progress.cache ?? cache }
      } catch { /* partial frame */ }
    }
    buf = buf.slice(buf.lastIndexOf('\n') + 1)
  }
  return { total, cache, ms: Date.now() - started }
}

/** One foreign prompt, the shape the diff reviewer sends. */
const reviewer = {
  messages: [{ role: 'system', content: 'You are reviewing a change you did not make.' },
    { role: 'user', content: `Review this diff.\n${'+ const x = 1;\n'.repeat(400)}` }],
}

for (const blocks of [60, 80, 100, 120]) {
  const convo = conversation(blocks, `cc${process.pid}b${blocks}`)
  const warm = await send({ messages: convo })
  await send({ messages: convo })
  await send(reviewer)
  const after = await send({ messages: convo })
  const lost = after.total - after.cache
  console.log(
    `${String(warm.total).padStart(7)} tokens -> after one foreign prompt: cached ` +
    `${after.cache}/${after.total}  ${lost <= 5 ? 'SURVIVED' : `EVICTED, ${(after.ms / 1000).toFixed(0)}s to rebuild`}`,
  )
}
