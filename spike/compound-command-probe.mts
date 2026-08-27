/**
 * What the model is told when the first half of `cd somewhere; build` fails.
 *
 * Reported: the model writes `cd somewhere; dotnet build ...`, the `cd` fails, the build
 * runs anyway — and the reply looks like a success. If that is what happens, the harness is
 * telling the model a build passed when it built a different project, which is worse than
 * any wasted round trip.
 *
 *   npx tsx spike/compound-command-probe.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommandTool } from '../core/src/tools/run-command.js'
import type { Mount } from '../core/src/mounts.js'
import { Workspace } from '../core/src/workspace.js'

const base = mkdtempSync(join(tmpdir(), 'pc-compound-'))
const app = join(base, 'app')
const engine = join(base, 'engine')
mkdirSync(app, { recursive: true })
mkdirSync(engine, { recursive: true })
writeFileSync(join(app, 'who.txt'), 'app\n', 'utf8')
writeFileSync(join(engine, 'who.txt'), 'engine\n', 'utf8')

const mounts: Mount[] = [
  { name: 'app', root: app, access: 'write', primary: true },
  { name: 'engine', root: engine, access: 'write', primary: false },
]
const ctx = { workspace: new Workspace(mounts) }

async function run(command: string): Promise<void> {
  const v = runCommandTool.validate({ command })
  if (!v.ok) { console.log(`   REFUSED: ${v.error}`); return }
  const r = await runCommandTool.execute(v.args, ctx)
  console.log(`   ok=${r.ok}`)
  for (const line of r.content.split('\n')) console.log(`   | ${line}`)
}

console.log('1. the shape the model writes, with a folder that does not exist there:')
await run('cd engine; Get-Content who.txt')

console.log('\n2. the same, with the folder-prefixed spelling it was taught for tool args:')
await run('cd app/engine; Get-Content who.txt')

console.log('\n3. a cd that WORKS, for comparison:')
await run('cd ../engine; Get-Content who.txt')

console.log('\n4. and what the exit code says when only the FIRST half fails:')
await run('cd nowhere-at-all; Write-Output "the second half ran"')

rmSync(base, { recursive: true, force: true })
