import { existsSync, mkdtempSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runCommandTool, clipOutput, splitUnquotedAnd, unparsableChainAt } from '../src/tools/run-command.js'
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
      { commands: ['Start-Sleep -Seconds 30'] },
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
      { commands: [tickerCommand(marker)] },
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
    expect(runCommandTool.permissionKey!({ commands: ['git status'] }))
      .toEqual({ tool: 'run_command', command: 'git status' })

    // A list is keyed by the `; `-joined form — the exact shape the model used to send as one
    // string, so a rule someone already wrote keeps matching what it always matched, and
    // HARD_DENY's `[^|;&]*`-bounded patterns still catch a `git push` in the second half.
    expect(runCommandTool.permissionKey!({ commands: ['npm install', 'npm test'] }))
      .toEqual({ tool: 'run_command', command: 'npm install; npm test' })
  })
})

describe('a command whose first half fails', () => {
  it('stops there, rather than running the rest and reporting the last exit code', async () => {
    // The reported shape, and the reason it mattered: `cd engine; dotnet build` on a
    // multi-folder workspace failed the `cd` (a folder NAME is not a directory under the one
    // the shell starts in), built whatever was in the current folder, and answered `exit 0`.
    // Measured before this: the command returned the contents of the wrong file, marked ok.
    const r = await run({ command: 'cd no-such-directory; Write-Output "the second half ran"' })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('exit 1')
    expect(r.content).not.toContain('the second half ran')
  }, 30_000)

  it('and says what to use instead, when the failing half was a directory change', async () => {
    const r = await run({ command: 'cd no-such-directory; Write-Output hi' })
    expect(r.content).toContain('Set the `cwd` argument instead')
  }, 30_000)

  it('says nothing of the sort when the failure had nothing to do with a directory', async () => {
    // The hint is attached to a shape, not to every failure — advice that arrives when it
    // does not apply is how a model learns to ignore advice.
    const r = await run({ command: 'cmd /c exit 3' })
    expect(r.ok).toBe(false)
    expect(r.content).not.toContain('Set the `cwd` argument instead')
  }, 30_000)

  it('leaves a command that merely WARNS alone', async () => {
    // `Stop` turns unhandled cmdlet errors terminating. A warning is not an error, and a
    // build that prints one has not failed.
    const r = await run({ command: 'Write-Warning "careful"; Write-Output "still ran"' })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('still ran')
  }, 30_000)

  it('leaves an explicitly tolerated error alone', async () => {
    // The escape hatch: a caller who says `-ErrorAction Continue` means it, and the
    // preference must not override the argument. This is what keeps `Stop` from being a
    // blunt instrument.
    const r = await run({
      command: 'Get-Item C:\definitely-not-here -ErrorAction Continue; Write-Output "carried on"',
    })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('carried on')
  }, 30_000)

  it('leaves a native program that writes to stderr and exits zero alone', async () => {
    // The case that could have made this a bad trade: git, npm and dotnet all write progress
    // and warnings to stderr. Measured to be unaffected, and asserted so it stays that way —
    // a regression here would fail every build that printed a warning.
    const r = await run({ command: 'cmd /c "echo a warning 1>&2 & exit 0"; Write-Output "reached the end"' })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('reached the end')
  }, 30_000)
})

describe('a list of commands', () => {
  it('runs them in order, in one shell', async () => {
    // One shell, not one per entry: a `cd` in the first has to still apply to the second,
    // which separate invocations would silently lose.
    const r = await run({ commands: ['Set-Location $env:TEMP', '(Get-Location).Path'] })
    expect(r.ok).toBe(true)
    expect(r.content.toLowerCase()).toContain('temp')
  }, 30_000)

  it('stops at the first failure, which is what `&&` means', async () => {
    const r = await run({ commands: ['cmd /c exit 3', 'Write-Output "should NOT run"'] })
    expect(r.ok).toBe(false)
    expect(r.content).not.toContain('should NOT run')
  }, 30_000)

  it('and stops on a cmdlet failure too, not only a native one', async () => {
    // The two kinds fail differently — a cmdlet error is terminating under
    // $ErrorActionPreference, a native non-zero exit is not — and the joiner has to catch
    // both. `$LASTEXITCODE` catches only the second; see CHAIN.
    const r = await run({ commands: ['cd no-such-directory', 'Write-Output "should NOT run"'] })
    expect(r.ok).toBe(false)
    expect(r.content).not.toContain('should NOT run')
  }, 30_000)

  it('runs every entry when they all succeed', async () => {
    // The case the obvious joiner gets wrong. `if ($LASTEXITCODE -ne 0) { exit }` between two
    // successful CMDLETS compares against a variable no cmdlet sets — `$null -ne 0` is true —
    // so the second never ran. Measured, then fixed by using `$?`.
    const r = await run({ commands: ['Write-Output one', 'Write-Output two'] })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('one')
    expect(r.content).toContain('two')
  }, 30_000)

  it('refuses an empty list, and an entry that is not a command', async () => {
    expect(runCommandTool.validate({ commands: [] }).ok).toBe(false)
    expect(runCommandTool.validate({ commands: ['ok', '   '] }).ok).toBe(false)
    expect(runCommandTool.validate({ commands: 'not a list' }).ok).toBe(false)
    expect(runCommandTool.validate({}).ok).toBe(false)
  })

  it('still accepts a bare command string, as one entry', () => {
    // The schema does not offer it and the model does not send it. A stored session or a
    // hand-written call might, and refusing something this can plainly run would be pedantry.
    const v = runCommandTool.validate({ command: 'Write-Output hi' })
    expect(v.ok).toBe(true)
    expect(v.ok && v.args.commands).toEqual(['Write-Output hi'])
  })
})

describe('an operator PowerShell 5.1 cannot parse', () => {
  it('`&&` inside one entry becomes the entries the model should have written', () => {
    // The residue the list shape does not remove: `&&` inside ONE entry, about one call in
    // twelve. This used to be refused with "put each command in its own entry" — and the
    // refusal was measured to cost a whole step for a rewrite the harness can do exactly:
    // the entries already run in order, in ONE shell, stopping at the first failure, which
    // is what `&&` means.
    const v = runCommandTool.validate({ commands: ['cd src && npm run build && npm test'] })
    expect(v.ok).toBe(true)
    expect(v.ok && v.args.commands).toEqual(['cd src', 'npm run build', 'npm test'])
    expect(splitUnquotedAnd('cmd /c "echo a && echo b" && echo c')).toEqual(['cmd /c "echo a && echo b"', 'echo c'])
  })

  it('catches || too, and says which entry', () => {
    const v = runCommandTool.validate({ commands: ['echo a', 'cat x || cat y'] })
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.error).toContain('commands[1]')
  })

  it('leaves a legitimate one inside quotes alone', () => {
    // `cmd /c "a && b"` is cmd's operator, not PowerShell's, and it works. Refusing it would
    // break a working command in order to prevent a broken one, so the scan is quote-aware
    // and biased to allow.
    expect(unparsableChainAt('cmd /c "echo a && echo b"')).toBeNull()
    expect(unparsableChainAt("cmd /c 'echo a && echo b'")).toBeNull()
    expect(runCommandTool.validate({ commands: ['cmd /c "echo a && echo b"'] }).ok).toBe(true)
  })

  it('and a single & or | is not an operator', () => {
    // A pipeline and a background-ish `&` are ordinary PowerShell. Only the doubled forms
    // are the ones 5.1 refuses.
    expect(unparsableChainAt('Get-Process | Select-Object -First 1')).toBeNull()
    expect(unparsableChainAt('cmd /c "echo a & echo b"')).toBeNull()
  })
})
