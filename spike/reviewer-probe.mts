/**
 * The reviewer with its eyes open, against the real model.
 *
 * It used to be one generation over the contract and a diff. It is now a bounded read-only
 * agent turn followed by a forced verdict, which is a lot more machinery in the one place
 * that must never take a turn down with it — so this runs the real thing: does it open the
 * files, does it stay read-only, and does it find a defect that is only visible from OUTSIDE
 * the diff?
 *
 * The planted defect is deliberately invisible in the patch. The diff makes `allocate` take
 * a row lock and looks perfectly correct on its own; what it cannot show is that the OTHER
 * caller of the counter — in a file the diff never touches — still reads it unlocked. Under
 * the old reviewer this was unfindable by construction.
 *
 *   npx tsx spike/reviewer-probe.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../core/src/agent/loop.js'
import { LlamaClient } from '../core/src/llama/client.js'
import { buildRegistry } from '../core/src/tools/default-set.js'
import { Transcript } from '../core/src/transcript/transcript.js'
import { buildReviewBrief, reviewVerdict, REVIEW_SYSTEM } from '../core/src/session/contract.js'
import { Workspace } from '../core/src/workspace.js'

const client = new LlamaClient({
  baseUrl: process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080',
  model: 'qwen',
})

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

/** The file the diff never touches, and where the bug now lives. */
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
-  async allocate(year: number): Promise<number> {
-    const row = await db.query("select last from counters where year = $1", [year])
-    const next = (row?.last ?? 0) + 1
-    await db.query("update counters set last = $1 where year = $2", [next, year])
-    return next
-  }
+  async allocate(year: number): Promise<number> {
+    return await db.transaction(async (tx) => {
+      const row = await tx.query("select last from counters where year = $1 for update", [year])
+      const next = (row?.last ?? 0) + 1
+      await tx.query("update counters set last = $1 where year = $2", [next, year])
+      return next
+    })
+  }
`

const CONTRACT = {
  goal: 'Invoice numbers stop skipping values under concurrent load',
  criteria: ['the counter is read and written inside one transaction with a row lock'],
  constraints: [],
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pc-reviewer-probe-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'invoice.ts'), INVOICE_AFTER, 'utf8')
    writeFileSync(join(root, 'src', 'credit-note.ts'), CREDIT_NOTE, 'utf8')

    const workspace = new Workspace(root)
    const registry = buildRegistry()
    const transcript = new Transcript()
    const started = Date.now()
    const calls: string[] = []

    const reader = new Agent({
      client,
      registry,
      context: { workspace },
      transcript,
      mode: 'plan',
      maxSteps: 6,
      events: { onToolCall: (name, args) => calls.push(`${name} ${args.slice(0, 90)}`) },
    })
    const brief = `${REVIEW_SYSTEM}\n\n${buildReviewBrief(CONTRACT, DIFF, 'invoice numbers keep skipping under load, sort it out')}`
    const turn = await reader.runTurn(brief)

    console.log(`--- what it opened (${turn.steps} steps, ${((Date.now() - started) / 1000).toFixed(1)}s)`)
    for (const c of calls) console.log(`  ${c}`)
    const writes = calls.filter((c) => /^(edit_file|write_file|delete_file|move_file|run_command)/.test(c))
    console.log(`  write-family calls: ${writes.length} ${writes.length === 0 ? '(good — plan mode held)' : '!!! ' + writes.join(', ')}`)

    console.log(`\n--- what the reader concluded before the verdict\n${(turn.finalText || '(nothing)').slice(0, 1200)}`)

    const issues = await reviewVerdict(client, transcript.messages())
    console.log(`\n--- verdict (${((Date.now() - started) / 1000).toFixed(1)}s total)`)
    if (issues === null) console.log('  (no verdict produced)')
    else if (issues.length === 0) console.log('  no defects reported')
    else for (const i of issues) console.log(`  ${i.where}\n    ${i.what}`)

    const foundIt = (issues ?? []).some((i) => /credit/i.test(`${i.where} ${i.what}`))
    console.log(`\nplanted defect (unlocked counter in the file the diff never touches): ${foundIt ? 'FOUND' : 'missed'}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
