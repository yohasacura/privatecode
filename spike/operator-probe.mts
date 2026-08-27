/**
 * What the model is told when it writes `&&` for a shell that has no `&&`.
 *
 * Windows PowerShell 5.1 is the shell every command here runs in (`powershell.exe`, not
 * `pwsh`), and it has no pipeline chain operators — they arrived in PowerShell 7. So
 * `npm install && npm test` is not a command that fails, it is a command that never parses.
 *
 *   npx tsx spike/operator-probe.mts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommandTool } from '../core/src/tools/run-command.js'
import { Workspace } from '../core/src/workspace.js'

const root = mkdtempSync(join(tmpdir(), 'pc-op-'))
const ctx = { workspace: new Workspace(root) }

async function run(label: string, command: string): Promise<void> {
  const v = runCommandTool.validate({ command })
  if (!v.ok) { console.log(`${label}\n   REFUSED: ${v.error}\n`); return }
  const r = await runCommandTool.execute(v.args, ctx)
  console.log(`${label}`)
  console.log(`   ok=${r.ok}`)
  for (const line of r.content.split('\n').slice(0, 8)) console.log(`   | ${line}`)
  console.log()
}

await run('1. the shape the model writes:', 'Write-Output first && Write-Output second')
await run('2. the same with ||:', 'cmd /c exit 1 || Write-Output fallback')
await run('3. what it should have written:', 'Write-Output first; Write-Output second')
await run('4. and the conditional it actually meant:',
  'Write-Output first; if ($LASTEXITCODE -eq 0) { Write-Output second }')

rmSync(root, { recursive: true, force: true })
