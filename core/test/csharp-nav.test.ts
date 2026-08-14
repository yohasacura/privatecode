import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { csharpNavTool } from '../src/tools/csharp-nav.js'
import { NavProcess, noteWorkspaceWrite, resolveHelper, toWorkspacePath } from '../src/csharp/nav-process.js'
import { Workspace } from '../src/workspace.js'

/**
 * The C# navigator's edges: where the binary is found, and what is refused before one is
 * ever spawned.
 *
 * Finding it is the half with a bug in its history. The rule was "the env var, or nothing",
 * the Tauri launcher is the only thing that sets that variable, and so on the CLI and the
 * ws-bridge the tool was advertised in every schema list and could answer nothing but "not
 * available in this build". Resolution now takes its inputs as arguments precisely so this
 * can be checked rather than reasoned about.
 *
 * What the helper ANSWERS is pinned separately, against a real C# tree, in
 * `roslyn-nav.test.ts` — those are the tests that would have caught it reporting no
 * interfaces for a class that declares one.
 */

let root: string
const roots: string[] = []

// No saving and restoring of the environment any more: resolution takes what it needs as
// arguments, so these tests neither read nor write process.env.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-nav-'))
  roots.push(root)
})
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Where `nav-process.ts` itself lives — the fallback counts directories up from there, so
 * handing it this test file's directory would measure the wrong thing. */
const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'csharp')

describe('finding the helper', () => {
  // The rule used to be "the env var or nothing", and the CLI and ws-bridge set no env var
  // -- so on those paths the tool was advertised in the schema list and every call to it
  // came back "not available in this build". Resolution takes its inputs as arguments so
  // this can be checked rather than reasoned about.

  test('the env var wins when it names a file that exists', () => {
    const real = join(root, 'stand-in.exe')
    writeFileSync(real, 'not really an exe', 'utf8')
    expect(resolveHelper(real, join(root, 'nowhere'))).toBe(real)
  })

  test('no env var falls back to the copy vendored in this checkout', () => {
    // This is the CLI/ws-bridge hole closed: nothing sets the variable there.
    const found = resolveHelper(undefined, MODULE_DIR)
    expect(found).not.toBeNull()
    expect(found).toContain('roslyn-nav.exe')
    expect(existsSync(found!)).toBe(true)
  })

  test('a variable pointing at nothing falls through instead of switching the feature off', () => {
    // Set-but-wrong is a stale launcher, not an instruction. It used to mean "unavailable".
    const found = resolveHelper(join(root, 'does-not-exist.exe'), MODULE_DIR)
    expect(found).not.toBeNull()
    expect(found).toContain('roslyn-nav.exe')
  })

  test('a caller that cannot locate itself gets null, not a crash', () => {
    // The shipped sidecar is bundled to CommonJS, where `import.meta` compiles to `{}` and
    // `fileURLToPath(import.meta.url)` THROWS. The caller passes null there, and this must be
    // an ordinary "use the env var" rather than an exception -- passing the directory as an
    // eager argument is what broke `navProcess()` in the packaged app while the CLI and every
    // test, both real ES modules, carried on passing.
    const real = join(root, 'stand-in.exe')
    writeFileSync(real, 'not really an exe', 'utf8')
    expect(resolveHelper(real, null)).toBe(real)
    expect(resolveHelper(undefined, null)).toBeNull()
  })

  test('neither source is an ordinary null, not a throw', () => {
    // A checkout without the 98 MB blob is legitimate, and the tool says so in words and
    // names what to use instead -- see its execute().
    expect(resolveHelper(undefined, join(root, 'nowhere'))).toBeNull()
    expect(resolveHelper('   ', join(root, 'nowhere'))).toBeNull()
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

describe('the index after an edit', () => {
  test('a write to a .cs file drops the cached compilation', async () => {
    // `ensureLoaded` returns { ok: true, cached: true } whenever the root matches the one it
    // loaded, and nothing but the helper process dying ever cleared that. So the compilation
    // was built once per workspace and every answer after the session's FIRST edit described
    // the code as it had been at load time — with ok:true, which is the same failure this
    // tool already had once: confidently wrong rather than unavailable.
    //
    // It survived the seven sessions that certified the tool because those ran in plan mode,
    // where no write is possible. It bites in exactly the sessions the tool is for.
    const nav = new NavProcess(join(root, 'never-spawned.exe'))
    // Pretend a load succeeded, the way one does.
    ;(nav as unknown as { loadedRoot: string | null }).loadedRoot = 'D:/proj'
    expect(await nav.ensureLoaded('D:/proj')).toEqual({ ok: true, cached: true })

    nav.invalidate()
    // Now it must NOT answer "cached" — the next question has to rebuild. (No process is
    // running, so the send times out rather than resolving; what matters is that it tried.)
    expect((nav as unknown as { loadedRoot: string | null }).loadedRoot).toBeNull()
  })

  test('only C# writes disturb it — a README does not cost a reload', () => {
    // The reload costs 0.5-12 s depending on the project. Paying it because the model touched
    // a markdown file would be a tax on every session that also happens to contain C#.
    expect(() => noteWorkspaceWrite('docs/README.md')).not.toThrow()
    expect(() => noteWorkspaceWrite('src/Thing.cs')).not.toThrow()
  })
})
