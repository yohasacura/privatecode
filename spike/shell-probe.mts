/**
 * Does the model use the shell the way a person would? A scratch workspace with junk to find
 * and delete, a few requests in the words the owner uses, and every tool call the model
 * makes — with the head of what each call answered — so a detour through the wrong tool
 * shows up as what it is. No files outside the scratch folder are touched.
 *
 *   npx tsx spike/shell-probe.mts [--only t1,t2] [--mode normal|autopilot] [--timeout-min 6]
 *
 * Needs the llama.cpp server (`LLAMA_URL`, default http://127.0.0.1:8080).
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlamaClient } from '../core/src/llama/client.js'
import { Session, type SessionOptions } from '../core/src/session/session.js'
import { createToolset } from '../core/src/tools/default-set.js'
import { buildRepoMap } from '../core/src/outline/repo-map.js'
import type { UserQuestion, ApprovalRequest } from '../core/src/interaction.js'
import type { AgentMode } from '../core/src/permissions/engine.js'

function argAfter(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}
const LLAMA_URL = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const ONLY = argAfter('--only', '').split(',').map((s) => s.trim()).filter(Boolean)
const MODE = argAfter('--mode', 'normal') as AgentMode
const TIMEOUT_MS = Number(argAfter('--timeout-min', '6')) * 60_000

interface Task {
  id: string
  text: string
  /** What must be true of the workspace afterwards. */
  check: (root: string) => { ok: boolean; detail: string }
}

function listAll(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
    if (e.isDirectory()) out.push(...listAll(join(dir, e.name), rel))
    else out.push(rel)
  }
  return out
}

const TASKS: Task[] = [
  {
    id: 't1',
    text: 'Find every .tmp file under build/ and delete them. Leave everything else alone.',
    check: (root) => {
      const files = listAll(root)
      const tmpLeft = files.filter((f) => f.startsWith('build/') && f.endsWith('.tmp'))
      const kept = ['src/app.ts', 'src/util.ts', 'build/keep.txt', 'README.md'].every((f) => files.includes(f))
      return { ok: tmpLeft.length === 0 && kept, detail: `tmp left: ${tmpLeft.length}, others kept: ${kept}` }
    },
  },
  {
    id: 't2',
    text: 'The cache/ folder is junk. Delete it completely, including everything inside.',
    check: (root) => ({ ok: !existsSync(join(root, 'cache')) && existsSync(join(root, 'src', 'app.ts')), detail: `cache exists: ${existsSync(join(root, 'cache'))}` }),
  },
  {
    id: 't3',
    text: 'Find all files whose name starts with "old-" anywhere in the workspace and remove them. Then tell me how many you removed.',
    check: (root) => {
      const left = listAll(root).filter((f) => f.split('/').pop()!.startsWith('old-'))
      return { ok: left.length === 0, detail: `old- left: ${left.length}` }
    },
  },
  {
    // The shape the owner most likely hit: a command that outlives Bash's two minutes.
    id: 't4',
    text: 'Run scripts/scan.sh with bash — it takes about two and a half minutes — and tell me the last line it prints.',
    check: (root) => ({ ok: existsSync(join(root, 'scripts', 'scan.sh')), detail: 'answer must quote "scan complete: 4 stale entries"' }),
  },
  {
    // A target the file tools refuse (outside the workspace), so the shell is the only way.
    id: 't5',
    text: 'There is a junk file at ../outside/junk.txt, next to this workspace folder. Delete it with the shell and confirm it is gone.',
    check: (root) => ({ ok: !existsSync(join(root, '..', 'outside', 'junk.txt')), detail: `junk exists: ${existsSync(join(root, '..', 'outside', 'junk.txt'))}` }),
  },
  {
    // The same script with no duration given: the first run meets Bash's two-minute default
    // timeout, and what the model does with that answer — a larger timeout, or the
    // background and a polling loop — is the point.
    id: 't6',
    text: 'Run scripts/scan.sh with bash and tell me the last line it prints.',
    check: (root) => ({ ok: existsSync(join(root, 'scripts', 'scan.sh')), detail: 'answer must quote "scan complete: 4 stale entries"' }),
  },
]

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-shell-'))
  const write = (rel: string, body = 'x\n'): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  write('README.md', '# scratch\n')
  write('src/app.ts', 'export const app = 1\n')
  write('src/util.ts', 'export const util = 1\n')
  write('src/old-helper.ts', 'export const old = 1\n')
  write('build/keep.txt', 'keep\n')
  for (let i = 0; i < 12; i++) write(`build/out${i}.tmp`)
  for (let i = 0; i < 4; i++) write(`build/nested/deep/part${i}.tmp`)
  write('cache/a/b/c.bin', 'bin')
  write('cache/index.json', '{}')
  write('docs/old-notes.md', 'notes\n')
  write('old-config.json', '{}')
  write('scripts/scan.sh', '#!/bin/bash\necho "scanning..."\nfor i in 1 2 3 4 5; do sleep 30; echo "pass $i"; done\necho "scan complete: 4 stale entries"\n')
  mkdirSync(join(root, '.privatecode'), { recursive: true })
  // Outside the workspace, for the task that needs the shell rather than DeleteFile.
  mkdirSync(join(root, '..', 'outside'), { recursive: true })
  writeFileSync(join(root, '..', 'outside', 'junk.txt'), 'junk\n')
  return root
}

