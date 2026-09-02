/**
 * Where the wall clock goes on ONE ordinary editing turn, against a real project.
 *
 * The complaint this measures: "one edit costs 10–20 reads first". Everything the harness
 * and the model do between the user's message and the turn's end is timed here — every
 * step, every tool call, every gate — against a throwaway COPY of a real workspace, so the
 * model's own exploration habits are what is on the clock and nothing on disk is at risk.
 *
 * Two workspaces:
 *   winopt     — WindowsOptimizer, one folder, 23 .cs files. The small case.
 *   blackport  — black-port's backend (4 C# projects) and frontend (Next.js) as TWO folders,
 *                ~600 source files. The shape the owner actually works in.
 *
 *   npx tsx spike/speed-baseline-probe.mts [--workspace winopt|blackport] [--task short|long]
 *                                          [--label name] [--no-warm] [--keep] [--build-check]
 *
 * Writes spike/speed-results/<label>-<workspace>-<task>-<timestamp>.json so runs before and
 * after a change can be compared on the same numbers.
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlamaClient } from '../core/src/llama/client.js'
import { Session, type SessionOptions, type StageInfo } from '../core/src/session/session.js'
import { createToolset } from '../core/src/tools/default-set.js'
import { buildRepoMap } from '../core/src/outline/repo-map.js'
import type { Mount } from '../core/src/mounts.js'
import type { UserQuestion, ApprovalRequest } from '../core/src/interaction.js'

const argAfter = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}
const WORKSPACE = argAfter('--workspace', 'winopt')
const TASK = argAfter('--task', 'short')
const LABEL = argAfter('--label', 'baseline')
const KEEP = process.argv.includes('--keep')
const WARM = !process.argv.includes('--no-warm')
/** `--gates thorough|fast|off`: the settings.json profile a run is measured under. */
const GATES = argAfter('--gates', 'thorough') as 'thorough' | 'fast' | 'off'

interface Shape {
  /** Folders to copy: model-visible name, source path, what to leave out. */
  folders: { name: string; from: string; skip: RegExp; access: 'write' | 'read' }[]
  /** Which folders hold .NET projects whose obj/ carries absolute paths to rewrite. */
  dotnetProjects: string[]
  /** The check the owner's settings would run, per folder. */
  verify: Record<string, string>
  /** What the probe builds and tests on `--build-check`. */
  buildCheck: { folder: string; args: string[] }[]
  /**
   * Files left out of the copy, folder-relative. The owner's working tree carries seven
   * failing view-model tests that have nothing to do with the task; a model that runs
   * `dotnet test` and sees them goes off to fix them, and the probe then measures scope
   * creep instead of the agent. The task's own test file stays.
   */
  dropInCopy?: Record<string, string[]>
  tasks: Record<string, string>
}

