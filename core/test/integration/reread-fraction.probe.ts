import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlamaClient } from '../../src/llama/client.js'
import { Session } from '../../src/session/session.js'
import { SessionStore } from '../../src/session/store.js'
import { createToolset } from '../../src/tools/default-set.js'

/**
 * The open measurement from docs/AUTONOMOUS-LOG.md: after a mid-turn compaction at the REAL
 * window, what fraction of the work is re-acquiring contents the model already had?
 *
 *   npx tsx test/integration/reread-fraction.probe.ts
 *
 * The earlier long-turn test could not answer this: it forced a 30k pretend window, so two
 * compactions in fifteen steps was an artefact of the harness. This runs at the server's own
 * 131,072 and earns its swaps honestly, with ~24 files of ~15k tokens each (~360k total
 * through the context).
 *
 * The task is deliberately read-only plus ONE write. If the task also edited every file, a
 * post-swap re-read would be CORRECT behaviour — Edit needs the current text to build
 * its search block — and the measurement would count necessary work as waste. Read-only, any
 * re-read of an already-read path is pure re-acquisition.
 */

const BASE = process.env.PRIVATECODE_SERVER ?? 'http://127.0.0.1:8080'
const FILES = 24
const HELPERS_PER_FILE = 210

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-reread-'))
  mkdirSync(join(root, 'src'))
  for (let f = 0; f < FILES; f++) {
    const subject = `Module${String(f).padStart(2, '0')}`
    const lines = [
      `/** ${subject}: domain helpers. */`,
      `export interface ${subject}Input { id: string; payload: string }`,
      '',
    ]
    for (let i = 0; i < HELPERS_PER_FILE; i++) {
      lines.push(
        `/** Helper ${i} of ${subject}. Verbose on purpose so reading this file is a real read. */`,
        `export function ${subject.toLowerCase()}Op${i}(input: ${subject}Input): string {`,
        '  return `${input.id}:' + i + ':${input.payload.length}`',
        '}',
        '',
      )
    }
    writeFileSync(join(root, 'src', `${subject.toLowerCase()}.ts`), lines.join('\n'), 'utf8')
  }
  return root
}

const root = makeWorkspace()
const t0 = performance.now()
const at = (): string => `${((performance.now() - t0) / 1000).toFixed(0).padStart(5)}s`

interface ReadRecord { step: number; path: string; afterSwap: number }
const reads: ReadRecord[] = []
let step = 0
let swaps = 0
let stepsAtSwap: number[] = []
let pendingRead = ''

const session = new Session({
  client: new LlamaClient({ baseUrl: BASE, model: 'qwen' }),
  toolset: createToolset({}),
  workspaceRoot: root,
  mode: 'autopilot',
  store: new SessionStore(root),
  longRun: true,
  compaction: { contextLength: 131_072 },
  onCompaction: (e) => {
    if (e.state === 'applied') {
      swaps++
      stepsAtSwap.push(step)
      console.log(`${at()}  SWAP ${swaps} applied (after step ${step})`)
    } else if (e.state !== 'started' && e.state !== 'ready') {
      console.log(`${at()}  compaction ${e.state}`)
    }
  },
  events: {
    onStepStart: (i) => { step = i.step },
    onToolCall: (name, args) => {
      let target = ''
      try { target = String((JSON.parse(args) as { path?: unknown }).path ?? '') } catch { /* not json */ }
      // Recorded at the RESULT, not here: the first run of this probe counted every
      // announced call as a read, and the step-result budget answers some announced calls
      // with `Not run:` — those never touched the file, so counting them inflated both the
      // total and the "re-read" figure (a refused call re-issued next step looked like a
      // re-read of a file that was never read).
      console.log(`${at()}  [${step}] ${name} ${target}`)
      if (name === 'Read') pendingRead = target
    },
    onToolResult: (name, result) => {
      if (name !== 'Read' || pendingRead === '') return
      if (!result.content.startsWith('Not run:')) {
        reads.push({ step, path: pendingRead, afterSwap: swaps })
      }
      pendingRead = ''
    },
    onStepDone: (i) => {
      console.log(`${at()}  step ${i.step} done: ${i.seconds.toFixed(0)}s, prompt ${i.promptTokens ?? '?'}, gen ${i.completionTokens ?? '?'}`)
    },
    onThinkingDelta: () => {},
  },
})

const result = await session.send(
  'Read every file in src/ one at a time. Then write INVENTORY.md at the workspace root: ' +
  'one line per file with the file name, how many exported functions it has, and what its ' +
  'interface is called. Do not modify any src/ file. Work steadily and finish.',
)

console.log(`\n${at()}  RESULT ${result.stoppedBecause} after ${result.steps} steps, ${swaps} swaps`)

// The measurement: per swap, how many post-swap reads target a path already read before it.
const seenBefore = (swapIndex: number): Set<string> =>
  new Set(reads.filter((r) => r.afterSwap < swapIndex).map((r) => r.path))
for (let sw = 1; sw <= swaps; sw++) {
  const before = seenBefore(sw)
  const after = reads.filter((r) => r.afterSwap === sw)
  const rereads = after.filter((r) => before.has(r.path))
  console.log(
    `swap ${sw}: ${after.length} reads after it, ${rereads.length} were re-reads ` +
    `(${after.length > 0 ? Math.round((rereads.length / after.length) * 100) : 0}%)` +
    (rereads.length > 0 ? ` — ${rereads.map((r) => r.path).join(', ')}` : ''),
  )
}
const uniquePaths = new Set(reads.map((r) => r.path)).size
console.log(`total: ${reads.length} reads over ${uniquePaths} unique files, ${FILES} files exist`)
// The ARTIFACT, checked before the workspace is deleted. The first two runs of this probe
// measured Read counts as a proxy for task completion and threw the inventory away
// unread — which produced a wrong conclusion in the ledger: 'the model shrank the task'.
// It had not. It counted exports with Grep instead of reading 60 KB files, and the
// proxy could not see that. The artifact is the only honest completion measure.
if (existsSync(join(root, 'INVENTORY.md'))) {
  const inv = readFileSync(join(root, 'INVENTORY.md'), 'utf8')
  const mentioned = Array.from({ length: FILES }, (_, f) => `module${String(f).padStart(2, '0')}`)
    .filter((name) => inv.includes(name)).length
  const lineCount = inv.split('\n').length
  console.log(`inventory: ${mentioned}/${FILES} files mentioned, ${lineCount} lines`)
} else {
  console.log('inventory written: false')
}
rmSync(root, { recursive: true, force: true })
