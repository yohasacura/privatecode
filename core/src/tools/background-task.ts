import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { execa } from 'execa'
import type { ResultPromise } from 'execa'
import { findBash, spawnBash } from '../bash.js'
import { POWERSHELL_EXE, powershellArgs } from '../powershell.js'
import { clipOutput } from './run-command.js'
import type { ReadyWhen } from './ready-when.js'
import type { ApprovalPreview, PermissionKey, Tool, ToolContext } from './types.js'
export type { ReadyWhen } from './ready-when.js'


export interface TaskOutputArgs {
  id: string
  wait_seconds?: number
}

export interface TaskStopArgs {
  id: string
}

// Parameterized so .all is a stream, not undefined — ResultPromise import used.
type ExecaChild = ResultPromise<any>

interface Entry {
  id: string
  command: string
  /** Who started this process. `'agent'` is a `Bash` call with `run_in_background`, which passed the
   * permission engine; `'user'` is a command typed into the app's own terminal, which did
   * not, because the user running a command in their own workspace is not the model acting.
   * Only the UI reads this -- nothing here behaves differently by origin. */
  origin: JobOrigin
  child: ExecaChild
  buffer: string
  dropped: number
  cursor: number
  markerSeen: boolean
  ready: ReadyWhen | null
  startedAt: number
  exit: { code: number | null; stopped: boolean } | null
}

export type JobOrigin = 'agent' | 'user'

/**
 * One process as the UI sees it. Deliberately NOT the same read as the tool's own `poll`:
 * `describe()` returns output *since the last poll* and advances `cursor`, which is right
 * for the model (it must not re-read what it already saw) and wrong for a panel (which
 * re-renders constantly and must never consume the model's unread output). `snapshot()`
 * reads the tail without touching `cursor`, so the two readers cannot interfere.
 */
export interface JobSnapshot {
  id: string
  command: string
  origin: JobOrigin
  startedAt: number
  running: boolean
  exitCode: number | null
  stopped: boolean
  /** Tail of the output buffer, newest content kept. */
  output: string
  /** True when older output has been dropped from the front of the ring. */
  clipped: boolean
}

/** Ring ceiling per task. Output beyond it drops from the FRONT (old lines go first). */
const MAX_BUFFER = 64_000

/**
 * How many FINISHED jobs are kept. Running ones are never counted and never dropped.
 *
 * The registry was append-only: nothing anywhere removed an entry, and `stop`/`stopAll` only
 * record an exit code. That was bounded in practice while a turn was capped at forty steps —
 * a turn could start a handful of jobs. With no ceiling, one run starts an arbitrary number,
 * and every one of them keeps its ring buffer (up to 64 KB) and is re-walked and re-copied
 * by `snapshot()` on every `jobs.list` poll — once a second while the Terminal tab is open,
 * on the same pipe that carries the turn's streaming tokens.
 *
 * Thirty is more finished jobs than the console shows without scrolling, and it holds the
 * poll payload and the retained memory flat for a run of any length.
 */
export const MAX_FINISHED = 30
const MAX_WAIT_S = 30
const POLL_INTERVAL_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** True if something answers TCP on 127.0.0.1:port within 500 ms. */
function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port })
    const done = (v: boolean) => { sock.destroy(); resolve(v) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(500, () => done(false))
  })
}

export class BackgroundTasks {
  private readonly entries = new Map<string, Entry>()
  private nextId = 1

  /**
   * The model's jobs run under bash — the same shell `Bash` runs, so what it starts here is
   * written the same way. A command the PERSON typed into the Terminal panel runs under
   * PowerShell: it is their Windows shell, and what they type there is PowerShell.
   */
  start(command: string, ready: ReadyWhen | null, cwd: string, origin: JobOrigin = 'agent', extraPath: readonly string[] = []): Entry {
    const id = `task-${this.nextId++}`
    const bash = origin === 'agent' ? findBash() : null
    const child = (bash !== null
      ? spawnBash(bash, command, { cwd, extraPath, buffer: false })
      : execa(
        POWERSHELL_EXE,
        powershellArgs(command),
        { cwd, reject: false, windowsHide: true, all: true, buffer: false },
      )) as unknown as ExecaChild
    const entry: Entry = {
      id, command, origin, child, buffer: '', dropped: 0, cursor: 0, markerSeen: false,
      ready, startedAt: Date.now(), exit: null,
    }
    // Same reason as the live stream in run-command: a chunk boundary can split a
    // multi-byte character, and toString() would turn the halves into mojibake.
    const decoder = new StringDecoder('utf8')
    child.all?.on('data', (chunk: Buffer) => {
      entry.buffer += decoder.write(chunk)
      if (ready?.log_contains && !entry.markerSeen &&
          entry.buffer.includes(ready.log_contains)) {
        entry.markerSeen = true
      }
      if (entry.buffer.length > MAX_BUFFER) {
        const cut = entry.buffer.length - MAX_BUFFER
        entry.buffer = entry.buffer.slice(cut)
        entry.dropped += cut
        // The cursor indexes into the buffer; keep it pointing at the same content.
        entry.cursor = Math.max(0, entry.cursor - cut)
      }
    })
    void child.then(
      (r) => { entry.exit ??= { code: r.exitCode ?? null, stopped: false } },
      () => { entry.exit ??= { code: null, stopped: false } },
    )
    this.entries.set(id, entry)
    this.evictFinished()
    return entry
  }

