/**
 * What a diagnosis LOOKS like when there is something wrong to find.
 *
 * The live workspace has no failures in it, which is the right report and a useless
 * demonstration. This builds a transcript with the failures this project has actually
 * watched — a path guessed one folder too deep, a shell operator that shell does not have,
 * a command retried unchanged — and prints the report, so the shape can be judged before
 * anybody has to trust it with real work.
 *
 *   npx tsx spike/doctor-stories.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnose, renderDiagnosis } from '../core/src/doctor/diagnose.js'
import type { SessionMeta } from '../core/src/session/store.js'

const root = mkdtempSync(join(tmpdir(), 'pc-stories-'))
mkdirSync(join(root, '.privatecode', 'state', 'sessions'), { recursive: true })

const lines: unknown[] = []
const outcomes: { id: string; ok: boolean }[] = []
let n = 0
const call = (name: string, args: unknown): string => {
  const id = `c${n++}`
  lines.push({
    role: 'assistant',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  })
  return id
}
const result = (id: string, ok: boolean, content: string): void => {
  lines.push({ role: 'tool', tool_call_id: id, content })
  outcomes.push({ id, ok })
}

// 1. The multi-folder mistake: a leading folder that is not there, dropped on the retry.
for (const file of ['Program.cs', 'Startup.cs', 'Ledger.cs']) {
  result(call('read_file', { path: `src/Engine/${file}` }), false, `File not found: src/Engine/${file}`)
  result(call('read_file', { path: `Engine/${file}` }), true, `1\tnamespace Engine;`)
}

// 2. The shell habit: `&&` in a shell that has no such operator, then `;`.
for (let i = 0; i < 2; i++) {
  result(
    call('run_command', { commands: [`cd Engine && dotnet build`] }), false,
    "The token '&&' is not a valid statement separator in this version.",
  )
  result(call('run_command', { commands: ['cd Engine; dotnet build'] }), true, 'Build succeeded.')
}

// 3. A failure it learns nothing from: the same command, three times.
for (let i = 0; i < 3; i++) {
  result(call('run_command', { commands: ['dotnet test'] }), false, 'exit 1: 2 tests failed')
}

writeFileSync(
  join(root, '.privatecode', 'state', 'sessions', 'demo.jsonl'),
  lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8',
)
writeFileSync(
  join(root, '.privatecode', 'state', 'sessions', 'demo.ui.jsonl'),
  outcomes.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8',
)

const meta: SessionMeta = {
  id: 'demo', title: 'a confidential thing', createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-05T10:00:00.000Z', workspaceRoot: root, mode: 'normal',
}

console.log(renderDiagnosis(diagnose(root, [meta])))
rmSync(root, { recursive: true, force: true })
