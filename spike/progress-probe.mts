/**
 * What the live server actually sends when a request asks to be watched.
 *
 * Everything about `prompt_progress` and `timings_per_token` in `llama/client.ts` was written
 * from documentation — the streaming spike that produced the rest of that parser predates
 * both. This is the measurement: a real request against the real server, printing every
 * progress delta the client produces, plus the raw frames behind them, so the wire format is
 * confirmed rather than assumed and the throttle interval is chosen against an observed rate.
 *
 * Run with the server up and idle. It displaces whatever prefix the slot is holding.
 *
 *   npx tsx spike/progress-probe.mts
 */
import { LlamaClient } from '../core/src/llama/client.js'
import type { StreamProgress } from '../core/src/llama/types.js'

const BASE_URL = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'

/** Big enough that prefill is a phase rather than an instant — the state this whole feature
 * exists to show. Nonsense on purpose: a cached prefix would measure nothing. */
function filler(paragraphs: number): string {
  const out: string[] = []
  for (let i = 0; i < paragraphs; i++) {
    out.push(
      `Note ${i}: the invoice service reads counter ${i * 7} from the ledger, formats it ` +
      `with padding ${i % 5}, and writes it back under lock ${i % 3}. Unrelated to the ` +
      `question below; it is here to make the prompt long enough to measure.`,
    )
  }
  return out.join('\n')
}

async function main(): Promise<void> {
  const client = new LlamaClient({ baseUrl: BASE_URL, model: 'qwen' })

  const started = Date.now()
  const stamps: { at: number; progress: StreamProgress }[] = []
  let firstTokenAt: number | undefined

  const result = await client.chatStream({
    messages: [
      { role: 'user', content: `${filler(400)}\n\nIn one short sentence: what is 2 + 2?` },
    ],
    maxTokens: 200,
    disableThinking: true,
  }, {
    onDelta: (d) => {
      if (d.progress) stamps.push({ at: Date.now() - started, progress: d.progress })
      if ((d.content || d.reasoning) && firstTokenAt === undefined) firstTokenAt = Date.now() - started
    },
  })

  console.log('--- progress deltas, in order -------------------------------------------')
  for (const s of stamps) {
    const p = s.progress.prompt
    const g = s.progress.generated
    const what = p
      ? `prefill  ${p.processed}/${p.total} cache=${p.cache}`
      : `generate ${g?.tokens} tok  ${g?.perSecond?.toFixed(1) ?? '?'} tok/s`
    console.log(`${String(s.at).padStart(6)} ms  ${what}`)
  }

  const prefill = stamps.filter((s) => s.progress.prompt !== undefined)
  const gen = stamps.filter((s) => s.progress.generated !== undefined)
  const gaps = (xs: typeof stamps): string => xs.length < 2
    ? 'n/a'
    : xs.slice(1).map((s, i) => s.at - xs[i]!.at).join(', ')

  console.log('--- summary ------------------------------------------------------------')
  console.log(`prefill updates : ${prefill.length}   gaps(ms): ${gaps(prefill)}`)
  console.log(`generation upd. : ${gen.length}   gaps(ms): ${gaps(gen)}`)
  console.log(`first token at  : ${firstTokenAt ?? '?'} ms`)
  console.log(`wall            : ${result.wallSeconds.toFixed(2)} s`)
  console.log(`server timings  : ${JSON.stringify(result.timings)}`)
  console.log(`usage           : ${JSON.stringify(result.usage)}`)
  console.log(`answer          : ${JSON.stringify(result.message.content)}`)

  if (prefill.length === 0) {
    console.log('\n!! no prompt_progress frames arrived — return_progress is not doing anything here')
  }
  if (gen.length === 0) {
    console.log('\n!! no per-token timings arrived — timings_per_token is not doing anything here')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
