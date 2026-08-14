import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

/**
 * The vendored Roslyn helper, driven directly over stdio.
 *
 * No model and no server are involved — it is a plain process that answers JSON — so this
 * runs anywhere the binary is vendored, and is skipped where it is not (a checkout without
 * the 98 MB blob is a legitimate state, and a red suite there would say nothing true).
 *
 * It exists because of a silent wrong answer. `PublishSingleFile` packs the runtime INSIDE
 * the exe, while `MetadataReferences` scanned the exe's own directory for `System.*.dll` to
 * find the base class library; those two settings contradict each other, the scan matched
 * nothing on every machine, and a compilation with no `System.Object` cannot classify a
 * base-type list. `class PlanItem : INotifyPropertyChanged` reported no interfaces and
 * `implementations` answered an empty list — with `ok: true` and `problems: []`, which is
 * the part that made it dangerous. Nothing about that was visible from the outside, which is
 * why the fixture below is a real C# tree rather than a mock: the bug lived in the seam
 * between the build settings and the compilation, and only a real binary crosses it.
 */

const EXE = join(dirname(new URL(import.meta.url).pathname.slice(1)), '..', '..',
  'vendor', 'roslyn', 'roslyn-nav.exe')
const vendored = existsSync(EXE)

interface Helper {
  ask(op: string, params?: Record<string, unknown>): Promise<Record<string, any>>
  stop(): void
}

function start(): Helper {
  const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map<number, (v: Record<string, any>) => void>()
  let buffer = ''
  let id = 0
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.trim() === '') continue
      let msg: Record<string, any>
      try { msg = JSON.parse(line) } catch { continue }
      const w = waiting.get(msg['id'])
      if (w) { waiting.delete(msg['id']); w(msg) }
    }
  })
  return {
    ask: (op, params = {}) => new Promise((resolve) => {
      const my = ++id
      waiting.set(my, resolve)
      child.stdin.write(`${JSON.stringify({ id: my, op, ...params })}\n`)
    }),
    stop: () => { child.kill() },
  }
}

/**
 * A WPF-shaped fixture: the exact arrangement the bug was invisible in. `PlanItem`
 * implements a BCL interface, `ViewModelBase` implements it too, and `MainViewModel`
 * inherits that implementation rather than declaring it — so a correct answer has to come
 * from the type system and cannot be produced by matching text.
 */
let root: string
let helper: Helper

beforeAll(async () => {
  if (!vendored) return
  root = mkdtempSync(join(tmpdir(), 'pc-roslyn-'))
  const write = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body, 'utf8')
  }
  write('src/Models.cs', [
    'using System.ComponentModel;',
    'namespace App;',
    'public sealed class PlanItem : INotifyPropertyChanged',
    '{',
    '    public event PropertyChangedEventHandler? PropertyChanged;',
    '    public string Name { get; set; } = "";',
    '    public int Order { get; set; }',
    '}',
  ].join('\n'))
  write('src/ViewModelBase.cs', [
    'using System.ComponentModel;',
    'namespace App;',
    'public abstract class ViewModelBase : INotifyPropertyChanged',
    '{',
    '    public event PropertyChangedEventHandler? PropertyChanged;',
    '}',
  ].join('\n'))
  write('src/MainViewModel.cs', [
    'namespace App;',
    'public sealed class MainViewModel : ViewModelBase',
    '{',
    '    private readonly IPlanner _planner;',
    '    public MainViewModel(IPlanner planner) { _planner = planner; }',
    '    public void Run() => _planner.Build();',
    '}',
  ].join('\n'))
  write('src/IPlanner.cs', [
    'namespace App;',
    'public interface IPlanner { void Build(); }',
  ].join('\n'))
  write('src/Planner.cs', [
    'namespace App;',
    'public sealed class Planner : IPlanner { public void Build() { } }',
  ].join('\n'))
  // Skipped by the loader, and here to prove it: a copy under `.claude\worktrees` used to be
  // loaded as a second, stale declaration of every type in the tree.
  write('.claude/worktrees/old/src/Planner.cs', [
    'namespace App;',
    'public sealed class Planner : IPlanner { public void Build() { } }',
  ].join('\n'))

  helper = start()
  // The first line read from stdin carries a BOM, which is not valid JSON. A sacrificial
  // request absorbs it so the load below is not the one that pays.
  await helper.ask('status')
})

