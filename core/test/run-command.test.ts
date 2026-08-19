import { existsSync, mkdtempSync, rmSync, mkdirSync, statSync } from 'node:fs'
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

/**
 * The job is `powershell.exe -Command …`, so the process actually doing the work is
 * PowerShell's CHILD. A kill that reaches only PowerShell reports the command stopped and
 * leaves node/dotnet running — holding a port, a build lock and its file handles — with no
 * entry in the Terminal panel (that lists background_task jobs only) to stop it from.
 *
 * The grandchild here appends to a file every 100 ms, so "did it really stop" is answered
 * by the file's size holding still afterwards rather than by anything the tool reports
 * about itself. It also exits on its own after 30 s: a regression here must not leave a
 * ticking process behind on the machine running the suite.
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function tickerCommand(marker: string): string {
  const script = "const fs=require('fs');" +
    'setTimeout(()=>process.exit(0),30000);' +
    "setInterval(()=>fs.appendFileSync(process.argv[1],'.'),100)"
  return `node -e "${script}" "${marker}"`
}

async function awaitTicking(marker: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (existsSync(marker) && statSync(marker).size > 0) return
    await sleep(50)
  }
  throw new Error(`the grandchild never started writing ${marker}`)
}

async function expectStopped(marker: string): Promise<void> {
  await sleep(400)
  const settled = statSync(marker).size
  await sleep(1_200)
  expect(statSync(marker).size).toBe(settled)
}

describe('killing the process tree', () => {
  it('cancel stops the grandchild, not only PowerShell', async () => {
    const marker = join(root, 'cancel-ticker.txt')
    const ac = new AbortController()
    const p = runCommandTool.execute(
      { command: tickerCommand(marker) },
      { workspace: new Workspace(root), signal: ac.signal },
    )
    await awaitTicking(marker)
    ac.abort()
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/cancelled/i)
    await expectStopped(marker)
  }, 60_000)

  it('the timeout stops the grandchild too, and still says what it did', async () => {
    const marker = join(root, 'timeout-ticker.txt')
    const p = run({ command: tickerCommand(marker), timeout_seconds: 3 })
    await awaitTicking(marker)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/killed after 3 s/)
    await expectStopped(marker)
  }, 60_000)
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
