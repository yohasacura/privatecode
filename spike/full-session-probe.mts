/**
 * One real task, one real Session, one real model — and a report on every mechanism that
 * was supposed to fire along the way.
 *
 * Everything built recently has been probed in isolation: the lenses against a synthetic
 * transcript, the premises against a synthetic transcript, the reviewer against a synthetic
 * diff. None of it had ever run inside an actual turn, in order, against a real workspace
 * with a real verify command. That is where the seams are.
 *
 * The workspace carries a planted, genuinely subtle bug: `allocate` reads a counter and
 * writes it back in two statements with no transaction, and a SECOND service does the same
 * against the same table. Fixing only the first leaves the goal unmet — which is exactly the
 * case the reviewer-with-eyes exists for.
 *
 *   npx tsx spike/full-session-probe.mts [--keep]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlamaClient } from '../core/src/llama/client.js'
import { Session, type SessionOptions } from '../core/src/session/session.js'
import { createToolset } from '../core/src/tools/default-set.js'
import type { UserQuestion, ApprovalRequest } from '../core/src/interaction.js'

const KEEP = process.argv.includes('--keep')

const INVOICE = `import { db } from "./db"

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

/** The same race, in a file the obvious fix never touches. */
const CREDIT = `import { db } from "./db"

export class CreditNoteService {
  async allocate(year: number): Promise<number> {
    const row = await db.query("select last from counters where year = $1", [year])
    const next = (row?.last ?? 0) + 1
    await db.query("update counters set last = $1 where year = $2", [next, year])
    return next
  }
}
`

const DB = `export const db = {
  async query(_sql: string, _args: unknown[]): Promise<any> { return { last: 0 } },
  async transaction<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> { return await fn(db) },
}
`

interface Seen {
  questions: { q: UserQuestion; answered: string }[]
  approvals: string[]
  toolCalls: { name: string; args: string }[]
  verifies: { command: string; ok: boolean; attempt: number }[]
  acceptance: { met: number; unmet: number; round: number; kind: string }[]
  planSnapshots: string[]
  steps: number
}

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-live-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'invoice.ts'), INVOICE, 'utf8')
  writeFileSync(join(dir, 'src', 'credit-note.ts'), CREDIT, 'utf8')
  writeFileSync(join(dir, 'src', 'db.ts'), DB, 'utf8')
  mkdirSync(join(dir, '.privatecode'), { recursive: true })
  // A verify command that actually runs on this machine and is fast: the point is that the
  // gate fires and the model sees its output, not that TypeScript is exercised.
  writeFileSync(
    join(dir, '.privatecode', 'settings.json'),
    JSON.stringify({ verify: { command: 'node -e "process.exit(0)"', timeoutMs: 20000 } }, null, 2),
    'utf8',
  )
  return dir
}

