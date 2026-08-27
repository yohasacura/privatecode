/**
 * Where does a command actually run when the workspace is several folders?
 *
 * The report: on a multi-folder workspace the model burns three or four commands working out
 * where it is and what path to give `dotnet build`. The file tools teach one path language
 * (`engine/src/x.cs` — every path starts with a folder name, a bare `src/x.cs` is refused),
 * and this asks whether a COMMAND lives in the same language or a different one.
 *
 *   npx tsx spike/multi-folder-cwd-probe.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommandTool } from '../core/src/tools/run-command.js'
import type { Mount } from '../core/src/mounts.js'
import { Workspace } from '../core/src/workspace.js'

const base = mkdtempSync(join(tmpdir(), 'pc-cwd-probe-'))
const app = join(base, 'app')
const engine = join(base, 'engine')
mkdirSync(join(app, 'src'), { recursive: true })
mkdirSync(join(engine, 'src'), { recursive: true })
writeFileSync(join(engine, 'Engine.csproj'), '<Project />\n', 'utf8')
writeFileSync(join(app, 'App.csproj'), '<Project />\n', 'utf8')

const mounts: Mount[] = [
  { name: 'app', root: app, access: 'write', primary: true },
  { name: 'engine', root: engine, access: 'write', primary: false },
]
const ctx = { workspace: new Workspace(mounts) }

async function run(args: Record<string, unknown>): Promise<string> {
  const v = runCommandTool.validate(args)
  if (!v.ok) return `REFUSED AT VALIDATE: ${v.error}`
  const r = await runCommandTool.execute(v.args, ctx)
  return `${r.ok ? 'ok  ' : 'FAIL'} ${r.content.replace(/\s+/g, ' ').slice(0, 110)}`
}

console.log(`workspace: app=${app}`)
console.log(`           engine=${engine}\n`)

console.log('1. where does a bare command start?')
console.log('   ', await run({ command: '(Get-Location).Path' }))

console.log('\n2. the path language the FILE tools teach, used inside a command:')
console.log('   ', await run({ command: 'Test-Path engine/Engine.csproj' }))

console.log('\n3. the same file, addressed the way the shell actually needs it:')
console.log('   ', await run({ command: 'Test-Path ../engine/Engine.csproj' }))

console.log('\n4. cwd given as a folder name:')
console.log('   ', await run({ command: '(Get-Location).Path', cwd: 'engine' }))

console.log('\n5. cwd given the way a single-folder workspace would:')
console.log('   ', await run({ command: '(Get-Location).Path', cwd: 'src' }))

rmSync(base, { recursive: true, force: true })
