import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { execa } from 'execa'
import type { ResultPromise } from 'execa'
import { clipOutput } from './run-command.js'
import type { ApprovalPreview, PermissionKey, Tool, ToolContext } from './types.js'

export interface ReadyWhen {
  port?: number
  file?: string
  log_contains?: string
}

export interface BackgroundTaskArgs {
  action: 'start' | 'poll' | 'stop'
  command?: string
  id?: string
  wait_seconds?: number
  ready_when?: ReadyWhen
}

// Parameterized so .all is a stream, not undefined — ResultPromise import used.
type ExecaChild = ResultPromise<any>

interface Entry {
  id: string
  command: string
  child: ExecaChild
  buffer: string
  dropped: number
  cursor: number
  markerSeen: boolean
  ready: ReadyWhen | null
  startedAt: number
  exit: { code: number | null; stopped: boolean } | null
}

/** Ring ceiling per task. Output beyond it drops from the FRONT (old lines go first). */
const MAX_BUFFER = 64_000
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

  start(command: string, ready: ReadyWhen | null, cwd: string): Entry {
    const id = `task-${this.nextId++}`
    const child = execa(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { cwd, reject: false, windowsHide: true, all: true, buffer: false },
    ) as unknown as ExecaChild
    const entry: Entry = {
      id, command, child, buffer: '', dropped: 0, cursor: 0, markerSeen: false,
      ready, startedAt: Date.now(), exit: null,
    }
    child.all?.on('data', (chunk: Buffer) => {
      entry.buffer += chunk.toString('utf8')
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
    return entry
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

  async stop(entry: Entry): Promise<void> {
    if (entry.exit) return
    entry.child.kill()
    // PowerShell's own children can outlive it; take the whole tree down.
    const pid = entry.child.pid
    if (pid !== undefined) {
      await execa('taskkill', ['/PID', String(pid), '/T', '/F'],
        { reject: false, windowsHide: true })
    }
    entry.exit = { code: null, stopped: true }
  }

  async stopAll(): Promise<void> {
    for (const entry of this.entries.values()) await this.stop(entry)
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

export function backgroundTaskTool(tasks: BackgroundTasks): Tool<BackgroundTaskArgs> {
  return {
    name: 'background_task',
    readOnly: false,
    description:
      'Start, poll or stop a long-running process (dev server, watcher, long build). ' +
      'A process exiting is evidence, not completion — pass ready_when on start (a port ' +
      'that answers, a file that appears, or a log marker) and poll until "ready: YES". ' +
      'poll returns only output produced since the previous poll.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'poll', 'stop'] },
        command: { type: 'string', description: 'start only: PowerShell command line.' },
        id: { type: 'string', description: 'poll/stop: the id returned by start.' },
        wait_seconds: {
          type: 'integer',
          description: `poll only: wait up to this long for exit or readiness (max ${MAX_WAIT_S}).`,
        },
        ready_when: {
          type: 'object',
          description: 'start only: readiness condition to poll against.',
          properties: {
            port: { type: 'integer', description: 'TCP port on 127.0.0.1 that must answer.' },
            file: { type: 'string', description: 'Workspace-relative file that must exist.' },
            log_contains: { type: 'string', description: 'Substring that must appear in the output.' },
          },
        },
      },
      required: ['action'],
    },
    validate(raw) {
      const r = raw as Partial<BackgroundTaskArgs>
      if (r?.action !== 'start' && r?.action !== 'poll' && r?.action !== 'stop') {
        return { ok: false, error: 'action must be one of start, poll, stop' }
      }
      if (r.action === 'start') {
        if (typeof r.command !== 'string' || r.command.trim() === '') {
          return { ok: false, error: 'start needs a non-empty command' }
        }
      } else if (typeof r.id !== 'string' || r.id.trim() === '') {
        return { ok: false, error: `${r.action} needs the id returned by start` }
      }
      if (r.wait_seconds !== undefined &&
          (!Number.isInteger(r.wait_seconds) || r.wait_seconds < 0 || r.wait_seconds > MAX_WAIT_S)) {
        return { ok: false, error: `wait_seconds must be an integer from 0 to ${MAX_WAIT_S}` }
      }
      const args: BackgroundTaskArgs = { action: r.action }
      if (r.command !== undefined) args.command = r.command
      if (r.id !== undefined) args.id = r.id
      if (r.wait_seconds !== undefined) args.wait_seconds = r.wait_seconds
      if (r.ready_when !== undefined) args.ready_when = r.ready_when as ReadyWhen
      return { ok: true, args }
    },
    permissionKey(args): PermissionKey {
      // Only starting a process is a grantable capability; poll/stop are control ops on
      // something already approved and carry no command.
      return args.action === 'start'
        ? { tool: 'background_task', command: args.command ?? '' }
        : { tool: 'background_task' }
    },
    approvalPreview(args): ApprovalPreview {
      const cmd = (args.command ?? '').replace(/\s+/g, ' ').trim()
      return {
        summary: `background: ${cmd.length > 68 ? `${cmd.slice(0, 65)}...` : cmd}`,
        detail: `Start in the background (workspace root):\n${args.command ?? ''}`,
      }
    },
    async execute(args, ctx) {
      if (args.action === 'start') {
        const entry = tasks.start(args.command!, args.ready_when ?? null, ctx.workspace.root)
        const ready = args.ready_when
          ? ' Poll until it reports ready: YES before relying on it.'
          : ''
        return { ok: true, content: `Started, id: ${entry.id}.${ready}` }
      }
      const entry = tasks.get(args.id!)
      if (!entry) {
        return { ok: false, content: `No background task with id ${args.id}. Use the id start returned.` }
      }
      if (args.action === 'stop') {
        await tasks.stop(entry)
        return { ok: true, content: `${entry.id} stopped.` }
      }
      // poll
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