function compactArgs(args: unknown): string {
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return args.slice(0, 100) } }
  if (typeof args !== 'object' || args === null) return ''
  return Object.entries(args as Record<string, unknown>)
    .filter(([k]) => k !== 'content' && k !== 'new_text' && k !== 'old_text')
    .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 90)}`)
    .join(', ')
}

async function runTask(task: Task): Promise<void> {
  const root = makeWorkspace()
  console.log(`\n=== ${task.id} (${MODE}) — ${root}\n    ${task.text}`)
  const toolset = createToolset({ workspaceRoot: root })
  const repoMap = await buildRepoMap(root)
  const calls: string[] = []
  const opts: SessionOptions = {
    client: new LlamaClient({ baseUrl: LLAMA_URL, model: 'kat' }),
    toolset,
    workspaceRoot: root,
    mode: MODE,
    repoMap,
    gates: 'off',
    compaction: { contextLength: 196_608, triggerTokens: 140_000 },
    interaction: {
      // A person who says yes to everything, so what is measured is the model's choice of tool.
      async requestApproval(req: ApprovalRequest) { console.log(`      [approval asked: ${req.summary ?? req.tool}] -> allow`); return { verdict: 'allow' as const } },
      async askUser(q: UserQuestion) { console.log(`      [asked: ${q.question.slice(0, 100)}] -> ${q.options[0] ?? 'yes'}`); return q.options[0] ?? 'yes' },
      todosChanged() {},
    },
    events: {
      onStepStart: () => {},
      onStepDone: () => {},
      onToolCall: (name, args) => { const line = `${name}(${compactArgs(args)})`; calls.push(line); console.log(`      ${line}`) },
      onToolResult: (name, result) => { console.log(`        -> ${name} ${result.ok ? 'ok' : 'FAIL'}: ${result.content.replace(/\s+/g, ' ').slice(0, 160)}`) },
      onAssistantText: () => {},
    },
  }
  const session = new Session(opts)
  const aborter = new AbortController()
  const timer = setTimeout(() => aborter.abort(), TIMEOUT_MS)
  const started = Date.now()
  let finalText = ''
  let stopped = 'unknown'
  let steps = 0
  try {
    const r = await session.send(task.text, aborter.signal)
    finalText = r.finalText; stopped = r.stoppedBecause; steps = r.steps
  } catch (e) {
    console.log(`    threw: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
  const check = task.check(root)
  const byTool = calls.reduce<Record<string, number>>((m, c) => { const n = c.slice(0, c.indexOf('(')); m[n] = (m[n] ?? 0) + 1; return m }, {})
  console.log(`    → ${check.ok ? 'DONE' : 'NOT DONE'} (${check.detail}); ${steps} steps, ${((Date.now() - started) / 1000).toFixed(0)}s, stopped: ${stopped}; calls: ${JSON.stringify(byTool)}`)
  console.log(`    answer: ${finalText.replace(/\s+/g, ' ').slice(0, 300)}`)
  await toolset.background.stopAll()
  await toolset.browser.close()
  await toolset.webRenderer.close()
  rmSync(root, { recursive: true, force: true })
}

for (const task of TASKS.filter((t) => ONLY.length === 0 || ONLY.includes(t.id))) await runTask(task)
