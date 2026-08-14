import { execa } from 'execa'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The vendored SQL helper, as a process this side can talk to.
 *
 * Long-lived and lazy for the same reason as the C# navigator: opening a connection and
 * reading a schema is the expensive part, and a helper restarted per call would cost more
 * than the questions it answers. It is started on first use and every question after that
 * rides it.
 *
 * Located exactly the way `roslyn-nav` is: an env var set by whatever launched the sidecar,
 * falling back to the copy vendored in this checkout. The fallback is not optional politeness
 * — the CLI and the ws-bridge set no variable, and without it a tool would be advertised on
 * those paths and be permanently unable to answer.
 *
 * It ships as TWO files. `Microsoft.Data.SqlClient.SNI.dll` is a native library that
 * `PublishSingleFile` leaves beside the exe, and without it the process starts and then
 * cannot connect to anything — which is why `resolveHelper` checks for the sibling rather
 * than only the exe.
 */

export const SQL_ENV = 'PRIVATECODE_SQL'

/**
 * The native siblings a single-file publish leaves outside the exe.
 *
 * Their absence is a broken install rather than a missing feature, and the difference is
 * worth reporting here instead of discovering it at connect time — an exe without them starts
 * cleanly and then fails with a message naming nothing that is actually wrong.
 *
 * This list is not a guess and it is not stable: it grew from one entry to two the moment
 * DacFx was added, which is exactly how a check like this goes quietly out of date. It must
 * match what `dotnet publish` puts beside the exe — see `vendor/sql/PROVENANCE.md`, and the
 * whole-directory staging in `bundle.mjs` that is the real protection.
 */
const NATIVE_SIBLINGS = [
  'Microsoft.Data.SqlClient.SNI.dll',
  'SqlServerSpatial160.dll',
]

let current: SqlProcess | null = null

interface Pending {
  resolve(value: Record<string, unknown>): void
  reject(err: Error): void
  timer: NodeJS.Timeout
}

/** Connecting can wait on a server that is asleep; a query should not run all day. Both are
 * bounded so a wedged helper becomes an error the model can read rather than a turn that
 * never ends. */
const CONNECT_TIMEOUT_MS = 45_000
const ASK_TIMEOUT_MS = 60_000

function spawnHelper(exePath: string) {
  return execa(exePath, [], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    windowsHide: true,
    reject: false,
    buffer: false,
  })
}

export class SqlProcess {
  private child: ReturnType<typeof spawnHelper> | undefined
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''
  /** The connection string this helper has open, so a second workspace is a reconnect and
   * not a lie about which database answered. */
  private connectedTo: string | null = null
  private connecting: Promise<Record<string, unknown>> | null = null

  constructor(private readonly exePath: string) {}

  private start(): void {
    if (this.child !== undefined) return
    const child = spawnHelper(this.exePath)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    child.on('exit', () => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('the SQL helper exited'))
      }
      this.pending.clear()
      this.child = undefined
      this.connectedTo = null
      this.connecting = null
    })
    this.child = child
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.trim() === '') continue
      let msg: Record<string, unknown>
      try { msg = JSON.parse(line) as Record<string, unknown> } catch { continue }
      const id = typeof msg['id'] === 'number' ? msg['id'] : -1
      const waiting = this.pending.get(id)
      if (waiting === undefined) continue
      this.pending.delete(id)
      clearTimeout(waiting.timer)
      waiting.resolve(msg)
    }
  }

  private send(op: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    this.start()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the SQL helper did not answer "${op}" within ${timeoutMs / 1000}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child?.stdin?.write(`${JSON.stringify({ id, op, ...params })}\n`)
    })
  }

  /** Connects if this is not already the open connection. Concurrent callers share one
   * attempt rather than racing a single-threaded helper. */
  async ensureConnected(connectionString: string): Promise<Record<string, unknown>> {
    if (this.connectedTo === connectionString) return { ok: true, cached: true }
    if (this.connecting !== null) return this.connecting
    this.connecting = this.send('connect', { connectionString }, CONNECT_TIMEOUT_MS)
      .then((r) => {
        if (r['ok'] === true) this.connectedTo = connectionString
        return r
      })
      .finally(() => { this.connecting = null })
    return this.connecting
  }

  async ask(op: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.send(op, params, ASK_TIMEOUT_MS)
  }

  async stop(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    try { child.stdin?.end() } catch { /* already gone */ }
    try { await child } catch { /* non-zero on kill; not a failure here */ }
  }
}

/**
 * The shared helper, or `null` when this build has no vendored one.
 *
 * `null` is an ordinary answer: the tool reports that database access is not available in
 * this build and the session carries on. A missing optional binary must never be a broken
 * session.
 */
export function sqlProcess(): SqlProcess | null {
  const exe = resolveHelper(process.env[SQL_ENV], moduleDir())
  if (exe === null) return null
  if (current === null) current = new SqlProcess(exe)
  return current
}

/**
 * This module's directory, or null in the shipped build.
 *
 * The sidecar is bundled to CommonJS, where esbuild compiles `import.meta` to `{}` — so
 * `import.meta.url` is `undefined` and `fileURLToPath` on it THROWS. Every sibling that
 * resolves a vendored asset this way (`search-code.ts`, `tree-sitter.ts`) gets away with it
 * only because it checks its environment variable first and returns before touching
 * `import.meta`. Passing the directory as an eagerly-evaluated argument removed that
 * protection, which is how the same line broke `csharp_nav` in the packaged app while every
 * test and the whole CLI — real ES modules — kept passing.
 *
 * Null is the right answer rather than an error: in the packaged build the launcher sets the
 * variable, so there is nothing to fall back to and nothing has gone wrong.
 */
function moduleDir(): string | null {
  const url = import.meta.url as string | undefined
  if (typeof url !== 'string' || url === '') return null
  return dirname(fileURLToPath(url))
}

/**
 * Where the helper is, given what the environment says and where this module sits.
 *
 * The env var wins when it names a file that exists; otherwise the copy vendored in this
 * checkout, found relative to this module. A set-but-wrong variable falls through rather than
 * switching the feature off: pointing at nothing is a stale launcher, not an instruction.
 *
 * Both the exe AND its native sibling must be present. Accepting an exe whose SNI library was
 * left behind would trade a clear "not available in this build" for a connection that fails
 * with a network error naming nothing that is actually wrong.
 */
export function resolveHelper(fromEnv: string | undefined, from: string | null): string | null {
  if (fromEnv !== undefined && fromEnv.trim() !== '' && complete(fromEnv)) return fromEnv
  if (from === null) return null
  for (const up of ['../../..', '../../../..']) {
    const candidate = join(from, up, 'vendor', 'sql', 'sql-probe.exe')
    if (complete(candidate)) return candidate
  }
  return null
}

function complete(exePath: string): boolean {
  if (!existsSync(exePath)) return false
  const beside = dirname(exePath)
  return NATIVE_SIBLINGS.every((dll) => existsSync(join(beside, dll)))
}

export async function stopSqlProcess(): Promise<void> {
  const p = current
  current = null
  await p?.stop()
}