const SHAPES: Record<string, Shape> = {
  winopt: {
    folders: [{
      name: 'WindowsOptimizer',
      from: process.env['PROBE_SOURCE'] ?? 'D:\\Projects\\WindowsOptimizer',
      skip: /[\\/](publish|\.git|\.privatecode|docs)([\\/]|$)/,
      access: 'write',
    }],
    dotnetProjects: ['src/WinOptimizer', 'tests/WinOptimizer.Tests'],
    verify: {
      WindowsOptimizer: 'dotnet build src/WinOptimizer/WinOptimizer.csproj --no-restore --nologo -v q',
    },
    buildCheck: [
      { folder: 'WindowsOptimizer', args: ['build', 'src/WinOptimizer/WinOptimizer.csproj', '--nologo', '-v', 'q'] },
      { folder: 'WindowsOptimizer', args: ['test', 'tests/WinOptimizer.Tests/WinOptimizer.Tests.csproj', '--nologo', '-v', 'q'] },
    ],
    dropInCopy: { WindowsOptimizer: ['tests/WinOptimizer.Tests/MainViewModelTests.cs'] },
    tasks: {
      /** Below the contract threshold: no distillation, no gates — the read habit alone. */
      short:
        'Add a `SavedAt` DateTime property to the Snapshot record and set it to DateTime.UtcNow in SnapshotStore.Save.',
      /** Task-shaped, so every gate fires and is timed too. */
      long:
        'Add a `SavedAt` DateTime property to the Snapshot record (src/WinOptimizer/Core/Snapshot.cs) and make ' +
        'SnapshotStore.Save set it to DateTime.UtcNow before the snapshot is serialised. Keep the JSON round-trip ' +
        'working: SnapshotStore.Load must read the value back. Add one xunit test in SnapshotStoreTests that saves ' +
        'a snapshot and asserts SavedAt is within a minute of now after loading it again. Do not change any other ' +
        'behaviour and do not touch the ViewModels.',
    },
  },
  blackport: {
    folders: [
      {
        name: 'backend',
        from: 'D:\\Projects\\black-port\\src\\backend',
        skip: /[\\/](\.git|\.privatecode)([\\/]|$)/,
        access: 'write',
      },
      {
        name: 'frontend',
        from: 'D:\\Projects\\black-port\\src\\frontend',
        skip: /[\\/](node_modules|\.next|\.git|\.privatecode)([\\/]|$)/,
        access: 'write',
      },
    ],
    dotnetProjects: [
      'BlackPort.Api', 'BlackPort.Application', 'BlackPort.Domain', 'BlackPort.Infrastructure', 'BlackPort.Tests',
    ].map((p) => `backend/${p}`),
    verify: {
      backend: 'dotnet build BlackPort.Api/BlackPort.Api.csproj --no-restore --nologo -v q',
    },
    buildCheck: [
      { folder: 'backend', args: ['build', 'BlackPort.Api/BlackPort.Api.csproj', '--nologo', '-v', 'q'] },
    ],
    tasks: {
      short:
        'Add GET api/crm/leads/count-by-status to LeadsController returning {statusId, statusName, count} per status ' +
        'for the leads the current user may see, ordered by count descending; put LeadStatusCountDto in LeadDtos.cs.',
      long:
        'In the backend, add an endpoint GET api/crm/leads/count-by-status to LeadsController. For the leads the ' +
        'current user is allowed to see — everyone with LeadsViewAll sees all of them, anyone else only the leads ' +
        'assigned to them, and merged leads never count — return a list of { statusId, statusName, count }, ordered ' +
        'by count descending. Define the DTO as a record LeadStatusCountDto in BlackPort.Application/DTOs/Crm/LeadDtos.cs ' +
        'beside the other lead DTOs. Do not change any existing endpoint and do not touch the frontend.',
    },
  },
}

interface Row {
  t: number
  kind: 'step-start' | 'step-done' | 'tool-call' | 'tool-result' | 'stage' | 'verify' | 'acceptance' | 'text' | 'warm'
  detail: string
  seconds?: number
  promptTokens?: number
  completionTokens?: number
  chars?: number
}

/**
 * A copy that BUILDS without the network. `obj/` carries the restore assets, and they name
 * the original folder by absolute path — left alone, MSBuild decides the project moved,
 * re-restores, and hangs on NuGet. Rewriting the path in every TEXT file under `obj/` makes
 * `dotnet build` in the copy the two-second incremental build it is in the original.
 * Binary caches (`*.cache`) are deleted rather than rewritten — rewriting one as text broke
 * `dotnet test` with "Could not read state file ... AssemblyReference.cache".
 */
