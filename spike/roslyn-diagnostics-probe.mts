/**
 * How faithful and how fast the helper's `diagnostics` is on a real project.
 *
 *   npx tsx spike/roslyn-diagnostics-probe.mts --workspace winopt|blackport
 *
 * Loads the helper over a COPY of the project (the originals are never written to), reports
 * the load, the baseline (how many errors the ad-hoc compilation has that the real build
 * does not — the number that decides whether the check is usable), then plants one error in
 * a file, syncs it and times the diagnostics; then removes it and times the all-clear.
 * Compared against the project's own `dotnet build` on the same copy.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NavProcess, resolveHelper } from '../core/src/csharp/nav-process.js'
import { SHAPES, makeWorkspace, removeCopy, runIn } from '../eval/workspace.js'

function argAfter(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}

const WORKSPACE = argAfter('--workspace', 'winopt')
const PLANT: Record<string, { folder: string; file: string; from: string; to: string }> = {
  winopt: {
    folder: 'WindowsOptimizer', file: 'src/WinOptimizer/Core/OptimizationPlanner.cs',
    from: 'config ??= new AppConfig();', to: 'config ??= new AppConfigg();',
  },
  blackport: {
    folder: 'backend', file: 'BlackPort.Domain/Entities/QuoteLine.cs',
    from: 'public decimal Amount { get; set; }', to: 'public decimall Amount { get; set; }',
  },
}

async function main(): Promise<void> {
  const shape = SHAPES[WORKSPACE]
  const plant = PLANT[WORKSPACE]
  if (shape === undefined || plant === undefined) throw new Error(`unknown workspace ${WORKSPACE}`)
  const exe = resolveHelper(process.env['PRIVATECODE_ROSLYN'], join(process.cwd(), 'core', 'src', 'csharp'))
  if (exe === null) throw new Error('no helper')
  const { root, mounts } = makeWorkspace(shape)
  const folderRoot = mounts.find((m) => m.name === plant.folder)!.root
  console.log(`copy at ${root}`)
  const nav = new NavProcess(exe)
  try {
    let t = Date.now()
    const loaded = await nav.ensureLoaded(folderRoot)
    console.log(`load: ${(Date.now() - t) / 1000}s  ${JSON.stringify({ ...loaded, problems: undefined })}`)
    console.log(`  problems: ${JSON.stringify(loaded['problems'])}`)

    t = Date.now()
    const first = await nav.diagnostics(folderRoot, [])
    console.log(`diagnostics (clean tree): ${(Date.now() - t) / 1000}s  ${JSON.stringify({ ...first, errors: first?.errors.length })}`)

    if (process.argv.includes('--dump')) {
      const status = await nav.ask('status', {})
      console.log(`references: ${JSON.stringify(status['references'])}`)
      const generated = (status['generated'] as string[] | undefined) ?? []
      console.log(`generated documents (${generated.length}):`)
      for (const g of generated) console.log(`  ${g.replace(folderRoot, '')}`)
      const all = await nav.ask('diagnostics', { all: true })
      const rows = (all['errors'] as { file: string | null; line: number; code: string; message: string }[]) ?? []
      console.log(`baseline sample (${rows.length} of ${String(all['reported'])}):`)
      for (const e of rows) console.log(`  · ${(e.file ?? '(no file)').replace(folderRoot, '')}:${e.line} ${e.code} ${e.message.slice(0, 320)}`)
    }

    const file = join(folderRoot, plant.file)
    const original = readFileSync(file, 'utf8')
    if (!original.includes(plant.from)) throw new Error(`plant anchor not found in ${plant.file}`)
    writeFileSync(file, original.replace(plant.from, plant.to), 'utf8')
    t = Date.now()
    const broken = await nav.diagnostics(folderRoot, [file])
    console.log(`diagnostics (one error planted): ${(Date.now() - t) / 1000}s  reported ${broken?.reported}, helper ms ${broken?.ms}, bound ${String(broken?.bound)} of ${String(broken?.trees)}`)
    for (const e of broken?.errors ?? []) console.log(`  ${e.file.split(/[\\/]/).pop()}:${e.line}:${e.column} ${e.code} ${e.message}`)

    writeFileSync(file, original, 'utf8')
    t = Date.now()
    const fixed = await nav.diagnostics(folderRoot, [file])
    console.log(`diagnostics (put back): ${(Date.now() - t) / 1000}s  reported ${fixed?.reported}, helper ms ${fixed?.ms}`)

    const command = shape.verify[plant.folder]!
    const b1 = runIn(folderRoot, command)
    console.log(`dotnet build (warm, clean): ${b1.seconds.toFixed(1)}s ok=${b1.ok}`)
    writeFileSync(file, original.replace(plant.from, plant.to), 'utf8')
    const b2 = runIn(folderRoot, command)
    console.log(`dotnet build (one error): ${b2.seconds.toFixed(1)}s ok=${b2.ok}`)
    writeFileSync(file, original, 'utf8')
  } finally {
    await nav.stop()
    removeCopy(join(root, '..'))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