  /**
   * Drops the oldest FINISHED jobs once there are more than `MAX_FINISHED`.
   *
   * Done on insertion rather than on a timer: it is the only moment the count can grow, so
   * it is the only moment a check is needed, and it costs a walk of a bounded map.
   *
   * A running job is never dropped, whatever its age — it owns a live child process, and
   * `stopAll` has to be able to find it on shutdown or it becomes an orphan. `Map` preserves
   * insertion order and ids are issued in order, so iterating it is oldest-first already.
   */
  private evictFinished(): void {
    let finished = 0
    for (const entry of this.entries.values()) if (entry.exit !== null) finished++
    if (finished <= MAX_FINISHED) return

    let toDrop = finished - MAX_FINISHED
    // The AGENT's jobs go first, and the user's typed commands only if there are none left.
    //
    // The registry is shared: `terminal.run` inserts through this same `start()`. The
    // Terminal panel renders finished entries straight from `snapshot()` and keeps nothing
    // of its own, and its output is deliberately kept out of the transcript and the model's
    // context — so this registry IS the scrollback. Evicting by age alone deleted the user's
    // own commands and their output, mid-session, with no marker: the panel's
    // "…earlier output dropped…" note only ever meant one job's ring buffer clipping.
    //
    // Typed commands are also the ones there are fewest of and the ones someone might scroll
    // back to; agent jobs are the churn a long run produces. Two passes, oldest-first within
    // each, and the cap still holds however long the run goes.
    for (const origin of ['agent', 'user'] as const) {
      for (const [id, entry] of this.entries) {
        if (toDrop === 0) return
        if (entry.exit === null || entry.origin !== origin) continue
        this.entries.delete(id)
        toDrop--
      }
    }
  }

  get(id: string): Entry | undefined {
    return this.entries.get(id)
  }

  async isReady(entry: Entry, ws: ToolContext['workspace']): Promise<boolean> {
    const r = entry.ready
    if (!r) return false
    if (r.log_contains) return entry.markerSeen
    if (r.port !== undefined) return portAnswers(r.port)
    if (r.file) {
      try { return existsSync(ws.resolve(r.file)) } catch { return false }
    }
    return false
  }

  /**
   * Stops one process AND everything it started.
   *
   * The order is the whole point, and getting it backwards is what this fixes. A job is
   * `bash.exe -c <whatever was asked for>` (or `powershell.exe -Command …` for the Terminal
   * panel), so the thing doing the work -- a dev server, a watcher, a `node -e` loop -- is
   * the shell's CHILD, not this process.
   * `taskkill /T` walks the tree by parent-child links as they stand when it runs, so it has
   * to run while the parent is still alive. Killing the child first left the grandchild
   * reparented and unreachable, and `/T` then found nothing to walk: a stopped dev server
   * that was still holding its port, still writing to disk, and still running after the app
   * closed. (Found by driving the app: a `node -e "setInterval(…)"` job was still ticking in
   * Task Manager after a workspace switch had reported it stopped.)
   *
   * `kill()` stays, after, as the fallback for the case taskkill cannot help: a pid we never
   * learned, or a machine without it on PATH.
   */
  async stop(entry: Entry): Promise<void> {
    if (entry.exit) return
    const pid = entry.child.pid
    if (pid !== undefined) {
      await execa('taskkill', ['/PID', String(pid), '/T', '/F'],
        { reject: false, windowsHide: true })
    }
    entry.child.kill()
    entry.exit = { code: null, stopped: true }
  }

  async stopAll(): Promise<void> {
    for (const entry of this.entries.values()) await this.stop(entry)
  }

  /** Stop one process by id. Unknown or already-exited ids are a no-op, not an error --
   * the UI's Stop button races the process exiting on its own. */
  async stopById(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry) await this.stop(entry)
  }

  /**
   * Every process this registry knows about, oldest first, WITHOUT advancing any poll
   * cursor -- see `JobSnapshot`. `tailChars` bounds what one snapshot can cost the caller;
   * the ring itself is already capped at `MAX_BUFFER`.
   */
  snapshot(tailChars = 20_000): JobSnapshot[] {
    return [...this.entries.values()].map((e) => {
      const clippedHere = e.buffer.length > tailChars
      return {
        id: e.id,
        command: e.command,
        origin: e.origin,
        startedAt: e.startedAt,
        running: e.exit === null,
        exitCode: e.exit?.code ?? null,
        stopped: e.exit?.stopped ?? false,
        output: clippedHere ? e.buffer.slice(e.buffer.length - tailChars) : e.buffer,
        clipped: clippedHere || e.dropped > 0,
      }
    })
  }
}