function makeWorkspace(shape: Shape): { root: string; mounts: Mount[] } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-speed-'))
  const mounts: Mount[] = []
  for (const [i, folder] of shape.folders.entries()) {
    const to = join(dir, folder.name)
    cpSync(folder.from, to, { recursive: true, filter: (p) => !folder.skip.test(p) })
    for (const rel of shape.dropInCopy?.[folder.name] ?? []) {
      if (existsSync(join(to, rel))) unlinkSync(join(to, rel))
    }
    mounts.push({ name: folder.name, root: to, access: folder.access, primary: i === 0 })
    const escapedOld = JSON.stringify(folder.from).slice(1, -1)
    const escapedNew = JSON.stringify(to).slice(1, -1)
    const rewrite = (dirPath: string): void => {
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        const p = join(dirPath, entry.name)
        if (entry.isDirectory()) { rewrite(p); continue }
        if (/\.cache$/i.test(entry.name)) { unlinkSync(p); continue }
        if (!/\.(json|props|targets|txt|g\.cs|AssemblyInfo\.cs|editorconfig)$/i.test(entry.name)) continue
        if (statSync(p).size > 5_000_000) continue
        const before = readFileSync(p, 'utf8')
        const after = before.split(escapedOld).join(escapedNew).split(folder.from).join(to)
        if (after !== before) writeFileSync(p, after, 'utf8')
      }
    }
    for (const proj of shape.dotnetProjects) {
      if (!proj.startsWith(`${folder.name}/`) && shape.folders.length > 1) continue
      const rel = shape.folders.length > 1 ? proj.slice(folder.name.length + 1) : proj
      const obj = join(to, rel, 'obj')
      if (existsSync(obj)) rewrite(obj)
    }
  }
  mkdirSync(join(mounts[0]!.root, '.privatecode'), { recursive: true })
  return { root: mounts[0]!.root, mounts }
}

function compactArgs(name: string, args: string): string {
  try {
    const a = JSON.parse(args)
    const bits: string[] = []
    for (const k of ['path', 'pattern', 'glob', 'action', 'symbol', 'start_line', 'end_line', 'role']) {
      if (a[k] !== undefined) bits.push(`${k}=${String(a[k]).slice(0, 60)}`)
    }
    if (name === 'edit_file') bits.push(`search=${(a.search_text ?? '').length}ch replace=${(a.replace_text ?? '').length}ch`)
    if (name === 'write_file') bits.push(`content=${(a.content ?? '').length}ch`)
    if (name === 'run_command') bits.push(`cmd=${String(a.command ?? JSON.stringify(a.commands ?? '')).slice(0, 60)}`)
    return bits.join(' ')
  } catch {
    return args.slice(0, 60)
  }
}

