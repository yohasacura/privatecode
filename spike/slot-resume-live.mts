/**
 * The slot resume through the real Session, against the live server: a turn saves the state,
 * a resumed Session restores it and warms the tail, and the first step of the resumed
 * session is measured. Needs the server started with `--slot-save-path`.
 *
 *   npx tsx spike/slot-resume-live.mts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlamaClient } from '../core/src/llama/client.js'
import { Session } from '../core/src/session/session.js'
import { SessionStore } from '../core/src/session/store.js'
import { createToolset } from '../core/src/tools/default-set.js'
import { readSlotRecord } from '../core/src/session/slot-record.js'

const root = mkdtempSync(join(tmpdir(), 'pc-slot-live-'))
mkdirSync(join(root, '.privatecode'), { recursive: true })
mkdirSync(join(root, 'src'), { recursive: true })
// Enough context to make the difference visible: ~12k tokens of real source, attached.
const big = readFileSync('D:\\Projects\\WindowsOptimizer\\src\\WinOptimizer\\ViewModels\\MainViewModel.cs', 'utf8')
writeFileSync(join(root, 'src', 'MainViewModel.cs'), big + '\n' + big, 'utf8')

const client = new LlamaClient({ baseUrl: process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080', model: 'kat' })
const build = (resume?: string) => new Session({
  client, toolset: createToolset({ workspaceRoot: root }), workspaceRoot: root, mode: 'autopilot',
  store: new SessionStore(root), compaction: { contextLength: 196_608, triggerTokens: 140_000 },
  ...(resume !== undefined ? { resume } : {}),
})

const first = build()
await first.warmPrefix()
let t = Date.now()
const r1 = await first.send('Read src/MainViewModel.cs whole, then answer in one line: what is the class name?')
console.log(`turn 1: ${((Date.now() - t) / 1000).toFixed(1)}s, ${r1.steps} steps, ${r1.stoppedBecause}; tokens ${first.contextUsage().promptTokens}`)
const record = readSlotRecord(root)
console.log(`slot record: ${JSON.stringify(record)}`)

// Resume in a fresh Session object, as the host does after an app restart.
const resumed = build(first.id)
t = Date.now()
const restored = await resumed.restoreSlot()
console.log(`restore: ${restored} in ${((Date.now() - t) / 1000).toFixed(1)}s`)
t = Date.now()
await resumed.warmPrefix()
console.log(`warm-up after restore: ${((Date.now() - t) / 1000).toFixed(1)}s`)
t = Date.now()
let firstStep = 0
const r2 = await resumed.send('And in one line: how many lines does that file have, roughly?')
console.log(`turn 2 (resumed): ${((Date.now() - t) / 1000).toFixed(1)}s, ${r2.steps} steps -> ${r2.finalText.slice(0, 80)}`)
void firstStep
rmSync(root, { recursive: true, force: true })
