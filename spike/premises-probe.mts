/**
 * Does the model actually COPY the lines, or does it retype them from memory?
 *
 * The whole premise check rests on that one behaviour. If it quotes verbatim, an unverifiable
 * premise is a real false belief and the check is a hard oracle. If it paraphrases, every
 * premise fails, the check cries wolf on healthy turns, and it has to be thrown away. There
 * is no way to find out except by asking the real model.
 *
 *   npx tsx spike/premises-probe.mts
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlamaClient } from '../core/src/llama/client.js'
import type { ChatMessage } from '../core/src/llama/types.js'
import { statePremises, verifyPremises } from '../core/src/session/premises.js'
import { Workspace } from '../core/src/workspace.js'

const client = new LlamaClient({
  baseUrl: process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080',
  model: 'qwen',
})

const INVOICE_TS = `import { db } from "./db"

export class InvoiceService {
  /** Formats a raw counter value for display. Does NOT validate. */
  format(n: number): string {
    return \`INV-\${String(n).padStart(6, "0")}\`
  }

  async allocate(year: number): Promise<number> {
    const row = await db.query("select last from counters where year = $1", [year])
    const next = (row?.last ?? 0) + 1
    await db.query("update counters set last = $1 where year = $2", [next, year])
    return next
  }
}
`

/**
 * The other direction, and the one the feature exists for: a transcript where the model has
 * already talked itself into something the file does not say. `format` neither validates nor
 * throws, and there is no `InvoiceValidator` anywhere. If the check works, the premises built
 * on that belief cannot be quoted and do not survive.
 */
function poisonedTranscript(): ChatMessage[] {
  return [
    ...transcriptFor(''),
    {
      role: 'assistant',
      content:
        'Right — and since InvoiceService.format() already validates its argument and throws ' +
        'on a negative counter, and InvoiceValidator.ensureSequential() is called on the way ' +
        'in, I only have to make the allocation atomic and the rest of the guarantees hold.',
    },
  ]
}

function transcriptFor(root: string): ChatMessage[] {
  return [
    { role: 'system', content: 'You are a coding agent working in a TypeScript repository.' },
    { role: 'user', content: 'Invoice numbers sometimes skip values under load. Fix it.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'c1',
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/invoice.ts' }) },
      }],
    },
    { role: 'tool', tool_call_id: 'c1', content: INVOICE_TS },
    {
      role: 'assistant',
      content:
        'The allocation reads the counter and writes it back in two separate queries with no ' +
        'transaction, so two concurrent callers can read the same value. I will wrap it in a ' +
        'transaction and take a row lock.',
    },
  ]
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pc-premise-probe-'))
  try {
    const dir = join(root, 'src')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'invoice.ts'), INVOICE_TS, 'utf8')
    const ws = new Workspace(root)

    for (let round = 1; round <= 4; round++) {
      const poisoned = round === 4
      const started = Date.now()
      if (poisoned) console.log('\n### round 4 uses a transcript with two invented facts in it')
      const premises = await statePremises(client, poisoned ? poisonedTranscript() : transcriptFor(root))
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      if (premises === null) {
        console.log(`round ${round}: no premises (${secs}s)`)
        continue
      }
      const check = verifyPremises(premises, ws)
      console.log(`\n=== round ${round} — ${premises.length} premises, ${check.verified.length} verified (${secs}s)`)
      for (const p of check.verified) {
        console.log(`  OK   ${p.file}  «${p.quote.replace(/\s+/g, ' ').slice(0, 70)}»`)
      }
      for (const u of check.unverified) {
        console.log(`  MISS ${u.premise.file}  «${u.premise.quote.replace(/\s+/g, ' ').slice(0, 70)}»`)
        console.log(`       ${u.problem}`)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
