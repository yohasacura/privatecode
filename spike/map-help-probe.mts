/**
 * Does the project map help the model? The same questions about THIS repository, the same
 * model, the same workspace — once with the map (the hint in the repo map and the
 * `ProjectMap` tool) and once without either. Questions only, read-only: every approval
 * is denied, so nothing on disk changes. Each answer is scored against a rubric of facts
 * that are in the code, and every tool call is counted, so the table says whether the map
 * made the model faster, cheaper, more often right — or none of those.
 *
 *   npx tsx spike/map-help-probe.mts [--only q1,q4] [--condition map|none|both] [--repeat 1] [--timeout-min 6] [--list]
 *
 * Needs the llama.cpp server (`LLAMA_URL`, default http://127.0.0.1:8080) and a map built
 * for the areas the questions are about (`core/src/map`, `core/src/session`); the control
 * question is about an area with no notes on purpose. Writes eval/results/map-help-<stamp>.{json,md}.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { LlamaClient } from '../core/src/llama/client.js'
import { Session, type SessionOptions } from '../core/src/session/session.js'
import { createToolset } from '../core/src/tools/default-set.js'
import { buildRepoMap } from '../core/src/outline/repo-map.js'
import { withMapHint } from '../core/src/host/host.js'
import { mapStatus } from '../core/src/map/builder.js'
import { mapDirOf } from '../core/src/map/tool.js'
import type { UserQuestion, ApprovalRequest } from '../core/src/interaction.js'

function argAfter(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const LLAMA_URL = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const ONLY = argAfter('--only', '').split(',').map((s) => s.trim()).filter(Boolean)
const CONDITION = argAfter('--condition', 'both') as 'map' | 'none' | 'both'
const REPEAT = Number(argAfter('--repeat', '1'))
const TIMEOUT_MS = Number(argAfter('--timeout-min', '6')) * 60_000
const LIST = process.argv.includes('--list')

type Condition = 'map' | 'none'

interface Question {
  id: string
  /** Where the answer lives: an area the map covers, or one it does not (the control). */
  area: 'core/src/map' | 'core/src/session' | 'uncovered'
  text: string
  /** Facts a right answer states; the score is the share of them found in the final text. */
  rubric: { name: string; re: RegExp }[]
}