async function main(): Promise<void> {
  const root = makeWorkspace()
  const seen: Seen = {
    questions: [], approvals: [], toolCalls: [], verifies: [], acceptance: [],
    planSnapshots: [], steps: 0,
  }

  const toolset = createToolset({ workspaceRoot: root })
  const opts: SessionOptions = {
    client: new LlamaClient({ baseUrl: process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080', model: 'qwen' }),
    toolset,
    workspaceRoot: root,
    compaction: { contextLength: 262_144, triggerTokens: 140_000 },
    verify: { command: 'node -e "process.exit(0)"', timeoutMs: 20_000, source: 'probe' },
    onVerify: (i) => { seen.verifies.push({ command: i.command, ok: i.ok, attempt: i.attempt }) },
    onAcceptance: (i) => { seen.acceptance.push({ ...i }) },
    interaction: {
      // Everything allowed: this probe is about the mechanisms, not the gate.
      async requestApproval(req: ApprovalRequest) {
        seen.approvals.push(`${req.tool}`)
        return { verdict: 'allow' as const }
      },
      async askUser(q: UserQuestion) {
        // Answer the way a person plausibly would: take the first option offered.
        const answered = q.options[0] ?? 'yes'
        seen.questions.push({ q, answered })
        return answered
      },
      todosChanged(todos) {
        const line = todos.map((t, i) => `${i + 1}${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : '.'}`).join(' ')
        if (seen.planSnapshots[seen.planSnapshots.length - 1] !== line) seen.planSnapshots.push(line)
      },
    },
    events: {
      onToolCall: (name, args) => { seen.toolCalls.push({ name, args: args.slice(0, 120) }) },
      onStepDone: () => { seen.steps++ },
    },
  }

  const session = new Session(opts)
  const started = Date.now()
  const task =
    'Invoice numbers sometimes skip values when several requests come in at once. ' +
    'Please find out why and fix it properly, so the numbering really is gap-free. ' +
    'Have a look at the code in src/ first, then make the change.'

  console.log('=== sending the task, this takes a few minutes ===\n')
  const result = await session.send(task)
  const mins = ((Date.now() - started) / 60_000).toFixed(1)

  const report: string[] = []
  const say = (s: string): void => { report.push(s); console.log(s) }

  say(`\n=== ran ${result.steps} steps in ${mins} min, stopped: ${result.stoppedBecause}`)

  say(`\n--- tools called (${seen.toolCalls.length})`)
  const byName = new Map<string, number>()
  for (const c of seen.toolCalls) byName.set(c.name, (byName.get(c.name) ?? 0) + 1)
  say('   ' + [...byName].map(([n, c]) => `${n} x${c}`).join(', '))

  say(`\n--- the plan, as it moved (${seen.planSnapshots.length} states)`)
  for (const p of seen.planSnapshots) say(`   ${p}`)
  const todoCalls = seen.toolCalls.filter((c) => c.name === 'todo_write')
  say(`   todo_write called ${todoCalls.length}x; cheap-form: ${todoCalls.filter((c) => !c.args.includes('"todos"')).length}`)

  say(`\n--- questions put to the user (${seen.questions.length})`)
  for (const q of seen.questions) {
    say(`   Q: ${q.q.question.replace(/\n/g, ' | ').slice(0, 220)}`)
    say(`      options: ${q.q.options.join(' / ').slice(0, 200)}`)
    say(`      answered: ${q.answered.slice(0, 80)}`)
  }

  say(`\n--- verify runs (${seen.verifies.length}): ${seen.verifies.map((v) => (v.ok ? 'ok' : 'FAIL')).join(', ')}`)
  say(`--- acceptance events: ${JSON.stringify(seen.acceptance)}`)

  // What the gates actually SAID, not just how many things they counted. Every one of them
  // reaches the model as a user-role message, so the transcript is the record.
  const notes = (session as any).transcript.messages()
    .filter((m: any) => m.role === 'user' && typeof m.content === 'string')
    .map((m: any) => m.content as string)
  const shown = (needle: string, label: string): void => {
    const hit = notes.filter((n: string) => n.includes(needle))
    if (hit.length > 0) say(`\n--- ${label} (${hit.length})\n   ${hit[0].replace(/\n/g, '\n   ').slice(0, 900)}`)
    else say(`\n--- ${label}: never fired`)
  }
  shown('An independent review', 'the reviewer said')
  shown('The task contract is not fully met', 'the acceptance gate said')
  shown('Plan upkeep', 'plan upkeep note')
  shown('Plan focus', 'plan focus note')

  const contract = (session as any).meta?.contract
  say(`\n--- contract`)
  say(`   goal: ${contract?.goal ?? '(none)'}`)
  say(`   criteria: ${(contract?.criteria ?? []).length}`)
  for (const c of contract?.criteria ?? []) say(`     - ${String(c).slice(0, 150)}`)
  say(`   constraints: ${(contract?.constraints ?? []).length}`)
  for (const c of contract?.constraints ?? []) say(`     - ${String(c).slice(0, 150)}`)
  say(`   premisesChecked=${contract?.premisesChecked} understood=${contract?.understood} satisfied=${contract?.satisfied}`)

  // Compared against the ORIGINAL text, not sniffed with a regex. The first version looked
  // for /transaction|for update/ and reported db.ts as "changed" because the fixture already
  // contained the word `transaction`, and invoice.ts as unchanged when it had in fact been
  // fixed with an atomic INSERT ... ON CONFLICT ... RETURNING. A probe that guesses at the
  // answer reports the guess.
  const ORIGINAL: Record<string, string> = {
    'src/invoice.ts': INVOICE, 'src/credit-note.ts': CREDIT, 'src/db.ts': DB,
  }
  say(`\n--- what actually changed on disk`)
  for (const [f, before] of Object.entries(ORIGINAL)) {
    const p = join(root, f)
    if (!existsSync(p)) { say(`   ${f}: GONE`); continue }
    const text = readFileSync(p, 'utf8')
    say(`   ${f}: ${text === before ? 'UNTOUCHED' : `edited (${before.length} -> ${text.length} ch)`}`)
  }
  // The planted cross-file defect, which is the point of the whole scenario: credit notes
  // draw from the same counter, so leaving them racing means invoice numbers still skip.
  const credit = existsSync(join(root, 'src/credit-note.ts'))
    ? readFileSync(join(root, 'src/credit-note.ts'), 'utf8') : ''
  say(`   PLANTED DEFECT (credit-note shares the counter): ${credit === CREDIT ? 'still there' : 'addressed'}`)
  const extra = (await import('node:fs')).readdirSync(join(root, 'src'))
  say(`   src/ now: ${extra.join(', ')}`)

  // The one thing the whole English rule is about.
  const cyrillic = /[а-яё]/i
  const russianTools = seen.toolCalls.filter((c) => cyrillic.test(c.args))
  const russianQuestions = seen.questions.filter((q) => cyrillic.test(q.q.question + q.q.options.join('')))
  say(`\n--- English check: ${russianTools.length} tool calls and ${russianQuestions.length} questions contain Cyrillic`)
  say(`   final answer has Cyrillic: ${cyrillic.test(result.finalText)}`)

  say(`\n--- final answer (first 600)\n${result.finalText.slice(0, 600)}`)

  const out = join(tmpdir(), `pc-live-report-${Date.now()}.txt`)
  writeFileSync(out, report.join('\n'), 'utf8')
  console.log(`\nreport written to ${out}`)
  console.log(KEEP ? `workspace kept at ${root}` : 'cleaning workspace')
  toolset.background?.stopAll?.()
  if (!KEEP) rmSync(root, { recursive: true, force: true })
}

main().catch((e) => { console.error(e); process.exit(1) })
