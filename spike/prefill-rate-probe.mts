/**
 * The rate this server ACTUALLY prefills at, from its own `prompt_progress.time_ms`.
 *
 * `PREFILL_MS_PER_TOKEN` was set from a 726-739 tok/s measurement (1.37 ms/token) taken on
 * an earlier build. The constant sizes the extra grace a step gets for bytes the server has
 * not seen, so setting it below the real rate makes a healthy long step look wedged.
 *
 *   npx tsx spike/prefill-rate-probe.mts
 */
const BASE = process.env.LLAMA_URL ?? 'http://127.0.0.1:8080'

/** Unique text, so no prefix of it is already in the server's cache. */
function filler(n: number, salt: string): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(`${salt}-${i} const value_${i} = compute(${i}, "${salt}");`)
  return out.join('\n')
}

async function measure(lines: number, salt: string): Promise<void> {
  const body = {
    messages: [{ role: 'user', content: `Reply with the single word ok.\n\n${filler(lines, salt)}` }],
    max_tokens: 1, stream: true, return_progress: true, cache_prompt: true,
  }
  const started = Date.now()
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  let total = 0, cache = 0, timeMs = 0
  const reader = r.body!.getReader()
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
  const wall = Date.now() - started
  const fresh = total - cache
  const perTok = fresh > 0 ? timeMs / fresh : 0
  console.log(
    `total ${String(total).padStart(6)}  cache ${String(cache).padStart(6)}  ` +
    `time_ms ${String(timeMs).padStart(6)}  ->  ${perTok.toFixed(2)} ms/tok  ` +
    `(${Math.round(1000 / perTok)} tok/s)   wall ${(wall / 1000).toFixed(1)}s`,
  )
}

const salt = process.argv[2] ?? String(process.pid)
for (const n of [120, 400, 900]) await measure(n, `${salt}x${n}`)
