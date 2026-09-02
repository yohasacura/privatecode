/**
 * The doctor in front of the real model.
 *
 * Everything up to now has been checked with `diagnose()` called directly, which proves the
 * analysis and nothing about the part that has to work on somebody else's laptop: that the
 * model READS the tool description, decides this is the tool, calls it, and hands back
 * something a person can act on. Those are four separate ways to fail and none of them is
 * visible from a unit test.
 *
 * The workspace is fabricated but not sanitised — it carries the shapes that must never
 * travel (a client's name in a path, in a build log, in an MCP server name, in the session
 * title) so a leak has somewhere to come from. What is asserted afterwards is the FILE, not
 * the model's prose: the design says the artifact travels rather than the retelling, and
 * this is where that claim is either true or is not.
 *
 *   npx tsx test/integration/zz-doctor.probe.mts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../../src/agent/loop.js'
import { LlamaClient } from '../../src/llama/client.js'
import { Workspace } from '../../src/workspace.js'
import { buildRegistry } from '../../src/tools/default-set.js'
import { ACCEPTANCE_FIXER_PREFIX, REVIEW_FIXER_PREFIX } from '../../src/session/contract.js'
import { MIDTURN_VERIFY_PREFIX, VERIFY_FAILED_PREFIX } from '../../src/verify/runner.js'
import {
  COMPACTION_ACK_TEXT, COMPACTION_BRIEFING_PREFIX,
} from '../../src/session/compaction.js'

const SERVER = process.env.PRIVATECODE_SERVER ?? 'http://127.0.0.1:8080'

const root = mkdtempSync(join(tmpdir(), 'pc-doctor-live-'))
const sessions = join(root, '.privatecode', 'state', 'sessions')
mkdirSync(sessions, { recursive: true })

// ---------------------------------------------------------------------------------------
// A history with things wrong in it, and private material in every field that touches disk.
// ---------------------------------------------------------------------------------------
const lines: unknown[] = [{ role: 'system', content: 'You are PrivateCode.' }]
const outcomes: { id: string; ok: boolean }[] = []
let n = 0
const call = (name: string, args: unknown): string => {
  const id = `c${n++}`
  lines.push({
    role: 'assistant',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  })
  return id
}
const result = (id: string, ok: boolean, content: string): void => {
  lines.push({ role: 'tool', tool_call_id: id, content })
  outcomes.push({ id, ok })
}
const said = (text: string): void => { lines.push({ role: 'assistant', content: text }) }
const turn = (text: string): void => { lines.push({ role: 'user', content: text }) }

turn('wire the ZebraCorp ledger import into the AcmeBank posting engine')

// A path guessed one folder too deep, dropped on the retry — the multi-folder mistake.
for (const file of ['PostingEngine.cs', 'LedgerImport.cs']) {
  result(call('Read', { path: `src/AcmeBank/Ledger/${file}` }), false,
    `File not found: src/AcmeBank/Ledger/${file}`)
  result(call('Read', { path: `AcmeBank/Ledger/${file}` }), true, '1\tnamespace AcmeBank.Ledger;')
}
// `&&` in a shell that has no such operator.
result(call('Bash', { commands: ['cd D:/clients/zebracorp/api && dotnet build'] }), false,
  "The token '&&' is not a valid statement separator in this version.")
result(call('Bash', { commands: ['cd D:/clients/zebracorp/api; dotnet build'] }), true,
  'Build succeeded.')
// An MCP tool named after the client's production server.
result(call('mcp__acmebank_prod__query_ledger', { query: 'select top 1 * from Postings' }), true, '1 row')

// The build breaks mid-turn, twice, and the model argues with it once.
lines.push({ role: 'user',
  content: `[${MIDTURN_VERIFY_PREFIX}${VERIFY_FAILED_PREFIX} \`dotnet build\` exited 1 after ` +
    'your changes:\n\nsrc/AcmeBank/Ledger/PostingEngine.cs(42): error CS1002: ; expected\n]' })
said('That error is in ZebraCorp code that was already broken before my change.')
lines.push({ role: 'user',
  content: `[${MIDTURN_VERIFY_PREFIX}${VERIFY_FAILED_PREFIX} \`dotnet build\` exited 1 after ` +
    'your changes:\n\nsrc/AcmeBank/Ledger/PostingEngine.cs(42): error CS1002: ; expected\n]' })
result(call('Edit', { path: 'AcmeBank/Ledger/PostingEngine.cs', old: 'x', new: 'y' }), true, 'edited')

// A second and third request, so the harness/person ratio has a sample worth printing.
turn('now make the cutover date configurable')
result(call('Read', { path: 'AcmeBank/Ledger/PostingEngine.cs' }), true, '1	namespace AcmeBank.Ledger;')

// The window fills mid-request and the earlier history is swapped out.
//
// Written the way a real swap writes it, which is the whole point of doing it here: a
// marker line, then the ENTIRE new transcript — a fresh system message, the briefing, the
// acknowledgement, and then the RETAINED TAIL, which is already above the marker. Those
// duplicated messages were counted twice, and worse: two copies of one hand-back landed in
// one person-turn and the report asserted a run that never happened.
turn('and log the ZebraCorp account ids as hashes')
const beforeMarker = lines.length          // messages so far, including the system one
const tailStart = beforeMarker - 4         // the last four are the retained tail
lines.push({
  __event: 'compaction',
  summary: 'earlier history',
  droppedMessages: tailStart - 1,          // `start - floor`, floor being the system message
  at: '2026-08-21T09:00:00.000Z',
})
lines.push({ role: 'system', content: 'You are PrivateCode.' })
lines.push({ role: 'user',
  content: `${COMPACTION_BRIEFING_PREFIX}

The user is wiring the ZebraCorp ledger import ` +
    'into AcmeBank posting, and asked for hashed account ids.' })
said(COMPACTION_ACK_TEXT)
for (const m of lines.slice(tailStart, beforeMarker)) lines.push(m)

// Then the post-turn chain: the contract is not met, then the reviewer finds something.
lines.push({ role: 'user', content: `${ACCEPTANCE_FIXER_PREFIX}\n- the merger cutover date is not handled` })
result(call('Edit', { path: 'AcmeBank/Ledger/PostingEngine.cs', old: 'a', new: 'b' }), true, 'edited')
lines.push({ role: 'user', content: `${REVIEW_FIXER_PREFIX}\n- ZebraCorp account ids are logged in clear` })
result(call('Edit', { path: 'AcmeBank/Ledger/PostingEngine.cs', old: 'b', new: 'c' }), true, 'edited')

const id = 's-20260820-090000-aaaa'
writeFileSync(join(sessions, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
writeFileSync(join(sessions, `${id}.ui.jsonl`), outcomes.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
writeFileSync(join(sessions, `${id}.meta.json`), JSON.stringify({
  id,
  // The title is the person's own first message. `diagnose` must never read it.
  title: 'wire the ZebraCorp ledger import into the AcmeBank posting engine',
  createdAt: '2026-08-20T09:00:00.000Z',
  updatedAt: '2026-08-22T09:00:00.000Z',
  workspaceRoot: root,
  mode: 'normal',
  appVersion: '0.1.5',
}, null, 2), 'utf8')

// ---------------------------------------------------------------------------------------
// The live turn. No mention of the tool's NAME: whether the description routes the model to
// it is half of what is being measured.
// ---------------------------------------------------------------------------------------
const calledTools: string[] = []
const agent = new Agent({
  client: new LlamaClient({ baseUrl: SERVER, model: 'Qwen3.6-35B-A3B' }),
  registry: buildRegistry(),
  context: { workspace: new Workspace(root) },
  mode: 'normal',
  // The window's own barrier is 200 (`host.ts` MAX_STEPS_PER_TURN); the CLI used 40. A
  // small number here would measure the probe rather than the agent.
  maxSteps: 40,
  events: {
    onToolCall: (name: string) => {
      calledTools.push(name)
      console.log(`  → ${name}`)
    },
    onStepDone: (info: { step: number }) => { console.log(`  · step ${info.step} done`) },
  } as never,
})

const started = Date.now()
const outcome = await agent.runTurn(
  'Something is going wrong in this project and I cannot send you my logs. ' +
  'Work out what this agent has been getting wrong from its own history, and give me ' +
  'something I can send to whoever maintains it.',
)
const wall = ((Date.now() - started) / 1000).toFixed(1)

console.log(`\n=== turn: ${outcome.stoppedBecause}, ${outcome.steps} steps, ${wall}s`)
const tally = new Map()
for (const t of calledTools) tally.set(t, (tally.get(t) ?? 0) + 1)
console.log(`=== tools called: ${[...tally].map(([t, c]) => `${t} x${c}`).join(', ') || '(none)'}`)
console.log(`\n=== what the model said ===\n${outcome.finalText}`)

// ---------------------------------------------------------------------------------------
// What is checked, and on WHAT. The file is the deliverable; the prose is observed.
// ---------------------------------------------------------------------------------------
const SECRETS = ['ZebraCorp', 'zebracorp', 'AcmeBank', 'acmebank', 'PostingEngine',
  'LedgerImport', 'merger', 'clients', 'CS1002', 'query_ledger', 'acmebank_prod',
  'cutover', 'Postings']

let report: string | null = null
try {
  report = readFileSync(join(root, '.privatecode', 'diagnosis.md'), 'utf8')
} catch { /* reported below */ }

console.log('\n=== .privatecode/diagnosis.md ===')
if (report === null) {
  console.log('!! NOT WRITTEN')
} else {
  console.log(report)
  const leaked = SECRETS.filter((s) => report.includes(s))
  console.log(`\n=== leaks in the FILE: ${leaked.length === 0 ? 'none' : leaked.join(', ')}`)
}
const spoken = SECRETS.filter((s) => outcome.finalText.includes(s))
console.log(`=== private words in the model's own prose: ${spoken.length === 0 ? 'none' : spoken.join(', ')}`)

rmSync(root, { recursive: true, force: true })
