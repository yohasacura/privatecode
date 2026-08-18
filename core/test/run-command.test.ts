import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runCommandTool, clipOutput } from '../src/tools/run-command.js'
import { Workspace } from '../src/workspace.js'

const root = mkdtempSync(join(tmpdir(), 'pc-run-'))
const ctx = { workspace: new Workspace(root) }
afterAll(() => rmSync(root, { recursive: true, force: true }))

const run = (args: unknown) => {
  const v = runCommandTool.validate(args)
  if (!v.ok) throw new Error(`validate refused: ${v.error}`)
  return runCommandTool.execute(v.args, ctx)
}

describe('validate', () => {
  it('rejects an empty command', () => {
    expect(runCommandTool.validate({ command: '  ' }).ok).toBe(false)
  })
  it('rejects a non-integer or out-of-range timeout', () => {
    expect(runCommandTool.validate({ command: 'x', timeout_seconds: 0 }).ok).toBe(false)
    expect(runCommandTool.validate({ command: 'x', timeout_seconds: 601 }).ok).toBe(false)
    expect(runCommandTool.validate({ command: 'x', timeout_seconds: 2.5 }).ok).toBe(false)
  })
})

describe('execute', () => {
  it('runs PowerShell and returns stdout with exit 0', async () => {
    const r = await run({ command: 'Write-Output hello' })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('exit 0')
    expect(r.content).toContain('hello')
  }, 30_000)

  // PowerShell 5.1 folds anything outside the OEM codepage to `?` when stdout is
  // redirected; the UTF-8 prelude in powershell.ts is what keeps these two green.
  it('keeps Cyrillic intact in PowerShell output', async () => {
    const r = await run({ command: "Write-Output 'привет, мир'" })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('привет, мир')
  }, 30_000)

  it('keeps Cyrillic intact when a native child prints it', async () => {
    const r = await run({ command: 'node -e "console.log(\'кириллица работает\')"' })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('кириллица работает')
  }, 30_000)

  it('reports a non-zero exit as ok:false with the output kept', async () => {
    const r = await run({ command: 'Write-Output boom; exit 3' })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('exit 3')
    expect(r.content).toContain('boom')
  }, 30_000)

  it('kills on timeout and says so', async () => {
    const r = await run({ command: 'Start-Sleep -Seconds 30', timeout_seconds: 2 })
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/killed after 2 s/)
  }, 30_000)

  it('runs in a workspace-relative cwd and refuses an escaping one', async () => {
    mkdirSync(join(root, 'sub'))
    const r = await run({ command: '(Get-Location).Path', cwd: 'sub' })
    expect(r.ok).toBe(true)
    expect(r.content.toLowerCase()).toContain('sub')
    const esc = await run({ command: 'Write-Output x', cwd: '..' })
    expect(esc.ok).toBe(false)
  }, 30_000)

  it('is cancelled by the context signal', async () => {
    const ac = new AbortController()
    const p = runCommandTool.execute(
      { command: 'Start-Sleep -Seconds 30' },
      { workspace: new Workspace(root), signal: ac.signal },
    )
    setTimeout(() => ac.abort(), 300)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/cancelled/i)
  }, 30_000)
})

describe('clipOutput', () => {
  it('passes short text through and clips long text head+tail with a marker', () => {
    expect(clipOutput('short', 100)).toBe('short')
    const clipped = clipOutput('a'.repeat(200), 100)
    expect(clipped.length).toBeLessThan(200)
    expect(clipped).toMatch(/characters omitted/)
    expect(clipped.startsWith('a')).toBe(true)
    expect(clipped.endsWith('a')).toBe(true)
  })
})

describe('permission surface', () => {
  it('exposes the exact command as its permission key', () => {
    expect(runCommandTool.permissionKey!({ command: 'git status' }))
      .toEqual({ tool: 'run_command', command: 'git status' })
  })
})
