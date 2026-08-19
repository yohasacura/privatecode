/**
 * The three lenses against the real model, on requests that are genuinely ambiguous.
 *
 * What is being tuned here is not code — the comparison is mechanical and unit-tested — but
 * the three prompts. The question that reaches a person is assembled out of the model's own
 * lines, so the lenses decide entirely whether that question is worth asking: too alike and
 * nothing is ever contested, too wild and the skeptic invents work nobody wants.
 *
 *   npx tsx spike/lenses-probe.mts
 */
import { LlamaClient } from '../core/src/llama/client.js'
import type { ChatMessage } from '../core/src/llama/types.js'
import { buildQuestion, readThroughLenses } from '../core/src/session/understanding.js'

const client = new LlamaClient({
  baseUrl: process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080',
  model: 'qwen',
})

/** Roughly what the transcript looks like when the check really fires: the model has read
 * around for a few steps and is about to write. */
function explored(): ChatMessage[] {
  return [
    { role: 'system', content: 'You are a coding agent working in a C# repository.' },
    { role: 'user', content: 'have a look at how invoice numbers are produced' },
    {
      role: 'assistant',
      content:
        'I read src/Billing/InvoiceService.cs and src/Billing/ActNumberGenerator.cs.\n' +
        'InvoiceService.Format(int n) pads to 6 digits and prefixes "INV-".\n' +
        'ActNumberGenerator.Next() takes a row lock on Counters, increments per year, and\n' +
        'returns a bare int. Both are called from BillingController; the controller also\n' +
        'formats numbers inline in two places with string.Format("INV-{0:D6}", n).',
    },
  ]
}

const CASES: { name: string; request: string }[] = [
  {
    name: 'ambiguous scope (en)',
    request: 'make invoice numbers gap-free',
  },
  {
    name: 'ambiguous scope (ru)',
    request: 'сделай чтобы номера счетов не имели пропусков',
  },
  {
    name: 'genuinely clear',
    request: 'rename InvoiceService.Format to InvoiceService.FormatNumber and update every call site',
  },
]

async function main(): Promise<void> {
  for (const c of CASES) {
    const started = Date.now()
    console.log(`\n=== ${c.name} =======================================================`)
    console.log(`request: ${c.request}`)
    const u = await readThroughLenses(client, explored(), c.request)
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    if (u === null) {
      console.log(`(no comparison possible)  ${secs}s`)
      continue
    }
    console.log(`\nshared (${u.shared.length}):`)
    for (const s of u.shared) console.log(`  = ${s}`)
    console.log(`contested (${u.contested.length}):`)
    for (const s of u.contested) console.log(`  ? ${s}`)
    const q = buildQuestion(u)
    console.log('\n--- what the person is shown ---')
    console.log(q === null ? '(nothing — the readings agreed)' : `${q.question}\n${q.options.map((o) => `  [ ] ${o}`).join('\n')}`)
    console.log(`\n(${secs}s for three readings)`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
