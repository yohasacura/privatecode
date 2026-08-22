/**
 * The model card's example code sets `presence_penalty: 1.5`. This client sends none.
 *
 * Worth asking, because this project has been here before: DRY was switched on for one day
 * on the reasoning that a coding agent needs sequence-level repetition control, and measured
 * out again because it corrupted the one thing that must be exact — identifiers. `.cs` became
 * `.css`, `ProcessCleaner` became `ProcessCleanser`, `FileLogger` became `FilerLogger`
 * (see `llama/sampling.ts`). A presence penalty pushes on the same lever, so it gets the same
 * test rather than the benefit of the doubt: does it corrupt names that must be reproduced
 * verbatim, and does it stop a real repetition loop?
 *
 *   npx tsx spike/presence-penalty-probe.mts
 */
const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const RUNS = 3
const ARMS = [0, 1.5]

/** Names a coding agent has to echo back byte-for-byte, of the shape that broke under DRY. */
const NAMES = [
  'src/Services/ProcessCleaner.cs',
  'src/Logging/FileLogger.cs',
  'src/Billing/InvoiceService.cs',
  'tests/Billing/InvoiceServiceTests.cs',
  'src/Infrastructure/SqlConnectionFactory.cs',
]

const LIST_TASK =
  'Here are five file paths:\n\n' + NAMES.map((n) => `  ${n}`).join('\n') +
  '\n\nList all five paths back to me exactly as written, three times over: first as a ' +
  'plain list, then as a numbered list, then as a comma-separated line. Copy them ' +
  'character for character. Do not abbreviate and do not comment.'

const LOOP_TASK =
  'Write the sentence "The build is green." exactly forty times, one per line, and nothing else.'

async function ask(prompt: string, presence: number, maxTokens: number): Promise<string> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'kat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      stream: false,
      temperature: 0.6, top_p: 0.95, top_k: 20,
      presence_penalty: presence,
      chat_template_kwargs: { enable_thinking: false },
    }),
  })
  const j = await res.json() as { choices?: { message?: { content?: string | null } }[] }
  return j.choices?.[0]?.message?.content ?? ''
}

console.log(`server ${BASE}  |  ${RUNS} runs per arm\n`)
console.log('--- 1. can it still reproduce identifiers verbatim? (5 names x 3 listings = 15) ---')
for (const presence of ARMS) {
  let total = 0
  let worst = ''
  for (let i = 0; i < RUNS; i++) {
    const out = await ask(LIST_TASK, presence, 900)
    let hits = 0
    for (const n of NAMES) {
      const occurrences = out.split(n).length - 1
      hits += Math.min(occurrences, 3)
    }
    total += hits
    if (hits < 15 && worst === '') {
      // Show what it turned them into, which is the failure DRY produced.
      const mangled = NAMES.filter((n) => !out.includes(n))
      worst = mangled.length > 0 ? `missing/mangled: ${mangled.join(', ')}` : 'fewer than 3 listings'
    }
  }
  console.log(`  presence_penalty ${String(presence).padEnd(4)} ${total}/${15 * RUNS} verbatim` +
    (worst ? `   (${worst.slice(0, 110)})` : '   clean'))
}

console.log('\n--- 2. does it actually stop a degenerate repetition? (asked for 40 identical lines) ---')
for (const presence of ARMS) {
  const out = await ask(LOOP_TASK, presence, 900)
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  const exact = lines.filter((l) => l === 'The build is green.').length
  const variants = new Set(lines.filter((l) => l !== 'The build is green.')).size
  console.log(`  presence_penalty ${String(presence).padEnd(4)} ${exact} exact repetitions, ` +
    `${variants} other distinct lines`)
}
