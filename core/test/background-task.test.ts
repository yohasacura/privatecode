import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BackgroundTasks, MAX_FINISHED, backgroundTaskTool } from '../src/tools/background-task.js'
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
    const started = await call({ command: 'echo first; sleep 0.4; echo second', action: 'start' })
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
    const started = await call({ action: 'start', command: 'sleep 60' })
    const id = /id: (task-\d+)/.exec(started.content)?.[1]
    const stopped = await call({ action: 'stop', id })
    expect(stopped.ok).toBe(true)
    const polled = await call({ action: 'poll', id })
    expect(polled.content).toMatch(/stopped|exited/)
  }, 30_000)

  it('reports readiness when a log marker appears', async () => {
    const started = await call({
      action: 'start',
      command: 'sleep 0.3; echo "SERVER READY"; sleep 60',
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

/**
 * A stopped job's own children are stopped too.
 *
 * A job is `powershell.exe -Command <whatever was asked for>`, so the process doing the work
 * -- a dev server, a watcher -- is PowerShell's CHILD. Killing the parent first left the
 * grandchild reparented and `taskkill /T` with no tree left to walk: found by driving the
 * app, where a `node -e "setInterval(...)"` job was still ticking in Task Manager after a
 * workspace switch had reported it stopped.
 *
 * The test watches for the EFFECT rather than for a pid: the grandchild appends to a file
 * every 200ms, and after the stop that file must not grow again. A pid check would prove
 * one process died; this proves the work actually stopped.
 */
describe('stopping a job stops what the job started', () => {
  it('a grandchild process is dead once stop() returns', async () => {
    const marker = join(root, 'ticks.txt')
    // Forward slashes: node accepts them on Windows, and it keeps the path out of the two
    // levels of escaping this command already goes through (PowerShell, then `node -e`).
    const path = marker.split('\\').join('/')
    // PowerShell starts node; node is the grandchild and the one writing.
    const started = await call({
      action: 'start',
      command: `node -e "setInterval(()=>require('fs').appendFileSync('${path}','x'),200)"`,
    })
    const id = /id: (task-\d+)/.exec(started.content)?.[1]
    expect(id).toBeTruthy()

    // Let it actually get going, or "it stopped" would be indistinguishable from "it never
    // started" -- the failure mode that makes this kind of test pass while proving nothing.
    //
    // WAITED FOR, not slept through. A fixed 1500 ms was enough on an idle machine and not
    // enough when the rest of the suite is competing for CPU: this failed in full runs and
    // passed alone, always on this first assertion — the grandchild had not written yet, not
    // the thing under test at all. Polling for the effect keeps the check and removes the
    // dependence on how busy the machine is.
    const deadline = Date.now() + 20_000
    let whileRunning = 0
    while (Date.now() < deadline) {
      try {
        whileRunning = statSync(marker).size
        if (whileRunning > 0) break
      } catch { /* not created yet */ }
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(whileRunning).toBeGreaterThan(0)

    await call({ action: 'stop', id })

    await new Promise((r) => setTimeout(r, 1200))
    const afterStop = statSync(marker).size
    await new Promise((r) => setTimeout(r, 1200))
    expect(statSync(marker).size).toBe(afterStop)
  }, 30_000)
})

describe('the registry does not grow forever', () => {
  // Its own directory, and torn down best-effort. Every spawned child holds its cwd open on
  // Windows, so these tests sharing the file's `root` made the shared teardown fail with
  // EPERM — a test suite failing on its own litter, which says nothing about the code.
  const ownRoot = mkdtempSync(join(tmpdir(), 'pc-bg-evict-'))
  afterAll(() => {
    try { rmSync(ownRoot, { recursive: true, force: true }) } catch { /* a child may still hold it */ }
  })

  /** A job that is already over, without spawning anything: `start` is the only insertion
   * point, so eviction is exercised through it, but a real child per entry would make this
   * a process-spawning stress test rather than a check of the bookkeeping. */
  function finishAll(t: BackgroundTasks): void {
    for (const job of t.snapshot()) {
      const entry = t.get(job.id)
      if (entry) entry.exit ??= { code: 0, stopped: false }
    }
  }

  it('keeps only the newest finished jobs, however many a long run starts', async () => {
    // Nothing anywhere removed an entry: `stop`/`stopAll` only record an exit code, and the
    // registry outlives every session switch. Bounded in practice while a turn was capped at
    // forty steps; with no ceiling one run starts an arbitrary number, and `snapshot()`
    // re-walks and re-copies all of them on every poll — once a second, on the same pipe the
    // streaming tokens use.
    const t = new BackgroundTasks()
    for (let i = 0; i < 80; i++) {
      t.start('cmd /c exit 0', null, ownRoot, 'agent')
      finishAll(t)
    }
    await t.stopAll()
    // MAX_FINISHED, plus at most the one that finished after the last insertion: the check
    // runs when a job STARTS, and the job starting is by definition still running then. The
    // guarantee is a constant bound, not an exact count — 80 started, ~30 kept.
    expect(t.snapshot().length).toBeLessThanOrEqual(MAX_FINISHED + 1)
  })

  it('never drops a job that is still running, whatever its age', async () => {
    // A live entry owns a child process, and `stopAll` has to be able to find it on
    // shutdown. Evicting one would leave an orphan behind.
    const t = new BackgroundTasks()
    const live = t.start('powershell -Command "Start-Sleep -Seconds 3"', null, ownRoot, 'agent')
    for (let i = 0; i < 60; i++) {
      t.start('cmd /c exit 0', null, ownRoot, 'agent')
      for (const job of t.snapshot()) {
        if (job.id === live.id) continue
        const entry = t.get(job.id)
        if (entry) entry.exit ??= { code: 0, stopped: false }
      }
    }
    expect(t.get(live.id)).toBeDefined()
    await t.stopAll()
  })

  it('keeps the NEWEST finished jobs, not the oldest', async () => {
    const t = new BackgroundTasks()
    const ids: string[] = []
    for (let i = 0; i < 50; i++) {
      ids.push(t.start('cmd /c exit 0', null, ownRoot, 'agent').id)
      finishAll(t)
    }
    await t.stopAll()
    const kept = new Set(t.snapshot().map((j) => j.id))
    expect(kept.has(ids[ids.length - 1]!)).toBe(true)
    expect(kept.has(ids[0]!)).toBe(false)
  })
  it('drops the agent\'s jobs before the user\'s own commands', async () => {
    // The registry is shared: `terminal.run` inserts through the same `start()`. The Terminal
    // panel renders finished entries straight from `snapshot()` and keeps nothing of its own,
    // and its output is deliberately kept out of the transcript — so this registry IS the
    // scrollback. Evicting by age alone deleted the user's own commands and their output,
    // mid-session, with no marker anywhere.
    const t = new BackgroundTasks()
    const mine: string[] = []
    for (let i = 0; i < 5; i++) {
      mine.push(t.start('cmd /c exit 0', null, ownRoot, 'user').id)
      finishAll(t)
    }
    for (let i = 0; i < 60; i++) {
      t.start('cmd /c exit 0', null, ownRoot, 'agent')
      finishAll(t)
    }
    await t.stopAll()

    const kept = new Set(t.snapshot().map((j) => j.id))
    for (const id of mine) expect(kept.has(id)).toBe(true)
    expect(t.snapshot().length).toBeLessThanOrEqual(MAX_FINISHED + 1)
  })
})

it('ready_when is validated, so a condition that can never be true is refused', () => {
  // `{}` is schema-valid and grammar-reachable, and `isReady` falls through all three
  // branches to false — forever — while the tool's description promises "poll until it
  // reports ready". DESIGN.md §4 requires semantic validation for exactly this shape.
  const tool = backgroundTaskTool(new BackgroundTasks())
  const empty = tool.validate({ action: 'start', command: 'npm run dev', ready_when: {} })
  expect(empty.ok).toBe(false)
  expect((empty as { error: string }).error).toMatch(/port, file, or log_contains/)

  for (const bad of [
    { port: 0 }, { port: 70_000 }, { port: 'eighty' },
    { file: '   ' }, { file: 42 },
    { log_contains: '' },
  ]) {
    const v = tool.validate({ action: 'start', command: 'npm run dev', ready_when: bad })
    expect(v.ok, JSON.stringify(bad)).toBe(false)
  }
})

it('and the usable conditions still pass, trimmed', () => {
  const tool = backgroundTaskTool(new BackgroundTasks())
  const v = tool.validate({
    action: 'start', command: 'npm run dev',
    ready_when: { port: 5173, file: '  dist/index.html  ', log_contains: ' ready in ' },
  })
  expect(v.ok).toBe(true)
  expect((v as { args: { ready_when?: unknown } }).args.ready_when)
    .toEqual({ port: 5173, file: 'dist/index.html', log_contains: 'ready in' })
})
