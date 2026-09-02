/**
 * Can a request pick its speculative-decoding types, and does n-gram lookup help the output
 * a coding agent produces most — code copied out of the context with a change in it?
 *
 * The MTP head drafts at 0.46–0.52 acceptance. An `edit_file` call is mostly a verbatim copy
 * of lines already in the prompt, which is exactly what n-gram lookup drafts perfectly. This
 * server build lists `ngram-simple, ngram-map-k, ngram-map-k4v, ngram-mod, ngram-cache`
 * beside `draft-mtp`, and `default_generation_settings.params` carries a
 * `speculative.types` field — so the question is whether a request may set it.
 *
 *   npx tsx spike/spec-types-probe.mts
 */
import { readFileSync } from 'node:fs'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'

// A real 190-line C# file as the thing to copy from.
const source = readFileSync('D:\\Projects\\WindowsOptimizer\\src\\WinOptimizer\\Services\\PowerTweaker.cs', 'utf8')
const numbered = source.split(/\r?\n/).map((l, i) => `${i + 1}\t${l}`).join('\n')

const messages = [
  { role: 'system', content: 'You are PrivateCode, a coding agent working in the local workspace D:\\x.' },
  {
    role: 'user',
    content:
      `src/WinOptimizer/Services/PowerTweaker.cs (${numbered.split('\n').length} lines)\n${numbered}\n\n` +
      'Rewrite the whole file verbatim, changing only the class name PowerTweaker to PowerAdjuster ' +
      'everywhere it appears. Output the complete file and nothing else.',
  },
]

async function run(label: string, extra: Record<string, unknown>): Promise<void> {
  const t0 = performance.now()
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'kat', messages, max_tokens: 2600, temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0,
      cache_prompt: true, chat_template_kwargs: { enable_thinking: false }, ...extra,
    }),
  })
  const wall = ((performance.now() - t0) / 1000).toFixed(1)
  const text = await res.text()
  if (!res.ok) { console.log(`${label.padEnd(36)} HTTP ${res.status} ${text.slice(0, 200)}`); return }
  const data = JSON.parse(text) as { timings?: Record<string, number>; choices?: { message?: { content?: string } }[] }
  const t = data.timings ?? {}
  const out = data.choices?.[0]?.message?.content ?? ''
  console.log(
    `${label.padEnd(36)} ${wall}s  gen=${t['predicted_n']} at ${(t['predicted_per_second'] ?? 0).toFixed(1)} tok/s  ` +
    `draft=${t['draft_n'] ?? '-'} accepted=${t['draft_n_accepted'] ?? '-'}  prompt_ms=${Math.round(t['prompt_ms'] ?? 0)}  ` +
    `renamed=${(out.match(/PowerAdjuster/g) ?? []).length} leftover=${(out.match(/PowerTweaker/g) ?? []).length}`,
  )
}

await run('server default (draft-mtp)', {})
await run('server default again (warm)', {})
await run('speculative.types [ngram-map-k4v]', { speculative: { types: ['ngram-map-k4v'] } })
await run('speculative.types [draft-mtp,ngram-map-k4v]', { speculative: { types: ['draft-mtp', 'ngram-map-k4v'] } })
await run('speculative.types [ngram-simple]', { speculative: { types: ['ngram-simple'] } })
await run('speculative.types [none]', { speculative: { types: ['none'] } })
