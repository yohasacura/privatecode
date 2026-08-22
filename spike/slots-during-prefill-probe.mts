/**
 * Can `/slots` be reached WHILE the server is prefilling?
 *
 * The step clock's prefill extension is the only thing standing between a healthy long
 * prefill and a killed step: when the first-token window expires it asks `/slots` whether the
 * server is making progress, re-arms if it is, and gives up if it is not. That question is
 * asked with a 3 s timeout — and llama.cpp is single-threaded over its decode batches, so
 * during a big prefill it only answers HTTP between batches.
 *
 * This drives a real cold prefill and polls `/slots` alongside it with the shipped timeout,
 * counting how often the probe the extension depends on simply does not answer.
 *
 *   npx tsx spike/slots-during-prefill-probe.mts [lines]
 *   SLOTS_TIMEOUT_MS=8000 npx tsx spike/slots-during-prefill-probe.mts 900
 */
const BASE = process.env.LLAMA_URL ?? 'http://127.0.0.1:8080'
const SHIPPED_TIMEOUT_MS = Number(process.env.SLOTS_TIMEOUT_MS ?? 3_000)
const POLL_EVERY_MS = 1_500

/** Unique text, so no prefix of it is already cached. */
function filler(n: number, salt: string): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(`${salt}-${i} const value_${i} = compute(${i}, "${salt}");`)
  return out.join('\n')
}

interface Poll { atMs: number; tookMs: number; ok: boolean; why: string; processing?: boolean; processed?: number }

async function pollSlots(timeoutMs: number): Promise<Omit<Poll, 'atMs'>> {
  try {
    const res = await fetch(`${BASE}/slots`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` }
    const arr = await res.json() as { is_processing?: boolean; n_prompt_tokens_processed?: number }[]
    const slot = Array.isArray(arr) ? arr[0] : undefined
    if (slot === undefined) return { ok: false, why: 'no slot' }
    return {
      ok: true,
      why: 'ok',
      processing: slot.is_processing === true,
      processed: slot.n_prompt_tokens_processed ?? 0,
    }
  } catch (e) {
    return { ok: false, why: (e as Error).name === 'TimeoutError' ? 'TIMEOUT' : (e as Error).name }
  }
}

const lines = Number(process.argv[2] ?? 900)
const salt = `slotsprobe${process.pid}`
const started = Date.now()
const polls: Poll[] = []
let generating = true

// Poll for the whole life of the request, exactly the way the step clock would.
const poller = (async () => {
  while (generating) {
    const at = Date.now() - started
    const t0 = Date.now()
    const r = await pollSlots(SHIPPED_TIMEOUT_MS)
    polls.push({ atMs: at, tookMs: Date.now() - t0, ...r })
    await new Promise((r2) => setTimeout(r2, POLL_EVERY_MS))
  }
})()

const body = {
  messages: [{ role: 'user', content: `Reply with the single word ok.\n\n${filler(lines, salt)}` }],
  max_tokens: 1, stream: true, return_progress: true, cache_prompt: true,
}
const res = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
let total = 0, cache = 0, timeMs = 0
const reader = res.body!.getReader()
const dec = new TextDecoder()
let buf = ''
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  for (const line of buf.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data: ') || t === 'data: [DONE]') continue
    try {
      const j = JSON.parse(t.slice(6))
      if (j.prompt_progress) {
        total = j.prompt_progress.total ?? total
        cache = j.prompt_progress.cache ?? cache
        timeMs = j.prompt_progress.time_ms ?? timeMs
      }
    } catch { /* partial frame */ }
  }
  buf = buf.slice(buf.lastIndexOf('\n') + 1)
}
generating = false
await poller

const fresh = total - cache
console.log(`prefill : ${fresh} fresh tokens in ${timeMs} ms (${(timeMs / fresh).toFixed(2)} ms/tok)`)
console.log(`polls   : ${polls.length}, timeout ${SHIPPED_TIMEOUT_MS} ms, every ${POLL_EVERY_MS} ms\n`)
for (const p of polls) {
  const detail = p.ok ? `processing=${p.processing} processed=${p.processed}` : p.why
  console.log(
    `  t+${String(Math.round(p.atMs / 100) / 10).padStart(5)}s  took ${String(p.tookMs).padStart(4)}ms  ` +
    `${p.ok ? 'ok     ' : 'FAILED '} ${detail}`,
  )
}
const answered = polls.filter((p) => p.ok)
if (answered.length > 0) {
  const took = answered.map((p) => p.tookMs).sort((a, b) => a - b)
  const worst = took[took.length - 1]!
  console.log(
    `
answer latency: median ${took[Math.floor(took.length / 2)]}ms, worst ${worst}ms ` +
    `-> ${Math.round(100 * worst / SHIPPED_TIMEOUT_MS)}% of the ${SHIPPED_TIMEOUT_MS}ms timeout`,
  )
}
const failed = polls.filter((p) => !p.ok)
console.log(`\n=> ${failed.length}/${polls.length} polls did not answer (${Math.round(100 * failed.length / polls.length)}%)`)

// The consequence, spelled out: what the shipped `fire()` would have concluded each time.
const wouldKill = polls.filter((p) => !p.ok || !p.processing)
console.log(`=> ${wouldKill.length}/${polls.length} would have made the step clock give up`)
