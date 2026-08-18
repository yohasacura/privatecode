// Context-rot probe: OUR degradation curve on the live server, not the literature's.
//
// NoLiMa-shaped: a fact with no lexical overlap with the question is buried at a DEPTH
// inside realistic filler (code-flavoured prose with similar distractors), and the model
// answers the question at the end. Accuracy per depth is the curve; the knee is where the
// compaction trigger belongs (the shipped 80% trigger fires near 210k — every published
// measurement puts the knee far earlier, but ours is the one that matters).
//
// Usage:
//   node spike/context-rot-probe.mjs             # short smoke: depths 4k,16k,32k × 3 probes
//   node spike/context-rot-probe.mjs --full      # overnight: 4k..96k × 12 probes per depth
//
// Writes spike/context-rot-results.jsonl (one line per probe) so a stopped run keeps
// everything it measured. Single slot: strictly sequential, cache_prompt off (every probe
// must pay its own prefill — a warm prefix would measure the cache, not the model).
const BASE = 'http://127.0.0.1:8080'
const FULL = process.argv.includes('--full')
const DEPTHS = FULL ? [4_000, 16_000, 32_000, 48_000, 64_000, 96_000] : [4_000, 16_000, 32_000]
const PROBES_PER_DEPTH = FULL ? 12 : 3
const { appendFileSync } = await import('node:fs')
const OUT = new URL('./context-rot-results.jsonl', import.meta.url)

// The needle: an association the question reaches without shared words.
// Question asks for "какой модуль пишет журнал в кольцевой буфер" — the needle states it
// with different phrasing, so retrieval must be semantic, not lexical.
const NEEDLES = [
  { fact: 'Компонент telemetry-sink складывает записи аудита в циклическую память фиксированного размера.', question: 'Какой компонент хранит журнал в кольцевом буфере? Ответь только именем компонента.', answer: 'telemetry-sink' },
  { fact: 'Сервис quota-warden останавливает приём задач, когда суммарный вес очереди превышает лимит арендатора.', question: 'Какой сервис блокирует новые задачи при переполнении бюджета клиента? Только имя.', answer: 'quota-warden' },
  { fact: 'Модуль drift-anchor раз в час сверяет локальные часы воркеров с эталоном и записывает поправку.', question: 'Какой модуль корректирует рассинхронизацию времени у воркеров? Только имя.', answer: 'drift-anchor' },
  { fact: 'Утилита shard-mender переносит осиротевшие сегменты индекса на живые узлы после сбоя.', question: 'Какая утилита чинит индекс после падения узла? Только имя.', answer: 'shard-mender' },
]

// Filler with DISTRACTORS: same vocabulary domain, wrong answers nearby.
const filler = (rand) => {
  const mods = ['cache-layer', 'auth-gate', 'metric-pump', 'log-router', 'queue-broker', 'db-mapper', 'io-scheduler', 'net-prober']
  const verbs = ['валидирует', 'сжимает', 'реплицирует', 'маршрутизирует', 'нормализует', 'агрегирует']
  const m = mods[Math.floor(rand() * mods.length)]
  const v = verbs[Math.floor(rand() * verbs.length)]
  return `Модуль ${m} ${v} входящие записи пакетами по ${Math.floor(rand() * 400) + 8}; при отказе повторяет попытку через ${Math.floor(rand() * 50) + 3} секунд и пишет метрику ${m.replace('-', '_')}_retries.`
}

const mulberry = (seed) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

const buildPrompt = (needle, depthTokens, seed) => {
  const rand = mulberry(seed)
  const targetChars = depthTokens * 4
  const lines = []
  let chars = 0
  while (chars < targetChars) { const l = filler(rand); lines.push(l); chars += l.length }
  // The needle sits at 40-60% depth — the measured worst zone in published curves.
  const at = Math.floor(lines.length * (0.4 + rand() * 0.2))
  lines.splice(at, 0, needle.fact)
  return `Документация системы:\n${lines.join('\n')}\n\nВопрос: ${needle.question}`
}

let done = 0
const total = DEPTHS.length * PROBES_PER_DEPTH
for (const depth of DEPTHS) {
  let hits = 0
  for (let p = 0; p < PROBES_PER_DEPTH; p++) {
    const needle = NEEDLES[p % NEEDLES.length]
    const prompt = buildPrompt(needle, depth, depth * 31 + p)
    const t0 = performance.now()
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'q', messages: [{ role: 'user', content: prompt }],
        max_tokens: 400, temperature: 0, cache_prompt: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
    })
    const j = await r.json()
    // A refused or failed request must never look like a MISS: a depth full of silent
    // error rows reads as a fake accuracy collapse exactly where the knee is measured,
    // and triggerTokens would be calibrated against it. Persist the error and stop.
    if (!r.ok || j.error) {
      const errRow = { depth, probe: p, error: j.error?.message ?? j.error ?? `HTTP ${r.status}` }
      appendFileSync(OUT, `${JSON.stringify(errRow)}\n`)
      console.error(`[${done + 1}/${total}] depth ${depth}: SERVER ERROR — ${errRow.error}`)
      console.error('aborting: completed rows are already persisted, rerun after fixing the server')
      process.exit(2)
    }
    const text = (j.choices?.[0]?.message?.content ?? '').toLowerCase()
    const hit = text.includes(needle.answer)
    hits += hit ? 1 : 0
    done++
    const row = {
      depth, probe: p, needle: needle.answer, hit,
      ms: Math.round(performance.now() - t0),
      promptTokens: j.usage?.prompt_tokens,
      answer: text.slice(0, 120),
    }
    appendFileSync(OUT, `${JSON.stringify(row)}\n`)
    console.log(`[${done}/${total}] depth ${depth}: ${hit ? 'HIT ' : 'MISS'} (${row.ms}ms, ${row.promptTokens} tok) ${hit ? '' : `got: ${row.answer}`}`)
  }
  console.log(`== depth ${depth}: ${hits}/${PROBES_PER_DEPTH}`)
}
console.log(`\nresults appended to ${OUT.pathname}`)
