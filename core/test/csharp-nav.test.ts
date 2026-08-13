import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { csharpNavTool } from '../src/tools/csharp-nav.js'
import { ROSLYN_ENV, toWorkspacePath } from '../src/csharp/nav-process.js'
import { Workspace } from '../src/workspace.js'

/**
 * The C# navigator's edges — the parts that must hold with no binary present.
 *
 * The helper itself is exercised against a real backend by hand (and its answers are what
 * justified building it: `references` on an interface returned the implementing class, the
 * field holding it, the constructor taking it and its DI registration — five files as four
 * lines). What is pinned here is everything that must be true when it is NOT installed,
 * because that is the shipping default: 92 MB is optional, and a missing optional binary
 * must degrade to an explanation rather than a broken session.
 */

let root: string
const roots: string[] = []
const saved = process.env[ROSLYN_ENV]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-nav-'))
  roots.push(root)
})
afterEach(() => {
  if (saved === undefined) delete process.env[ROSLYN_ENV]
  else process.env[ROSLYN_ENV] = saved
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('without the helper installed', () => {
  test('it explains itself and names what to use instead', async () => {
    delete process.env[ROSLYN_ENV]
    const r = await csharpNavTool.execute(
      { action: 'definition', symbol: 'IThing' }, { workspace: new Workspace(root) })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('not available in this build')
    // Naming the fallback is the difference between a dead end and a redirect.
    expect(r.content).toContain('search_code')
  })

  test('a path pointing at nothing is the same as no path', async () => {
    // Set-but-wrong must behave like absent, not like broken: the Rust shell only sets the
    // variable when the file exists, and this is the other half of that contract.
    process.env[ROSLYN_ENV] = join(root, 'does-not-exist.exe')
    const r = await csharpNavTool.execute(
      { action: 'references', symbol: 'IThing' }, { workspace: new Workspace(root) })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('not available in this build')
  })
})

describe('validation', () => {
  test('the four actions are the only ones offered', () => {
    for (const action of ['definition', 'references', 'implementations', 'members']) {
      expect(csharpNavTool.validate({ action, symbol: 'X' }).ok).toBe(true)
    }
    const bad = csharpNavTool.validate({ action: 'rename', symbol: 'X' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('definition')
  })

  test('an empty symbol is refused before a process is started', () => {
    expect(csharpNavTool.validate({ action: 'definition', symbol: '   ' }).ok).toBe(false)
  })

  test('the reference limit is clamped, because the result is permanent context', () => {
    const v = csharpNavTool.validate({ action: 'references', symbol: 'X', limit: 99999 })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.args.limit).toBe(200)
  })
})

describe('paths coming back from the helper', () => {
  test('become workspace-relative with forward slashes', () => {
    // Not cosmetic. The helper reports the absolute path it was handed, and joins a
    // forward-slashed root to Windows-relative parts, so its output is mixed-separator and
    // absolute — a path the model cannot hand back to read_file.
    const ws = 'D:/proj/src'
    const mixed = 'D:/proj/src\\App\\Accounting\\ActService.cs'
    expect(toWorkspacePath(mixed, ws)).toBe('App/Accounting/ActService.cs')
  })

  test('a file outside the workspace stays absolute rather than becoming ../..', () => {
    // A generated or referenced file can genuinely sit outside; `../../..` would be worse
    // than useless, since nothing in the jail would accept it.
    const out = toWorkspacePath('D:/elsewhere/Other.cs', 'D:/proj/src')
    expect(out).toBe('D:/elsewhere/Other.cs')
    expect(out.startsWith('..')).toBe(false)
  })
})
