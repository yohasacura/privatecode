import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BackgroundTasks, backgroundTaskTool } from '../src/tools/background-task.js'
import { Workspace } from '../src/workspace.js'

const root = mkdtempSync(join(tmpdir(), 'pc-bg-'))
const ws = new Workspace(root)
const tasks = new BackgroundTasks()
const tool = backgroundTaskTool(tasks)
const ctx = { workspace: ws }
afterAll(async () => { await tasks.stopAll(); rmSync(root, { recursive: true, force: true }) })

const call = (args: unknown) => {
  const v = tool.validate(args)
  if (!v.ok) throw new Error(v.error)
  return tool.execute(v.args, ctx)
}

describe('background_task', () => {
  it('validate rejects start without command, poll/stop without id', () => {
    expect(tool.validate({ action: 'start' }).ok).toBe(false)
    expect(tool.validate({ action: 'poll' }).ok).toBe(false)
    expect(tool.validate({ action: 'stop' }).ok).toBe(false)
    expect(tool.validate({ action: 'dance' }).ok).toBe(false)
  })

  it('start returns an id; poll returns new output exactly once; exit is reported', async () => {
    const started = await call({ command: 'Write-Output first; Start-Sleep -Milliseconds 400; Write-Output second' , action: 'start' })
    expect(started.ok).toBe(true)
    const id = /id: (task-\d+)/.exec(started.content)?.[1]
    expect(id).toBeTruthy()
    const p1 = await call({ action: 'poll', id, wait_seconds: 3 })
    expect(p1.content).toContain('first')
    // wait_seconds: 3 waited for exit, so both lines and the exit code are visible
    expect(p1.content).toContain('second')
    expect(p1.content).toMatch(/exited with code 0/)
    const p2 = await call({ action: 'poll', id })
    expect(p2.content).not.toContain('first') // cursor advanced: no repeated output
  }, 30_000)

  it('stop kills a running task', async () => {
    const started = await call({ action: 'start', command: 'Start-Sleep -Seconds 60' })
    const id = /id: (task-\d+)/.exec(started.content)?.[1]
    const stopped = await call({ action: 'stop', id })
    expect(stopped.ok).toBe(true)
    const polled = await call({ action: 'poll', id })
    expect(polled.content).toMatch(/stopped|exited/)
  }, 30_000)

  it('reports readiness when a log marker appears', async () => {
    const started = await call({
      action: 'start',
      command: 'Start-Sleep -Milliseconds 300; Write-Output "SERVER READY"; Start-Sleep -Seconds 60',
      ready_when: { log_contains: 'SERVER READY' },
    })
    const id = /id: (task-\d+)/.exec(started.content)?.[1]
    const early = await call({ action: 'poll', id })
    expect(early.content).toMatch(/ready: no/)
    const later = await call({ action: 'poll', id, wait_seconds: 5 })
    expect(later.content).toMatch(/ready: YES/)
    await call({ action: 'stop', id })
  }, 30_000)

  it('poll on an unknown id fails without throwing', async () => {
    const r = await call({ action: 'poll', id: 'task-999' })
    expect(r.ok).toBe(false)
  })
})
