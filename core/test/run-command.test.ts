import { existsSync, mkdtempSync, rmSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findBash } from '../src/bash.js'
import { BackgroundTasks } from '../src/tools/background-task.js'
import { runCommandTool, clipOutput, createBashTool } from '../src/tools/run-command.js'
import { Workspace } from '../src/workspace.js'

/**
 * `Bash` runs bash — the vendored Git Bash, or the machine's Git for Windows — with Claude
 * Code's arguments. Skipped wholesale where there is no bash at all, which is a machine the
 * app itself would report as unable to run commands.
 */

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
    expect(runCommandTool.validate({}).ok).toBe(false)
  })
  it('rejects a non-integer or out-of-range timeout, in milliseconds as Claude Code counts it', () => {
    expect(runCommandTool.validate({ command: 'x', timeout: 0 }).ok).toBe(false)
    expect(runCommandTool.validate({ command: 'x', timeout: 600_001 }).ok).toBe(false)
    expect(runCommandTool.validate({ command: 'x', timeout: 2.5 }).ok).toBe(false)
    expect(runCommandTool.validate({ command: 'x', timeout: 5000 })).toMatchObject({ ok: true, args: { command: 'x', timeout: 5000 } })
  })
  it('still reads what a session recorded before 2026-09-03 sends: a list, and seconds', () => {
    const v = runCommandTool.validate({ commands: ['cd src', 'npm test'], timeout_seconds: 3 })
    expect(v).toMatchObject({ ok: true, args: { command: 'cd src && npm test', timeout: 3000 } })
    expect(runCommandTool.validate({ commands: [] }).ok).toBe(false)
    expect(runCommandTool.validate({ commands: ['ok', '   '] }).ok).toBe(false)
  })
  it('keeps the description and the flags', () => {
    const v = runCommandTool.validate({ command: 'npm test', description: 'Run the tests', run_in_background: true, cwd: 'app' })
    expect(v).toMatchObject({ ok: true, args: { command: 'npm test', description: 'Run the tests', run_in_background: true, cwd: 'app' } })
    expect(runCommandTool.validate({ command: 'x', run_in_background: 'yes' }).ok).toBe(false)
  })
})

describe('permission surface', () => {
  it('exposes the exact command as its permission key, and the description on the card', () => {
    expect(runCommandTool.permissionKey!({ command: 'git status' }, ctx))
      .toEqual({ tool: 'Bash', command: 'git status' })
    const preview = runCommandTool.approvalPreview!({ command: 'npm test', description: 'Run the tests' }, ctx)
    expect(preview).toMatchObject({ summary: 'Run the tests' })
    expect((preview as { detail: string }).detail).toContain('Run in bash')
  })
})

describe.skipIf(findBash() === null)('execute', () => {
  it('runs bash and returns stdout with exit 0', async () => {
    const r = await run({ command: 'echo hello' })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('exit 0')
    expect(r.content).toContain('hello')
  }, 30_000)

  it('is bash: &&, ||, pipes, globs and $(...) all work', async () => {
    writeFileSync(join(root, 'one.txt'), 'a\nb\nc\n')
    const r = await run({ command: 'ls *.txt | wc -l && echo "lines: $(wc -l < one.txt)" || echo nope' })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('lines: 3')
  }, 30_000)

  it('keeps Cyrillic intact, from bash and from a native child', async () => {
    const r = await run({ command: "echo 'привет, мир'; node -e \"console.log('кириллица работает')\"" })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('привет, мир')
    expect(r.content).toContain('кириллица работает')
  }, 30_000)

  it('reports a non-zero exit as ok:false with the output kept', async () => {
    const r = await run({ command: 'echo boom; exit 3' })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('exit 3')
    expect(r.content).toContain('boom')
  }, 30_000)

  it('kills on timeout and says so', async () => {
    const r = await run({ command: 'sleep 30', timeout: 2000 })
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/killed after 2 s/)
  }, 30_000)

  it('runs in a workspace-relative cwd and refuses an escaping one', async () => {
    mkdirSync(join(root, 'sub'))
    const r = await run({ command: 'pwd', cwd: 'sub' })
    expect(r.ok).toBe(true)
    expect(r.content.toLowerCase()).toContain('/sub')
    const esc = await run({ command: 'echo x', cwd: '..' })
    expect(esc.ok).toBe(false)
  }, 30_000)

  it('is cancelled by the context signal', async () => {
    const ac = new AbortController()
    const p = runCommandTool.execute(
      { command: 'sleep 30' },
      { workspace: new Workspace(root), signal: ac.signal },
    )
    setTimeout(() => ac.abort(), 300)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/cancelled/i)
  }, 30_000)

  it('puts the vendored coreutils first on PATH, and a plugin bin/ after them', async () => {
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'hello-plugin'), '#!/bin/sh\necho from-plugin\n')
    const r = await runCommandTool.execute(
      { command: 'hello-plugin; command -v ls' },
      { workspace: new Workspace(root), extraPath: [join(root, 'bin')] },
    )
    expect(r.content).toContain('from-plugin')
    expect(r.content.replace(/\\/g, '/')).toContain('/usr/bin/ls')
  }, 30_000)

  it('starts a command in the background when asked, through the same runner as background_task', async () => {
    const tasks = new BackgroundTasks()
    const tool = createBashTool({ background: tasks })
    try {
      const v = tool.validate({ command: 'echo started; sleep 30', run_in_background: true })
      if (!v.ok) throw new Error(v.error)
      const r = await tool.execute(v.args, ctx)
      expect(r.ok).toBe(true)
      expect(r.content).toMatch(/Started in the background as task-\d+/)
    } finally {
      await tasks.stopAll()
    }
    // Without a runner the tool says so instead of running the command in the foreground.
    const none = await run({ command: 'echo x', run_in_background: true })
    expect(none.ok).toBe(false)
    expect(none.content).toContain('No background runner')
  }, 30_000)

  it('a command that opens by changing directory and fails is told about cwd', async () => {
    const r = await run({ command: 'cd no-such-directory && echo hi' })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('Set the `cwd` argument instead')
    const other = await run({ command: 'false' })
    expect(other.ok).toBe(false)
    expect(other.content).not.toContain('Set the `cwd` argument instead')
  }, 30_000)
})

/**
 * The job is `bash.exe -c …`, so the process actually doing the work is bash's CHILD. A kill
 * that reaches only bash reports the command stopped and leaves node/dotnet running —
 * holding a port, a build lock and its file handles — with no entry in the Terminal panel
 * (that lists background_task jobs only) to stop it from.
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
  return `node -e "${script}" "${marker.replace(/\\/g, '/')}"`
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

describe.skipIf(findBash() === null)('killing the process tree', () => {
  it('cancel stops the grandchild, not only bash', async () => {
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
    const p = run({ command: tickerCommand(marker), timeout: 3000 })
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