const QUESTIONS: Question[] = [
  {
    id: 'q1', area: 'core/src/map',
    text: 'In the project map builder, when exactly is a module note rewritten after one file below it changed, and when is the project note rewritten? Name the file and the rule, briefly.',
    rubric: [
      { name: 'file', re: /core\/src\/map\/builder\.ts|builder\.ts/ },
      { name: 'every file fresh', re: /every file|all (of )?(its|the) files|each file .*(fresh|note)|fully covered|covered/i },
      { name: 'hash over children', re: /moduleHash|hash/i },
      { name: 'project after root', re: /root module|root (note )?(has|exists|is written)|after the root|modules\[''\]|root\.md/i },
    ],
  },
  {
    id: 'q2', area: 'core/src/map',
    text: 'In the project map builder, what happens when the model\'s answer for a note does not parse as the form, and how does the person find out which notes failed?',
    rubric: [
      { name: 'asked again', re: /askAgain|once more|second (attempt|try)|retr(y|ies|ied)|asks again/i },
      { name: 'more room', re: /1\.5|half again|more (room|tokens)|bigger budget|larger budget|RETRY_GROWTH/i },
      { name: 'brevity', re: /brief|briefer|shorter|one sentence/i },
      { name: 'failed list in message', re: /failed \(|failed:|message|result\.failed|last message|done message|progress/i },
    ],
  },
  {
    id: 'q3', area: 'core/src/map',
    text: 'Which file renders a file note of the project map to markdown, what is the function called, and what sections does the rendered note have, in order?',
    rubric: [
      { name: 'notes.ts', re: /notes\.ts/ },
      { name: 'renderFileNote', re: /renderFileNote/ },
      { name: 'What/Why', re: /What[\s\S]{0,80}Why/ },
      { name: 'Contracts/Invariants/Gotchas', re: /Contracts[\s\S]{0,80}Invariants[\s\S]{0,80}Gotchas/ },
      { name: 'Uses/Used by/Tests', re: /Uses[\s\S]{0,60}Used by[\s\S]{0,60}Tests/ },
      { name: 'co-changes/History', re: /Changes together with[\s\S]{0,60}History/ },
    ],
  },
  {
    id: 'q4', area: 'core/src/session',
    text: 'What is the "task contract" in this agent: when is it made from the request, where does it go in the transcript, and how does it survive a compaction? Name the files.',
    rubric: [
      { name: 'contract.ts', re: /contract\.ts/ },
      { name: 'distilled up front', re: /distill|up front|once|at the start|before (the )?(work|first)/i },
      { name: 'appended to the tail', re: /append|tail|end of the transcript|after the (user|request)/i },
      { name: 'system prompt at compaction', re: /system prompt|message 0|promoted/i },
      { name: 'compaction', re: /compaction|compact/i },
    ],
  },
  {
    id: 'q5', area: 'core/src/session',
    text: 'How does this app decide which session resumes instantly from the llama.cpp slot file, and why is there exactly one such file per workspace instead of one per session? Name the file that decides.',
    rubric: [
      { name: 'slot-record.ts', re: /slot-record\.ts/ },
      { name: 'one per workspace', re: /one (file|state|record) per workspace|per workspace/i },
      { name: 'server takes a file name', re: /file ?name|not a path|cannot (list|delete)|does not know the (directory|folder)|slot-save-path/i },
      { name: 'size of a state', re: /GB|gigabyte|100k|large|big|disk/i },
      { name: 'last session resumes', re: /last (session|one)|most recent|was last in|latest/i },
    ],
  },
  {
    id: 'q6', area: 'uncovered',
    text: 'In a workspace of several folders, how does the app find which git repository a file belongs to when the person right-clicks it in the Git tab? Name the RPC method and the file that answers it.',
    // The first rubric here said host.ts; the handler is in git-rpc.ts and the walk in
    // repos.ts, and the model was right both times it was marked wrong. Rubrics are checked
    // against the code, not against memory — `--rescore` re-applies them to a saved run.
    rubric: [
      { name: 'git.locate', re: /git\.locate|locate/ },
      { name: 'git-rpc.ts or repos.ts', re: /git-rpc\.ts|repos\.ts/ },
      { name: 'walks up to .git and checks the workspace touches it', re: /repoRootFor|walks? up|containing `?\.git|allowedRoot|allowed repositor|workspace touches/i },
    ],
  },
]

interface Run {
  id: string
  area: string
  condition: Condition
  repeat: number
  score: number
  hits: string[]
  misses: string[]
  steps: number
  seconds: number
  modelSeconds: number
  generatedTokens: number
  finalPromptTokens: number | null
  reads: number
  mapCalls: number
  calls: string[]
  stoppedBecause: string
  timedOut: boolean
  error?: string
  finalText: string
}

function compactArgs(args: unknown): string {
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return args.slice(0, 80) }
  }
  if (typeof args !== 'object' || args === null) return ''
  return Object.entries(args as Record<string, unknown>)
    .filter(([k]) => k !== 'content' && k !== 'new_text' && k !== 'old_text')
    .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 70)}`)
    .join(', ')
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'list_dir', 'symbol_outline', 'CSharpNav', 'csharp_nav', 'ProjectMap'])

/**
 * Without the map means WITHOUT it: the folder is moved aside for the run, so neither the
 * hint, nor the tool, nor the note a Read carries on top of a file can reach the model.
 * Put back whatever happens.
 */
async function withoutMap<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mapDirOf(ROOT)
  const aside = `${dir}.aside`
  if (!existsSync(dir)) return fn()
  renameSync(dir, aside)
  try {
    return await fn()
  } finally {
    renameSync(aside, dir)
  }
}

async function runOne(q: Question, condition: Condition, repeat: number): Promise<Run> {
  return condition === 'none' ? withoutMap(() => runWith(q, condition, repeat)) : runWith(q, condition, repeat)
}

async function runWith(q: Question, condition: Condition, repeat: number): Promise<Run> {
  const toolset = createToolset({ workspaceRoot: ROOT })
  if (condition === 'none') toolset.registry.unregister('ProjectMap')
  const bare = await buildRepoMap(ROOT)
  const repoMap = condition === 'map' ? withMapHint(bare, ROOT) : bare
  if (condition === 'map' && repoMap === bare) throw new Error('no map hint: is the map built under .privatecode/map?')

  const calls: string[] = []
  let modelSeconds = 0
  let generated = 0
  let lastPrompt: number | undefined
  const opts: SessionOptions = {
    client: new LlamaClient({ baseUrl: LLAMA_URL, model: 'kat' }),
    toolset,
    workspaceRoot: ROOT,
    mode: 'normal',
    repoMap,
    gates: 'off',
    compaction: { contextLength: 196_608, triggerTokens: 140_000 },
    interaction: {
      // Read-only by construction: a write or a shell command is refused, and the model is told why.
      async requestApproval(_req: ApprovalRequest) { return { verdict: 'deny' as const, comment: 'This is a read-only question; answer from what you can read.' } },
      async askUser(question: UserQuestion) { return question.options[0] ?? 'yes' },
      todosChanged() {},
    },
    events: {
      onStepStart: () => {},
      onStepDone: (i) => {
        modelSeconds += i.seconds
        generated += i.completionTokens ?? 0
        if (i.promptTokens !== undefined) lastPrompt = i.promptTokens
      },
      onToolCall: (name, args, agent) => {
        const line = `${agent ? `[${agent}] ` : ''}${name}(${compactArgs(args)})`
        calls.push(line)
        console.log(`      ${line}`)
      },
      onToolResult: () => {},
      onAssistantText: () => {},
    },
  }
  const session = new Session(opts)
  const warmable = session as unknown as { warmPrefix?: () => Promise<void> }
  if (typeof warmable.warmPrefix === 'function') await warmable.warmPrefix()

  const t0 = Date.now()
  let stoppedBecause = 'unknown'
  let steps = 0
  let finalText = ''
  let timedOut = false
  let error: string | undefined
  const aborter = new AbortController()
  const timer = setTimeout(() => { timedOut = true; aborter.abort() }, TIMEOUT_MS)
  try {
    const result = await session.send(q.text, aborter.signal)
    stoppedBecause = result.stoppedBecause
    steps = result.steps
    finalText = result.finalText
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    clearTimeout(timer)
  }
  const seconds = (Date.now() - t0) / 1000
  await toolset.background.stopAll()
  await toolset.browser.close()
  await toolset.webRenderer.close()

  const hits = q.rubric.filter((r) => r.re.test(finalText)).map((r) => r.name)
  const misses = q.rubric.filter((r) => !r.re.test(finalText)).map((r) => r.name)
  const toolName = (line: string): string => /^(?:\[[^\]]+\] )?([A-Za-z_]+)\(/.exec(line)?.[1] ?? ''
  return {
    id: q.id, area: q.area, condition, repeat,
    score: Math.round((hits.length / q.rubric.length) * 100) / 100,
    hits, misses, steps,
    seconds: Number(seconds.toFixed(1)),
    modelSeconds: Number(modelSeconds.toFixed(1)),
    generatedTokens: generated,
    finalPromptTokens: lastPrompt ?? null,
    reads: calls.filter((c) => READ_TOOLS.has(toolName(c))).length,
    mapCalls: calls.filter((c) => toolName(c) === 'ProjectMap').length,
    calls, stoppedBecause, timedOut,
    ...(error !== undefined ? { error } : {}),
    finalText,
  }
}

function table(runs: Run[]): string {
  const head = '| question | area | with | score | steps | seconds | model s | reads | map calls | generated | prompt |\n|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|'
  const body = runs.map((r) => `| ${r.id}${r.repeat > 1 ? `#${r.repeat}` : ''} | ${r.area} | ${r.condition} | ${r.score}${r.timedOut ? ' ⏱' : ''}${r.error ? ' ✗' : ''} | ${r.steps} | ${r.seconds} | ${r.modelSeconds} | ${r.reads} | ${r.mapCalls} | ${r.generatedTokens} | ${r.finalPromptTokens ?? '—'} |`)
  const by = (c: Condition): Run[] => runs.filter((r) => r.condition === c && !r.error)
  const mean = (xs: number[]): string => (xs.length === 0 ? '—' : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2))
  const sum = [
    '',
    '| | score | steps | seconds | reads |',
    '|---|---:|---:|---:|---:|',
    ...(['map', 'none'] as Condition[]).map((c) => `| ${c} | ${mean(by(c).map((r) => r.score))} | ${mean(by(c).map((r) => r.steps))} | ${mean(by(c).map((r) => r.seconds))} | ${mean(by(c).map((r) => r.reads))} |`),
  ]
  return `${head}\n${body.join('\n')}\n${sum.join('\n')}`
}

/** The current rubrics over a saved run's answers: the table again, without the model. */
function rescore(file: string): void {
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { runs: Run[] }
  const runs = saved.runs.map((r) => {
    const q = QUESTIONS.find((x) => x.id === r.id)
    if (q === undefined) return r
    const hits = q.rubric.filter((x) => x.re.test(r.finalText)).map((x) => x.name)
    const misses = q.rubric.filter((x) => !x.re.test(r.finalText)).map((x) => x.name)
    return { ...r, hits, misses, score: Math.round((hits.length / q.rubric.length) * 100) / 100 }
  })
  console.log(table(runs))
}

async function main(): Promise<void> {
  const rescoreFile = argAfter('--rescore', '')
  if (rescoreFile !== '') { rescore(rescoreFile); return }
  const chosen = QUESTIONS.filter((q) => ONLY.length === 0 || ONLY.includes(q.id))
  if (LIST) {
    for (const q of chosen) console.log(`${q.id} [${q.area}] ${q.text}\n    rubric: ${q.rubric.map((r) => r.name).join(' · ')}`)
    const status = mapStatus(mapDirOf(ROOT))
    console.log(`\nmap: ${status.exists ? `${status.noted}/${status.files} files noted` : 'none'} at ${status.dir}`)
    return
  }
  const conditions: Condition[] = CONDITION === 'both' ? ['none', 'map'] : [CONDITION]
  const runs: Run[] = []
  for (let rep = 1; rep <= REPEAT; rep++) {
    for (const [i, q] of chosen.entries()) {
      // Alternate which condition goes first, so neither always enjoys the warmer cache.
      const order = (i + rep) % 2 === 0 ? conditions : [...conditions].reverse()
      for (const c of order) {
        console.log(`\n=== ${q.id} (${q.area}) — ${c === 'map' ? 'WITH the map' : 'without the map'}${REPEAT > 1 ? ` #${rep}` : ''}\n    ${q.text}`)
        const r = await runOne(q, c, rep)
        runs.push(r)
        console.log(`    → score ${r.score} (${r.hits.join(', ') || 'nothing'}${r.misses.length > 0 ? ` | missed: ${r.misses.join(', ')}` : ''}), ${r.steps} steps, ${r.seconds}s, ${r.reads} reads, ${r.mapCalls} map calls, stopped: ${r.stoppedBecause}${r.timedOut ? ' (TIMED OUT)' : ''}${r.error ? ` error: ${r.error}` : ''}`)
        console.log(`    answer: ${r.finalText.replace(/\s+/g, ' ').slice(0, 400)}`)
      }
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = join(ROOT, 'eval', 'results')
  mkdirSync(dir, { recursive: true })
  const md = table(runs)
  writeFileSync(join(dir, `map-help-${stamp}.json`), JSON.stringify({ at: new Date().toISOString(), root: ROOT, runs }, null, 2), 'utf8')
  writeFileSync(join(dir, `map-help-${stamp}.md`), `# Does the map help?\n\n${md}\n`, 'utf8')
  console.log(`\n${md}\n\nwritten to eval/results/map-help-${stamp}.{json,md}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
