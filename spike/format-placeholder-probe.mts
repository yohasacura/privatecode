/**
 * Which `$FILE` spellings a format rule may actually use.
 *
 * `$FILE` is BOUND as a PowerShell variable rather than substituted as text (that is what
 * closed the command injection), which changed what a rule may say. Five of six spellings
 * survived the change; this asks the real loader and the real runner which.
 *
 *   npx tsx spike/format-placeholder-probe.mts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFormatRules } from '../core/src/format/config.js'
import { createFormatRunner } from '../core/src/format/runner.js'
import { Workspace } from '../core/src/workspace.js'

const SPELLINGS = ['$FILE', '"$FILE"', "'$FILE'", '${FILE}', '"${FILE}"', "'${FILE}'"]

for (const spelling of SPELLINGS) {
  const root = mkdtempSync(join(tmpdir(), 'pc-fmt-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  // A space in the filename, because that is the benign half of the same bug.
  writeFileSync(join(root, 'src', 'a b.ts'), 'const x=1\n')
  mkdirSync(join(root, '.privatecode'), { recursive: true })

  const recorder = join(root, 'rec.cjs').split('\\').join('/')
  const log = join(root, 'argv.log')
  writeFileSync(
    recorder,
    'const fs = require("fs")\n' +
    'fs.appendFileSync(' + JSON.stringify(log) + ', JSON.stringify(process.argv.slice(2)))\n',
  )
  writeFileSync(
    join(root, '.privatecode', 'settings.json'),
    JSON.stringify({ format: [{ match: '**/*.ts', command: 'node ' + recorder + ' ' + spelling }] }),
  )

  const loaded = loadFormatRules(root)
  const ws = new Workspace([{ name: 'p', root, primary: true, access: 'write' }])
  await createFormatRunner(loaded.rules, ws).run('src/a b.ts')
  const got = existsSync(log) ? readFileSync(log, 'utf8').trim() : '(never ran)'
  console.log(
    `  ${spelling.padEnd(11)} -> ${got.padEnd(20)} ` +
    `loaded=${loaded.rules.length} problems=${JSON.stringify(loaded.problems)}`,
  )
  rmSync(root, { recursive: true, force: true })
}