afterAll(() => {
  if (!vendored) return
  helper?.stop()
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!vendored)('the vendored C# navigator', () => {
  test('loads a plain source tree — no .sln and no .csproj required', async () => {
    const loaded = await helper.ask('load', { root: root.replace(/\\/g, '/') })
    expect(loaded['ok']).toBe(true)
    // Five sources, not six: the worktree copy is skipped.
    expect(loaded['files']).toBe(5)
    // The BCL, which is the whole point. Before the fix this was the count of the target's
    // own build output alone, and on a project that had never been built it was zero.
    expect(loaded['references']).toBeGreaterThan(100)

    // This fixture has never been built, so it earns exactly one caveat — the third-party
    // one — and it must NOT earn the other. The System.Object warning firing here would mean
    // the base class library is missing again, which is the whole bug this file guards.
    const problems = loaded['problems'] as string[]
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('no build output')
    expect(problems.join(' ')).not.toContain('System.Object')
  })

  test('a type\'s declared interface is reported, which is what silently broke', async () => {
    const m = await helper.ask('members', { symbol: 'PlanItem' })
    expect(m['interfaces']).toEqual(['INotifyPropertyChanged'])
    expect(m['baseType']).toBe('object')
  })

  test('property accessors are not listed as members of their own', async () => {
    // `get_Name`/`set_Name` beside `Name` treble the answer and add no fact.
    const m = await helper.ask('members', { symbol: 'PlanItem' })
    const names = (m['results'] as { signature: string }[]).map((r) => r.signature)
    expect(names.some((s) => s.includes('get_'))).toBe(false)
    expect(names.some((s) => s.includes('Name'))).toBe(true)
  })

  test('implementations of a BCL interface include the type that inherits one', async () => {
    // The answer that used to be an empty list with ok:true. `MainViewModel` never names
    // the interface — it derives from something that does — so no text search finds it.
    const r = await helper.ask('implementations', { symbol: 'INotifyPropertyChanged' })
    const names = (r['results'] as { name: string }[]).map((x) => x.name).sort()
    expect(names).toEqual(['MainViewModel', 'PlanItem', 'ViewModelBase'])
  })

  test('framework implementations are counted, not listed, and never silently dropped', async () => {
    const r = await helper.ask('implementations', { symbol: 'INotifyPropertyChanged' })
    // ObservableCollection and friends implement it too, and are not what was asked about.
    for (const row of r['results'] as { file: string }[]) expect(row.file).not.toMatch(/^</)
    expect(String(r['note'])).toMatch(/more implementations live in referenced assemblies/)
  })

  test('an interface declared in the project still resolves from source', async () => {
    const r = await helper.ask('implementations', { symbol: 'IPlanner' })
    expect((r['results'] as { name: string }[]).map((x) => x.name)).toEqual(['Planner'])
  })

  test('references find a use through a constructor parameter and a field', async () => {
    const r = await helper.ask('references', { symbol: 'IPlanner' })
    const files = (r['results'] as { file: string }[]).map((x) => x.file.replace(/\\/g, '/'))
    expect(files.some((f) => f.endsWith('MainViewModel.cs'))).toBe(true)
    expect(files.some((f) => f.endsWith('Planner.cs'))).toBe(true)
  })

  test('a name that is genuinely absent says so rather than answering emptily', async () => {
    const r = await helper.ask('definition', { symbol: 'NoSuchTypeAnywhere' })
    expect(r['ok']).toBe(true)
    expect(String(r['note'])).toContain('NoSuchTypeAnywhere')
  })
})
