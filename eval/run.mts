/**
 * The eval: every task in eval/tasks.ts against the live server, one after another (the
 * server has one slot), each in a fresh copy of its project, each checked by things the model
 * never sees. One command:
 *
 *   npm run eval --prefix core                       # everything, the default gate profile
 *   npm run eval --prefix core -- --gates fast       # under a profile
 *   npm run eval --prefix core -- --only logger-rotation,bp-quote-cost-total
 *   npm run eval --prefix core -- --workspace winopt
 *   npm run eval --prefix core -- --label after-roslyn --baseline eval/results/before.json
 *
 * Writes eval/results/<label>-<stamp>.json (everything) and .md (the table), prints the table,
 * and with --baseline prints what changed against an earlier run. `--keep` leaves the copies
 * in place for a look; `--timeout-min N` caps one task's wall clock (default 12).
 *
 * The originals are only ever READ: each task works in a copy under the system temp folder,
 * removed when the task is done.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LlamaClient } from '../core/src/llama/client.js'
import { Session, type SessionOptions, type StageInfo } from '../core/src/session/session.js'
import { createToolset } from '../core/src/tools/default-set.js'
import { buildRepoMap } from '../core/src/outline/repo-map.js'
import type { UserQuestion, ApprovalRequest } from '../core/src/interaction.js'
import { SHAPES, makeWorkspace, removeCopy, runIn } from './workspace.js'
import { TASKS, type Task } from './tasks.js'

function argAfter(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}

const GATES = argAfter('--gates', 'thorough') as 'thorough' | 'fast' | 'off'
const LABEL = argAfter('--label', GATES)
const ONLY = argAfter('--only', '').split(',').map((s) => s.trim()).filter(Boolean)
const WORKSPACE = argAfter('--workspace', '')
const BASELINE = argAfter('--baseline', '')
const KEEP = process.argv.includes('--keep')
const TIMEOUT_MS = Number(argAfter('--timeout-min', '12')) * 60_000
const LLAMA_URL = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'

interface Check { name: string; ok: boolean; detail: string; seconds?: number }

interface TaskResult {
  id: string
  workspace: string
  kind: string
  pass: boolean
  checks: Check[]
  stoppedBecause: string
  steps: number
  totalSeconds: number
  modelSeconds: number
  gateSeconds: number
  generatedTokens: number
  finalPromptTokens: number | null
  readCalls: number
  writeCalls: number
  selfChecks: number
  verifyRuns: number
  compilerChecks: number
  finalText: string
  timedOut: boolean
  error?: string
}

interface Row { t: number; kind: string; detail: string; seconds?: number; promptTokens?: number; completionTokens?: number }

async function runTask(task: Task): Promise<TaskResult> {
  const shape = SHAPES[task.workspace]!
  const { root, mounts } = makeWorkspace(shape)
  const primary = mounts[0]!
  console.log(`\n=== ${task.id} (${task.workspace}, ${task.kind}) — copy at ${root}`)

  for (const plant of task.plant ?? []) {
    const file = join(primary.root, plant.file)
    const raw = readFileSync(file, 'utf8')
    // The anchors are written with \n; the projects are checked out with CRLF. Match on the
    // file's own line endings and write them back unchanged.
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    const from = plant.from.split('\n').join(eol)
    const to = plant.to.split('\n').join(eol)
    const count = raw.split(from).length - 1
    if (count !== (plant.count ?? 1)) {
      throw new Error(`${task.id}: plant expected ${plant.count ?? 1} occurrence(s) in ${plant.file}, found ${count}`)
    }
    writeFileSync(file, raw.split(from).join(to), 'utf8')
  }

  const rows: Row[] = []
  let t0 = Date.now()
  const at = (): number => (Date.now() - t0) / 1000
  const log = (row: Row): void => {
    rows.push(row)
    if (row.kind === 'tool-call' || row.kind === 'stage' || row.kind === 'verify' || row.kind === 'acceptance') {
      console.log(`${row.t.toFixed(1).padStart(7)}s  ${row.kind.padEnd(10)} ${row.detail}${row.seconds !== undefined ? ` [${row.seconds.toFixed(1)}s]` : ''}`)
    }
  }

  const repoMap = await buildRepoMap(mounts.length > 1 ? mounts : root)
  const toolset = createToolset({ workspaceRoot: root })
  const verifyFolders: Record<string, { command: string; timeoutMs: number; source: string }> = {}
  for (const [name, command] of Object.entries(shape.verify)) {
    verifyFolders[name] = { command, timeoutMs: 240_000, source: 'eval' }
  }
  const opts: SessionOptions = {
    client: new LlamaClient({ baseUrl: LLAMA_URL, model: 'kat' }),
    toolset,
    workspaceRoot: root,
    ...(mounts.length > 1 ? { mounts } : {}),
    mode: 'autopilot',
    repoMap,
    ...(GATES !== 'thorough' ? { gates: GATES } : {}),
    compaction: { contextLength: 196_608, triggerTokens: 140_000 },
    ...(mounts.length > 1 ? { verifyFolders } : { verify: verifyFolders[primary.name]! }),
    onVerify: (i) => log({ t: at(), kind: 'verify', detail: `${i.folder ? `${i.folder}: ` : ''}${i.command.startsWith('C#') ? 'compiler check' : 'build'} ${i.ok ? 'ok' : 'FAIL'} attempt ${i.attempt}` }),
    onAcceptance: (i) => log({ t: at(), kind: 'acceptance', detail: `${i.kind}: met ${i.met}, unmet ${i.unmet}, round ${i.round}` }),
    onStage: (s: StageInfo) => {
      if (s.state === 'progress') return
      log({
        t: at(), kind: 'stage',
        detail: `${s.stage} ${s.state}${s.detail ? ` — ${s.detail}` : ''}${s.outcome ? ` → ${s.outcome}` : ''}`,
        ...(s.ms !== undefined ? { seconds: s.ms / 1000 } : {}),
      })
    },
    interaction: {
      async requestApproval(_req: ApprovalRequest) { return { verdict: 'allow' as const } },
      async askUser(q: UserQuestion) {
        const answered = q.options[0] ?? 'yes'
        log({ t: at(), kind: 'text', detail: `asked: ${q.question.slice(0, 120)} → ${answered}` })
        return answered
      },
      todosChanged() {},
    },
    events: {
      onStepStart: (i) => log({ t: at(), kind: 'step-start', detail: `step ${i.step}` }),
      onStepDone: (i) => log({
        t: at(), kind: 'step-done', detail: `step ${i.step}`, seconds: i.seconds,
        ...(i.promptTokens !== undefined ? { promptTokens: i.promptTokens } : {}),
        ...(i.completionTokens !== undefined ? { completionTokens: i.completionTokens } : {}),
      }),
      onToolCall: (name, args, agent) => log({
        t: at(), kind: 'tool-call',
        detail: `${agent ? `[${agent}] ` : ''}${name}(${compactArgs(args)})`,
      }),
      onToolResult: () => {},
      onAssistantText: () => {},
    },
  }

  const session = new Session(opts)
  const warmable = session as unknown as { warmPrefix?: () => Promise<void> }
  if (typeof warmable.warmPrefix === 'function') await warmable.warmPrefix()

  t0 = Date.now()
  let stoppedBecause = 'unknown'
  let steps = 0
  let finalText = ''
  let timedOut = false
  let error: string | undefined
  const aborter = new AbortController()
  const timer = setTimeout(() => { timedOut = true; aborter.abort() }, TIMEOUT_MS)
  try {
    const result = await session.send(task.text, aborter.signal)
    stoppedBecause = result.stoppedBecause
    steps = result.steps
    finalText = result.finalText
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
    console.log(`  turn threw: ${error}`)
  } finally {
    clearTimeout(timer)
  }
  const totalSeconds = at()

  // Checks, in the order a person would run them: does it build, do the hidden tests pass,
  // is the named thing where it was asked for.
  const checks: Check[] = []
  for (const [folder, command] of Object.entries(shape.verify)) {
    const cwd = mounts.find((m) => m.name === folder)!.root
    const r = runIn(cwd, command)
    checks.push({ name: `build:${folder}`, ok: r.ok, detail: r.ok ? 'ok' : lastErrorLines(r.output), seconds: r.seconds })
  }
  if (task.hidden !== undefined) {
    const tp = shape.testProject
    if (tp === undefined) {
      checks.push({ name: 'hidden-tests', ok: false, detail: 'shape has no test project' })
    } else {
      const testDir = join(mounts.find((m) => m.name === tp.folder)!.root, tp.dir)
      if (tp.template !== undefined) {
        cpSync(new URL(`./${tp.template}/`, import.meta.url), testDir, { recursive: true })
      }
      const hiddenDir = new URL(`./hidden/${task.hidden}/`, import.meta.url)
      for (const f of readdirSync(hiddenDir)) {
        if (f.endsWith('.cs')) copyFileSync(new URL(f, hiddenDir), join(testDir, f))
      }
      const restore = tp.template !== undefined ? '' : ' --no-restore'
      const r = runIn(testDir, `dotnet test ${tp.csproj}${restore} --nologo -v q`, 600_000)
      const m = /(Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+)/.exec(r.output)
      const summary = m ? `failed ${m[2]}, passed ${m[3]}` : (/error CS\d+/.test(r.output) ? 'did not compile' : 'no test summary')
      checks.push({
        name: 'hidden-tests', ok: r.ok && m !== null && m[2] === '0',
        detail: r.ok ? summary : `${summary}: ${lastErrorLines(r.output)}`, seconds: r.seconds,
      })
    }
  }
  for (const g of task.grep ?? []) {
    const abs = resolveWorkspacePath(mounts, g.file)
    const exists = abs !== null && existsSync(abs)
    const hit = exists ? new RegExp(g.pattern).test(readFileSync(abs, 'utf8')) : false
    const ok = g.absent ? !hit : hit
    checks.push({
      name: `grep:${g.file.split('/').pop()}:${g.pattern.slice(0, 24)}`, ok,
      detail: !exists ? 'file missing' : ok ? 'ok' : g.absent ? 'present' : 'absent',
    })
  }

  const toolCalls = rows.filter((r) => r.kind === 'tool-call')
  const isRead = (d: string): boolean => /^(\[[^\]]+\] )?(read_file|list_dir|find_files|search_code|symbol_outline|csharp_nav|git_status)\(/.test(d)
  const isWrite = (d: string): boolean => /^(\[[^\]]+\] )?(edit_file|write_file)\(/.test(d)
  const stageSeconds = rows.filter((r) => r.kind === 'stage').reduce((n, r) => n + (r.seconds ?? 0), 0)
  const modelSeconds = rows.filter((r) => r.kind === 'step-done').reduce((n, r) => n + (r.seconds ?? 0), 0)
  const lastPrompt = [...rows].reverse().find((r) => r.promptTokens !== undefined)?.promptTokens
  const result: TaskResult = {
    id: task.id, workspace: task.workspace, kind: task.kind,
    pass: checks.length > 0 && checks.every((c) => c.ok) && !timedOut && error === undefined,
    checks, stoppedBecause, steps,
    totalSeconds: Number(totalSeconds.toFixed(1)),
    modelSeconds: Number(modelSeconds.toFixed(1)),
    gateSeconds: Number(stageSeconds.toFixed(1)),
    generatedTokens: rows.reduce((n, r) => n + (r.completionTokens ?? 0), 0),
    finalPromptTokens: lastPrompt ?? null,
    readCalls: toolCalls.filter((r) => isRead(r.detail)).length,
    writeCalls: toolCalls.filter((r) => isWrite(r.detail)).length,
    selfChecks: toolCalls.filter((r) => /run_command\(.*dotnet (build|test)/.test(r.detail)).length,
    verifyRuns: rows.filter((r) => r.kind === 'verify' && r.detail.includes('build ')).length,
    compilerChecks: rows.filter((r) => r.kind === 'verify' && r.detail.includes('compiler check')).length,
    finalText: finalText.replace(/\s+/g, ' ').slice(0, 500),
    timedOut,
    ...(error !== undefined ? { error } : {}),
  }
  console.log(`  → ${result.pass ? 'PASS' : 'FAIL'}  ${checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ` (${c.detail.slice(0, 160)})`}`).join('  ')}`)
  console.log(`    ${steps} steps, ${result.totalSeconds}s total (model ${result.modelSeconds}s, gates ${result.gateSeconds}s), ${result.readCalls} reads, ${result.writeCalls} writes, stopped: ${stoppedBecause}${timedOut ? ' (TIMED OUT)' : ''}`)

  await toolset.background.stopAll()
  await toolset.browser.close()
  await toolset.webRenderer.close()
  if (!KEEP) removeCopy(join(root, '..'))
  else console.log(`  copy kept at ${root}`)
  return result
}

function resolveWorkspacePath(mounts: { name: string; root: string }[], file: string): string | null {
  if (mounts.length === 1) return join(mounts[0]!.root, file)
  const [head, ...rest] = file.split('/')
  const mount = mounts.find((m) => m.name === head)
  return mount ? join(mount.root, ...rest) : null
}

function lastErrorLines(output: string): string {
  const lines = output.split(/\r?\n/).filter((l) => /error|Failed|failed/.test(l))
  return (lines.length > 0 ? lines.slice(-3) : output.trim().split(/\r?\n/).slice(-3)).join(' | ').slice(0, 400)
}

function compactArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  return Object.entries(args as Record<string, unknown>)
    .filter(([k]) => k !== 'content' && k !== 'new_text' && k !== 'old_text')
    .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 60)}`)
    .join(', ')
}

function table(results: TaskResult[]): string {
  const head = '| task | result | steps | seconds | model s | gates s | reads | writes | builds | checks | stopped |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|'
  const body = results.map((r) => `| ${r.id} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.steps} | ${r.totalSeconds} | ${r.modelSeconds} | ${r.gateSeconds} | ${r.readCalls} | ${r.writeCalls} | ${r.verifyRuns} | ${r.compilerChecks} | ${r.stoppedBecause}${r.timedOut ? ' (timeout)' : ''} |`)
  const passed = results.filter((r) => r.pass).length
  const total = results.reduce((n, r) => n + r.totalSeconds, 0)
  return `${head}\n${body.join('\n')}\n\n**${passed}/${results.length} passed**, ${Math.round(total)} s of wall clock, gates ${GATES}.`
}

function failures(results: TaskResult[]): string {
  return results.filter((r) => !r.pass).map((r) =>
    `- **${r.id}**: ${r.checks.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail}`).join('; ')}${r.error ? `; error: ${r.error}` : ''}${r.timedOut ? '; timed out' : ''}`,
  ).join('\n')
}

function compare(results: TaskResult[], baselineFile: string): string {
  const base = JSON.parse(readFileSync(baselineFile, 'utf8')) as { results: TaskResult[] }
  const lines: string[] = ['| task | before | after | seconds before → after | steps before → after |', '|---|---|---|---|---|']
  for (const r of results) {
    const b = base.results.find((x) => x.id === r.id)
    if (b === undefined) { lines.push(`| ${r.id} | — | ${r.pass ? 'PASS' : 'FAIL'} | — → ${r.totalSeconds} | — → ${r.steps} |`); continue }
    lines.push(`| ${r.id} | ${b.pass ? 'PASS' : 'FAIL'} | ${r.pass ? 'PASS' : 'FAIL'} | ${b.totalSeconds} → ${r.totalSeconds} | ${b.steps} → ${r.steps} |`)
  }
  const bPass = base.results.filter((x) => results.some((r) => r.id === x.id) && x.pass).length
  const aPass = results.filter((r) => r.pass).length
  const bSec = base.results.filter((x) => results.some((r) => r.id === x.id)).reduce((n, x) => n + x.totalSeconds, 0)
  const aSec = results.reduce((n, r) => n + r.totalSeconds, 0)
  return `${lines.join('\n')}\n\npassed ${bPass} → ${aPass}; wall clock ${Math.round(bSec)} s → ${Math.round(aSec)} s.`
}

async function main(): Promise<void> {
  let tasks = TASKS
  if (ONLY.length > 0) {
    const missing = ONLY.filter((id) => !tasks.some((t) => t.id === id))
    if (missing.length > 0) throw new Error(`unknown task(s): ${missing.join(', ')}`)
    tasks = tasks.filter((t) => ONLY.includes(t.id))
  }
  if (WORKSPACE !== '') tasks = tasks.filter((t) => t.workspace === WORKSPACE)
  console.log(`eval: ${tasks.length} task(s), gates ${GATES}, server ${LLAMA_URL}`)

  const results: TaskResult[] = []
  const started = Date.now()
  for (const task of tasks) {
    try {
      results.push(await runTask(task))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.log(`  harness error on ${task.id}: ${message}`)
      results.push({
        id: task.id, workspace: task.workspace, kind: task.kind, pass: false, checks: [], stoppedBecause: 'harness-error',
        steps: 0, totalSeconds: 0, modelSeconds: 0, gateSeconds: 0, generatedTokens: 0, finalPromptTokens: null,
        readCalls: 0, writeCalls: 0, selfChecks: 0, verifyRuns: 0, compilerChecks: 0, finalText: '', timedOut: false, error: message,
      })
    }
    // After EVERY task, not only at the end: a run killed at task nine still has eight results,
    // and a person watching can read the table while it grows.
    persist(results, render(results, started, tasks.length))
    console.log(`  [${results.filter((r) => r.pass).length}/${results.length} passed so far, ${tasks.length - results.length} to go]`)
  }

  const report = render(results, started, tasks.length)
  console.log(`\n${report}`)
  persist(results, report)
  console.log(`\nwritten: eval/results/${BASE}.json and .md`)
  process.exit(results.every((r) => r.pass) ? 0 : 1)
}

const BASE = `${LABEL}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`

function render(results: TaskResult[], started: number, planned: number): string {
  const md = [
    `# Eval — ${LABEL}`, '',
    `${new Date().toISOString()} · gates ${GATES} · ${Math.round((Date.now() - started) / 1000)} s` +
      (results.length < planned ? ` · ${results.length} of ${planned} tasks so far` : ''),
    '', table(results),
  ]
  const failed = failures(results)
  if (failed) md.push('', '## Failures', '', failed)
  if (BASELINE) md.push('', `## Against ${BASELINE}`, '', compare(results, BASELINE))
  return md.join('\n')
}

function persist(results: TaskResult[], report: string): void {
  const outDir = new URL('./results/', import.meta.url)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(new URL(`./results/${BASE}.json`, import.meta.url), JSON.stringify({ label: LABEL, gates: GATES, at: new Date().toISOString(), results }, null, 1), 'utf8')
  writeFileSync(new URL(`./results/${BASE}.md`, import.meta.url), report, 'utf8')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
