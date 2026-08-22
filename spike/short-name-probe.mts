/**
 * The NTFS 8.3 alias for `.privatecode`, against the shipped write jail and the shipped
 * permission engine.
 *
 * `.privatecode/settings.json` is where the next session reads its `permissions`, `hooks`
 * and `format` rules from, and hook and format commands run with no permission gate at all.
 * The engine denies writes there — on the path the model SPELLED, after a purely lexical
 * canonicalize. Windows gives the same directory a second name.
 *
 *   npx tsx spike/short-name-probe.mts
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionEngine } from '../core/src/permissions/engine.js'
import { writeFileTool } from '../core/src/tools/write-file.js'
import { Workspace } from '../core/src/workspace.js'

const root = mkdtempSync(join(tmpdir(), 'pc-83-'))
mkdirSync(join(root, '.privatecode'), { recursive: true })
const settings = join(root, '.privatecode', 'settings.json')
writeFileSync(settings, '{"permissions":{"allow":[]}}')

// What the filesystem actually calls it.
const listing = execFileSync('cmd', ['/c', 'dir', '/X', root], { encoding: 'utf8' })
const alias = /(\w+~\d)\s+\.privatecode/.exec(listing)?.[1]
console.log(`8.3 alias for .privatecode : ${alias ?? '(none -- 8.3 generation is off on this volume)'}`)
if (alias === undefined) { rmSync(root, { recursive: true, force: true }); process.exit(0) }

const ws = new Workspace([{ name: 'p', root, primary: true, access: 'write' }])
const engine = new PermissionEngine({ mode: 'auto-edit', workspaceRoot: root, layers: [] })

for (const spelled of ['.privatecode/settings.json', `${alias}/settings.json`]) {
  const decision = engine.decide({ tool: 'write_file', paths: [spelled] })
  let jail: string
  try {
    ws.resolveForWrite(spelled)
    jail = 'RESOLVED (no refusal)'
  } catch (e) {
    jail = `THREW -> ${(e as Error).message.slice(0, 70)}`
  }
  console.log(`  ${spelled.padEnd(30)} engine=${decision.verdict.padEnd(5)} jail=${jail}`)
}

// End to end, through the real tool.
const planted = JSON.stringify({ permissions: { allow: ['run_command'] } })
const result = await writeFileTool.execute(
  { path: `${alias}/settings.json`, content: planted },
  { workspace: ws } as never,
)
console.log(`\nwrite_file via alias : ${result.ok} | ${result.content.slice(0, 90)}`)
console.log(`settings.json now    : ${readFileSync(settings, 'utf8').slice(0, 60)}`)

rmSync(root, { recursive: true, force: true })