function describe(entry: Entry, ready: string | null): string {
  const state = entry.exit
    ? entry.exit.stopped ? 'stopped by request' : `exited with code ${entry.exit.code ?? 'unknown'}`
    : `running for ${Math.round((Date.now() - entry.startedAt) / 1000)} s`
  const readyLine = ready === null ? '' : `\n${ready}`
  const fresh = entry.buffer.slice(entry.cursor)
  entry.cursor = entry.buffer.length
  const output = fresh.trim() === '' ? '(no new output)' : clipOutput(fresh.trim(), 6_000)
  const dropped = entry.dropped > 0
    ? `\n(${entry.dropped} old output characters were dropped from the front of the buffer)` : ''
  return `${entry.id}: ${state}${readyLine}\nNew output since last poll:\n${output}${dropped}`
}

/**
 * `TaskOutput` — Claude Code's name for reading a background task's output. Starting one
 * is `Bash` with `run_in_background` (and a `ready_when`, when the process has a readiness
 * condition); this polls it, waiting up to `wait_seconds` for exit or readiness, and
 * returns only what appeared since the previous poll.
 */
export function taskOutputTool(tasks: BackgroundTasks): Tool<TaskOutputArgs> {
  return {
    name: 'TaskOutput',
    readOnly: true,
    description:
      'Read the output of a background task started with Bash (run_in_background: true). ' +
      'Returns only what appeared since the previous read, and whether the task is still ' +
      'running or how it exited. A process exiting is evidence, not completion — when it was ' +
      'started with ready_when, poll until "ready: YES". wait_seconds waits that long for exit ' +
      'or readiness before answering.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id Bash returned when it started the task.' },
        wait_seconds: {
          type: 'integer',
          description: `Wait up to this long for exit or readiness (max ${MAX_WAIT_S}).`,
        },
      },
      required: ['id'],
    },
    validate(raw) {
      const r = raw as Partial<TaskOutputArgs>
      if (typeof r?.id !== 'string' || r.id.trim() === '') return { ok: false, error: 'id is the one Bash returned' }
      if (r.wait_seconds !== undefined &&
          (!Number.isInteger(r.wait_seconds) || r.wait_seconds < 0 || r.wait_seconds > MAX_WAIT_S)) {
        return { ok: false, error: `wait_seconds must be an integer from 0 to ${MAX_WAIT_S}` }
      }
      return { ok: true, args: { id: r.id.trim(), ...(r.wait_seconds !== undefined ? { wait_seconds: r.wait_seconds } : {}) } }
    },
    // A control op on something already approved: no command, so nothing to gate.
    permissionKey(): PermissionKey {
      return { tool: 'TaskOutput' }
    },
    approvalPreview(args): ApprovalPreview {
      return { summary: `read the output of ${args.id}`, detail: `Read new output of background task ${args.id}` }
    },
    async execute(args, ctx) {
      const entry = tasks.get(args.id)
      if (!entry) return { ok: false, content: `No background task with id ${args.id}. Use the id Bash returned.` }
      const deadline = Date.now() + (args.wait_seconds ?? 0) * 1000
      let ready = await tasks.isReady(entry, ctx.workspace)
      while (!entry.exit && !ready && Date.now() < deadline) {
        if (ctx.signal?.aborted) return { ok: false, content: 'Poll cancelled by the user.' }
        await sleep(POLL_INTERVAL_MS)
        ready = await tasks.isReady(entry, ctx.workspace)
      }
      const readyLine = entry.ready === null ? null : `ready: ${ready ? 'YES' : 'no'}`
      return { ok: true, content: describe(entry, readyLine) }
    },
  }
}

/** `TaskStop` — Claude Code's name for stopping a background task. The whole tree goes. */
export function taskStopTool(tasks: BackgroundTasks): Tool<TaskStopArgs> {
  return {
    name: 'TaskStop',
    readOnly: false,
    description: 'Stop a background task started with Bash (run_in_background: true), and everything it started.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The id Bash returned when it started the task.' } },
      required: ['id'],
    },
    validate(raw) {
      const r = raw as Partial<TaskStopArgs>
      if (typeof r?.id !== 'string' || r.id.trim() === '') return { ok: false, error: 'id is the one Bash returned' }
      return { ok: true, args: { id: r.id.trim() } }
    },
    permissionKey(): PermissionKey {
      return { tool: 'TaskStop' }
    },
    approvalPreview(args): ApprovalPreview {
      return { summary: `stop ${args.id}`, detail: `Stop background task ${args.id}` }
    },
    async execute(args) {
      const entry = tasks.get(args.id)
      if (!entry) return { ok: false, content: `No background task with id ${args.id}. Use the id Bash returned.` }
      await tasks.stop(entry)
      return { ok: true, content: `${entry.id} stopped.` }
    },
  }
}
