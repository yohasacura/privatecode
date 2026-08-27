/**
 * Does a NARROW agent get right what the general one gets wrong?
 *
 * That is the whole justification for sub-agents, and it is a claim about this model rather
 * than about architecture, so it is measurable. The case is the one this project already has
 * on record (docs/SPIKE-KAT-CODER.md §9, reproduced by `spike/reviewer-probe.mts`): a defect
 * that is invisible in the diff, in a file the diff never touches. The general reviewer FOUND
 * it, NAMED it, and deliberately did not report it —
 *
 *   "One thing I noticed but am not reporting: src/credit-note.ts has the identical
 *    read-then-update pattern without a transaction... The ask was specifically about invoice
 *    numbers, so this is out of scope."
 *
 * — against three paragraphs of prompt forbidding exactly that. It is the project's own law
 * demonstrating itself: instructions do not route behaviour, structure does.
 *
 * Two arms, same planted defect, same model, same files:
 *
 *   WIDE    the reviewer as it ships: the whole REVIEW_SYSTEM brief, the contract, the diff,
 *           the user's original words, the full tool registry, and a free-form verdict
 *   NARROW  one question, no contract, no diff, no scope, no history. Two files and
 *           "is the counter ever read without a lock". A forced yes/no with a location.
 *
 * If NARROW answers where WIDE declines, the case for sub-agents is measured rather than
 * assumed — and the reason is legible: the thing WIDE gets wrong is not the analysis, it is
 * the SCOPE judgement, and a narrow agent has no scope to judge.
 *
 *   npx tsx spike/narrow-agent-probe.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../core/src/agent/loop.js'
import { LlamaClient } from '../core/src/llama/client.js'
import { buildRegistry } from '../core/src/tools/default-set.js'
import { Transcript } from '../core/src/transcript/transcript.js'
import { buildReviewBrief, reviewVerdict, REVIEW_SYSTEM } from '../core/src/session/contract.js'
import { forcedJson } from '../core/src/session/forced-json.js'
import { Workspace } from '../core/src/workspace.js'

const client = new LlamaClient({
  baseUrl: process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080',
  model: 'qwen',
})
const TRIALS = Number(process.env['TRIALS'] ?? 3)

const INVOICE_AFTER = `import { db } from "./db"

export class InvoiceService {
  async allocate(year: number): Promise<number> {
    return await db.transaction(async (tx) => {
      const row = await tx.query("select last from counters where year = $1 for update", [year])
      const next = (row?.last ?? 0) + 1
      await tx.query("update counters set last = $1 where year = $2", [next, year])
      return next
    })
  }
}
`

const CREDIT_NOTE = `import { db } from "./db"

export class CreditNoteService {
  async allocate(year: number): Promise<number> {
    const row = await db.query("select last from counters where year = $1", [year])
    const next = (row?.last ?? 0) + 1
    await db.query("update counters set last = $1 where year = $2", [next, year])
    return next
  }
}
`

const DIFF = `--- a/src/invoice.ts
+++ b/src/invoice.ts
@@
-    const row = await db.query("select last from counters where year = $1", [year])
-    const next = (row?.last ?? 0) + 1
-    await db.query("update counters set last = $1 where year = $2", [next, year])
+    return await db.transaction(async (tx) => {
+      const row = await tx.query("select last from counters where year = $1 for update", [year])
+      const next = (row?.last ?? 0) + 1
+      await tx.query("update counters set last = $1 where year = $2", [next, year])
+    })
`

const CONTRACT = {
  goal: 'Invoice numbers stop skipping values under concurrent load',
  criteria: ['the counter is read and written inside one transaction with a row lock'],
  constraints: [],
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-narrow-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'invoice.ts'), INVOICE_AFTER, 'utf8')
  writeFileSync(join(root, 'src', 'credit-note.ts'), CREDIT_NOTE, 'utf8')
  return root
}

/** The reviewer as it ships. */
async function wide(): Promise<{ found: boolean; note: string }> {
  const root = makeWorkspace()
  try {
    const transcript = new Transcript()
    const reader = new Agent({
      client,
      registry: buildRegistry(),
      context: { workspace: new Workspace(root) },
      transcript,
      mode: 'plan',
      maxSteps: 6,
    })
    await reader.runTurn(
      `${REVIEW_SYSTEM}\n\n${buildReviewBrief(CONTRACT, DIFF, 'invoice numbers keep skipping under load, sort it out')}`,
    )
    const issues = await reviewVerdict(client, transcript.messages())
    const text = (issues ?? []).map((i) => `${i.where} ${i.what}`).join(' | ')
    return { found: /credit-note/i.test(text), note: text || '(no defects reported)' }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const NARROW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['where', 'unlocked'],
  additionalProperties: false,
  properties: {
    // `where` BEFORE the verdict, the same lever the acceptance gate uses: a
    // `response_format` grammar emits properties in schema order, so the location has to be
    // written before the yes/no it justifies.
    where: { type: 'string' },
    unlocked: { type: 'boolean' },
  },
}

/**
 * One question, and nothing else in the prompt: no contract, no diff, no scope, no history,
 * no mention of what anybody asked for. There is no scope judgement available to make.
 */
async function narrow(): Promise<{ found: boolean; note: string }> {
  const answer = await forcedJson(client, {
    messages: [
      {
        role: 'user',
        content:
          'Two files read and write the same counter.\n\n' +
          `--- src/invoice.ts\n${INVOICE_AFTER}\n` +
          `--- src/credit-note.ts\n${CREDIT_NOTE}\n` +
          'Is there any place that reads the counter and writes it back WITHOUT a ' +
          'transaction and a row lock? Answer where, then yes or no.',
      },
    ],
    schema: NARROW_SCHEMA,
    name: 'unlocked_read',
    maxTokens: 300,
  })
  const parsed = answer as { where?: string; unlocked?: boolean } | null
  const note = `${parsed?.where ?? '(no answer)'} → unlocked=${String(parsed?.unlocked)}`
  return { found: parsed?.unlocked === true && /credit-note/i.test(parsed?.where ?? ''), note }
}

for (const [label, run] of [['WIDE  ', wide], ['NARROW', narrow]] as const) {
  let found = 0
  console.log(`\n${label}`)
  for (let i = 0; i < TRIALS; i++) {
    const started = Date.now()
    try {
      const r = await run()
      if (r.found) found++
      console.log(`  ${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${r.found ? 'FOUND ' : 'missed'}  ${r.note.slice(0, 96)}`)
    } catch (e) {
      console.log(`  threw: ${(e as Error).message.slice(0, 90)}`)
    }
  }
  console.log(`  ${found}/${TRIALS} reported the defect in the file the diff never touched`)
}
