/**
 * `move_file` between two folders of a workspace that live on DIFFERENT volumes.
 *
 * A multi-drive workspace is a designed shape — `FolderSpec` says a folder is named
 * "absolute otherwise" — and `rename(2)` cannot cross a device. What the failure used to
 * leave behind is the interesting half: the destination directory chain, created before the
 * rename was attempted, against a comment that says a failed call must not mutate anything.
 *
 *   npx tsx spike/move-across-drives-probe.mts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveFileTool } from '../core/src/tools/move-file.js'
import { Workspace } from '../core/src/workspace.js'

// The primary lands wherever the OS puts temp files; the second is forced onto D:.
const primary = mkdtempSync(join(tmpdir(), 'pc-move-c-'))
const otherRoot = 'D:\\pc-probe-tmp'
mkdirSync(otherRoot, { recursive: true })
const second = mkdtempSync(join(otherRoot, 'pc-move-d-'))

mkdirSync(join(primary, 'src'), { recursive: true })
writeFileSync(join(primary, 'src', 'a.ts'), 'export const a = 1\n')

const ws = new Workspace([
  { name: 'appC', root: primary, primary: true, access: 'write' },
  { name: 'appD', root: second, primary: false, access: 'write' },
])
console.log(`appC = ${primary}`)
console.log(`appD = ${second}`)
console.log(`same volume? ${primary[0]?.toLowerCase() === second[0]?.toLowerCase()}`)

const destDirs = join(second, 'lib', 'deep')
console.log(`dest dirs before : ${existsSync(destDirs)}`)

const result = await moveFileTool.execute(
  { from: 'appC/src/a.ts', to: 'appD/lib/deep/a.ts' },
  { workspace: ws } as never,
)
console.log(`move             : ${result.ok} | ${result.content}`)
console.log(`source still there? ${existsSync(join(primary, 'src', 'a.ts'))}`)
console.log(`dest file there?    ${existsSync(join(destDirs, 'a.ts'))}`)
if (existsSync(join(destDirs, 'a.ts'))) {
  console.log(`dest bytes          ${JSON.stringify(readFileSync(join(destDirs, 'a.ts'), 'utf8'))}`)
}

// And the leak: after a move that FAILS, no directory this call created may survive.
writeFileSync(join(primary, 'src', 'b.ts'), 'export const b = 2\n')
const failDirs = join(second, 'never', 'created')
const fail = await moveFileTool.execute(
  // `<` is not a legal character in a Windows filename, so the parent chain is created and
  // the rename then fails -- which is the shape that used to leave the chain behind.
  { from: 'appC/src/b.ts', to: 'appD/never/created/a<b.ts' },
  { workspace: ws } as never,
)
console.log(`\nrefused move     : ${fail.ok} | ${fail.content}`)
console.log(`dirs left behind?  ${existsSync(failDirs)}`)

rmSync(primary, { recursive: true, force: true })
rmSync(second, { recursive: true, force: true })
