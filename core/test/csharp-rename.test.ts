import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { csharpRenameTool } from '../src/tools/csharp-rename.js'
import { csharpNavTool } from '../src/tools/csharp-nav.js'
import { ReadMemory } from '../src/tools/read-memory.js'
import { stopNavProcess } from '../src/csharp/nav-process.js'
import { Workspace } from '../src/workspace.js'

/**
 * The rename tool against the vendored helper on a real tree: every file that uses the
 * symbol is rewritten, byte-order marks and CRLF survive, the index answers about the new
 * name at once, and the compiler check rides on the result. Refusals come back as text.
 */

const EXE = join(dirname(new URL(import.meta.url).pathname.slice(1)), '..', '..', 'vendor', 'roslyn', 'roslyn-nav.exe')
const vendored = existsSync(EXE)

let root: string
const ctx = () => ({ workspace: new Workspace(root), reads: new ReadMemory() })

beforeAll(() => {
  if (!vendored) return
  process.env['PRIVATECODE_ROSLYN'] = EXE
  root = mkdtempSync(join(tmpdir(), 'pc-rename-'))
  const write = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  // CRLF and a BOM on one file: the rename must give them back exactly.
  write('src/IPlanner.cs', '﻿namespace App;\r\npublic interface IPlanner { void Build(); }\r\n')
  write('src/Planner.cs', 'namespace App;\npublic sealed class Planner : IPlanner { public void Build() { } }\n')
  write('src/Main.cs', [
    'namespace App;',
    'public sealed class Main',
    '{',
    '    private readonly IPlanner _planner;',
    '    public Main(IPlanner planner) { _planner = planner; }',
    '    // Build the plan — a comment that says the word and is not a use of it.',
    '    public void Run() => _planner.Build();',
    '    public string Label => "Build";',
    '}',
  ].join('\n') + '\n')
})

afterAll(async () => {
  if (!vendored) return
  await stopNavProcess()
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!vendored)('CSharpRename', () => {
  test('renames the symbol in every file, keeps each file\'s bytes, and reports the compiler\'s verdict', async () => {
    const c = ctx()
    const r = await csharpRenameTool.execute({ symbol: 'IPlanner.Build', new_name: 'Compose' }, c)
    expect(r.ok).toBe(true)
    expect(r.content).toContain('Renamed')
    expect(r.content).toContain('3 files')
    expect(r.wrote?.sort()).toEqual(['src/IPlanner.cs', 'src/Main.cs', 'src/Planner.cs'])
    expect(r.content).toContain('C# compiler check: ok')

    const iface = readFileSync(join(root, 'src', 'IPlanner.cs'))
    expect([...iface.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(iface.toString('utf8')).toBe('﻿namespace App;\r\npublic interface IPlanner { void Compose(); }\r\n')
    const main = readFileSync(join(root, 'src', 'Main.cs'), 'utf8')
    expect(main).toContain('_planner.Compose()')
    // The comment and the string still say Build: a word is not a use.
    expect(main).toContain('// Build the plan')
    expect(main).toContain('"Build"')
    expect(readFileSync(join(root, 'src', 'Planner.cs'), 'utf8')).toContain('public void Compose()')

    // The index knows the new name without a reload.
    const refs = await csharpNavTool.execute({ action: 'references', symbol: 'Compose' }, c)
    expect(refs.ok).toBe(true)
    expect(refs.content).toContain('[Main.Run]')
  })

  test('a name it does not know is refused with the closest ones; a bad identifier at validation', async () => {
    const r = await csharpRenameTool.execute({ symbol: 'Compos', new_name: 'Assemble' }, ctx())
    expect(r.ok).toBe(false)
    expect(r.content).toContain('Close names')
    expect(r.content).toContain('Compose')
    expect(csharpRenameTool.validate({ symbol: 'Compose', new_name: 'not an identifier' }).ok).toBe(false)
  })

  test('errors and hierarchy answer through the tool', async () => {
    const c = ctx()
    const clean = await csharpNavTool.execute({ action: 'errors', symbol: '' }, c)
    expect(clean.ok).toBe(true)
    expect(clean.content).toMatch(/^No compile errors/)
    const h = await csharpNavTool.execute({ action: 'hierarchy', symbol: 'IPlanner' }, c)
    expect(h.content).toContain('interface IPlanner')
    expect(h.content).toContain('Planner (App)')
    const d = await csharpNavTool.execute({ action: 'definition', symbol: 'Run' }, c)
    expect(d.content).toContain('public void Run() => _planner.Compose();')
    const miss = await csharpNavTool.execute({ action: 'definition', symbol: 'Runn' }, c)
    expect(miss.content).toContain('Close names')
    const wild = await csharpNavTool.execute({ action: 'definition', symbol: '*Planner' }, c)
    expect(wild.content).toContain('names matching *Planner')
  })
})