/** `--build-check`: make the copy, build and test it the way the model would, and stop. */
function buildCheck(shape: Shape): void {
  const { mounts } = makeWorkspace(shape)
  console.log(`copy at ${mounts[0]!.root}`)
  for (const job of shape.buildCheck) {
    const cwd = mounts.find((m) => m.name === job.folder)!.root
    const started = Date.now()
    const r = spawnSync('dotnet', job.args, { cwd, encoding: 'utf8', timeout: 240_000, shell: true })
    console.log(`dotnet ${job.args.join(' ')} -> exit ${r.status} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    console.log((r.stdout + r.stderr).split('\n').filter((l) => !/warning CS/.test(l)).slice(-8).join('\n'))
  }
  if (!KEEP) rmSync(join(mounts[0]!.root, '..'), { recursive: true, force: true })
}

async function main(): Promise<void> {
  const shape = SHAPES[WORKSPACE]
  if (shape === undefined) throw new Error(`unknown --workspace ${WORKSPACE}; one of ${Object.keys(SHAPES).join(', ')}`)
  if (process.argv.includes('--build-check')) { buildCheck(shape); return }
  const task = shape.tasks[TASK]
  if (task === undefined) throw new Error(`unknown --task ${TASK}; one of ${Object.keys(shape.tasks).join(', ')}`)
  const { root, mounts } = makeWorkspace(shape)
  const rows: Row[] = []
  let t0 = Date.now()
  const at = (): number => (Date.now() - t0) / 1000
  const log = (row: Row): void => {
    rows.push(row)
    const extra = [
      row.seconds !== undefined ? `${row.seconds.toFixed(1)}s` : '',
      row.promptTokens !== undefined ? `prompt=${row.promptTokens}` : '',
      row.completionTokens !== undefined ? `gen=${row.completionTokens}` : '',
      row.chars !== undefined ? `${row.chars}ch` : '',
    ].filter(Boolean).join(' ')
    console.log(`${row.t.toFixed(1).padStart(7)}s  ${row.kind.padEnd(11)} ${row.detail}${extra ? '  [' + extra + ']' : ''}`)
  }

  const mapStarted = Date.now()
  const repoMap = await buildRepoMap(mounts.length > 1 ? mounts : root)
  console.log(`repo map: ${repoMap.length} chars in ${Date.now() - mapStarted} ms`)
  console.log(repoMap.split('\n').slice(0, 40).join('\n'))
  console.log('...\n')

  const toolset = createToolset({ workspaceRoot: root })
  const verifyFolders: Record<string, { command: string; timeoutMs: number; source: string }> = {}
  for (const [name, command] of Object.entries(shape.verify)) {
    verifyFolders[name] = { command, timeoutMs: 240_000, source: 'probe' }
  }
  const opts: SessionOptions = {
    client: new LlamaClient({ baseUrl: process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080', model: 'kat' }),
    toolset,
    workspaceRoot: root,
    ...(mounts.length > 1 ? { mounts } : {}),
    mode: 'autopilot',
    repoMap,
    ...(GATES !== 'thorough' ? { gates: GATES } : {}),
    compaction: { contextLength: 196_608, triggerTokens: 140_000 },
    // The owner's settings would name the project's REAL check; the model reads the command's
    // name in the "[...: ok]" line. Incremental, no restore, a few seconds on this machine.
    ...(mounts.length > 1
      ? { verifyFolders }
      : { verify: verifyFolders[mounts[0]!.name]! }),
    onVerify: (i) => log({ t: at(), kind: 'verify', detail: `${i.folder ? `${i.folder}: ` : ''}${i.ok ? 'ok' : 'FAIL'} attempt ${i.attempt}` }),
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
      async requestApproval(req: ApprovalRequest) {
        log({ t: at(), kind: 'text', detail: `approval auto-allowed: ${req.tool}` })
        return { verdict: 'allow' as const }
      },
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
        t: at(), kind: 'step-done', detail: `step ${i.step}${i.continued ? ' (continued)' : ''}`,
        seconds: i.seconds,
        ...(i.promptTokens !== undefined ? { promptTokens: i.promptTokens } : {}),
        ...(i.completionTokens !== undefined ? { completionTokens: i.completionTokens } : {}),
      }),
      onToolCall: (name, args, agent) => log({
        t: at(), kind: 'tool-call', detail: `${agent ? `[${agent}] ` : ''}${name}(${compactArgs(name, args)})`,
      }),
      onToolResult: (name, result, _id, agent) => log({
        t: at(), kind: 'tool-result', detail: `${agent ? `[${agent}] ` : ''}${name} ${result.ok ? 'ok' : 'FAILED'}: ${result.content.replace(/\s+/g, ' ').slice(0, 70)}`,
        chars: result.content.length,
      }),
      onAssistantText: (text) => log({ t: at(), kind: 'text', detail: `assistant: ${text.replace(/\s+/g, ' ').slice(0, 140)}`, chars: text.length }),
    },
  }

  const session = new Session(opts)

  // The warm-up the host runs at workspace open, while the person is still typing. Off the
  // clock, and reported separately; a tree without the method (the BEFORE worktree) skips it.
  let warmSeconds: number | null = null
  const warmable = session as unknown as { warmPrefix?: () => Promise<void> }
  if (WARM && typeof warmable.warmPrefix === 'function') {
    const warmStarted = Date.now()
    await warmable.warmPrefix()
    warmSeconds = (Date.now() - warmStarted) / 1000
    console.log(`prefix warmed in ${warmSeconds.toFixed(1)} s (off the clock)\n`)
  }

  console.log(`=== ${LABEL} / ${WORKSPACE} / ${TASK}: ${task}\n`)
  t0 = Date.now()
  const result = await session.send(task)
  const total = at()

  // The numbers that matter, computed rather than eyeballed.
  const firstWrite = rows.find((r) => r.kind === 'tool-call' && /^(\[[^\]]+\] )?(edit_file|write_file)\(/.test(r.detail))
  const stepsBeforeWrite = firstWrite ? rows.filter((r) => r.kind === 'step-start' && r.t < firstWrite.t).length : null
  const isRead = (d: string): boolean => /^(\[[^\]]+\] )?(read_file|list_dir|find_files|search_code|symbol_outline|csharp_nav|git_status)\(/.test(d)
  const readCalls = rows.filter((r) => r.kind === 'tool-call' && isRead(r.detail))
  const readCallsBeforeWrite = readCalls.filter((r) => firstWrite === undefined || r.t < firstWrite.t)
  const readCharsBeforeWrite = rows
    .filter((r) => r.kind === 'tool-result' && (firstWrite === undefined || r.t < firstWrite.t))
    .reduce((n, r) => n + (r.chars ?? 0), 0)
  const stageMs: Record<string, number> = {}
  for (const r of rows) {
    if (r.kind === 'stage' && r.seconds !== undefined) {
      const name = r.detail.split(' ')[0]!
      stageMs[name] = (stageMs[name] ?? 0) + r.seconds
    }
  }
  const stepSeconds = rows.filter((r) => r.kind === 'step-done').map((r) => r.seconds ?? 0)
  const modelSeconds = stepSeconds.reduce((a, b) => a + b, 0)
  const firstStep = rows.find((r) => r.kind === 'step-done')
  const lastPrompt = [...rows].reverse().find((r) => r.promptTokens !== undefined)?.promptTokens
  const gen = rows.reduce((n, r) => n + (r.completionTokens ?? 0), 0)
  const selfChecks = rows.filter((r) => r.kind === 'tool-call' && /run_command\(.*cmd=.*dotnet (build|test)/.test(r.detail)).length

  const summary = {
    label: LABEL, workspace: WORKSPACE, task: TASK, gates: GATES,
    stoppedBecause: result.stoppedBecause, steps: result.steps,
    warmSeconds,
    totalSeconds: Number(total.toFixed(1)),
    firstStepSeconds: firstStep?.seconds !== undefined ? Number(firstStep.seconds.toFixed(1)) : null,
    secondsToFirstWrite: firstWrite ? Number(firstWrite.t.toFixed(1)) : null,
    stepsBeforeFirstWrite: stepsBeforeWrite,
    readCallsBeforeFirstWrite: readCallsBeforeWrite.length,
    readCalls: readCalls.length,
    readCharsBeforeFirstWrite: readCharsBeforeWrite,
    modelSelfChecks: selfChecks,
    modelSecondsInSteps: Number(modelSeconds.toFixed(1)),
    gateSeconds: stageMs,
    generatedTokens: gen,
    finalPromptTokens: lastPrompt ?? null,
    repoMapChars: repoMap.length,
    toolCounts: Object.fromEntries(
      [...rows.filter((r) => r.kind === 'tool-call')
        .reduce((m, r) => {
          const name = r.detail.replace(/^\[[^\]]+\] /, '').split('(')[0]!
          return m.set(name, (m.get(name) ?? 0) + 1)
        }, new Map<string, number>())].sort(),
    ),
  }
  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`\nfinal text: ${result.finalText.replace(/\s+/g, ' ').slice(0, 400)}`)

  const outDir = new URL('./speed-results/', import.meta.url)
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outFile = new URL(`./speed-results/${LABEL}-${WORKSPACE}-${TASK}-${stamp}.json`, import.meta.url)
  writeFileSync(outFile, JSON.stringify({ summary, rows, finalText: result.finalText }, null, 1), 'utf8')
  console.log(`\nwritten: ${outFile.pathname}`)

  await toolset.background.stopAll()
  await toolset.browser.close()
  await toolset.webRenderer.close()
  if (!KEEP) removeCopy(join(root, '..'))
  else console.log(`workspace kept at ${root}`)
}

/**
 * The copy goes, and the build servers MSBuild left behind go first: node reuse and
 * VBCSCompiler keep the copy's files open for minutes after the last build, and `rmSync`
 * against them throws EPERM — which took a whole measurement chain down once, because the
 * probe's non-zero exit was the last thing the chain script saw. Never throws.
 */
function removeCopy(dir: string): void {
  try { spawnSync('dotnet', ['build-server', 'shutdown'], { timeout: 60_000, shell: true, stdio: 'ignore' }) } catch { /* best effort */ }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { timeout: 10_000 })
    }
  }
  console.log(`could not remove ${dir}; leaving it`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
