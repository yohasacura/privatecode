import { execa } from 'execa'
import { existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The vendored Roslyn helper, as a process this side can talk to.
 *
 * Long-lived and lazy: the compilation is the expensive part (measured on a 1468-file
 * backend: 3.7 s to load, then 0.2–4.5 s per question), so it is built once on first use
 * and every question after that rides it. A helper that rebuilt per call would be slower
 * than the file reading it exists to replace.
 *
 * Located exactly the way ripgrep and the tree-sitter grammars are: an env var set by
 * whatever launched the sidecar, falling back to the copy vendored in this checkout when
 * nothing set one. The env var is how the packaged app points at its own staged copy; the
 * fallback is what keeps the CLI and the ws-bridge — neither of which sets it — from
 * advertising a tool they can never serve.
 */

export const ROSLYN_ENV = 'PRIVATECODE_ROSLYN'

/** The helper is one process per workspace; a second would pay for the compilation twice. */
let current: NavProcess | null = null

interface Pending {
  resolve(value: Record<string, unknown>): void
  reject(err: Error): void
  timer: NodeJS.Timeout
}

/** Loading is seconds; a question is sub-second. Both are bounded so a wedged helper
 * becomes an error the model can read rather than a turn that never ends. */
const LOAD_TIMEOUT_MS = 120_000
const ASK_TIMEOUT_MS = 60_000

/** Its own function so the child's type can be inferred once and referred to by name. */
function spawnHelper(exePath: string) {
  return execa(exePath, [], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    windowsHide: true,
    // No timeout on the process itself: it is meant to outlive any one call.
    reject: false,
    buffer: false,
  })
}

export class NavProcess {
  /**
   * No `ResultPromise` annotation, the same reason `browser/launcher.ts` records: execa 9
   * parameterises the type by the exact options object, and the generic-free form is not
   * assignable to it under exactOptionalPropertyTypes.
   */
  private child: ReturnType<typeof spawnHelper> | undefined
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''
  /** The root this helper has loaded, so a second workspace is a reload and not a lie. */
  private loadedRoot: string | null = null
  private loading: Promise<Record<string, unknown>> | null = null

  constructor(private readonly exePath: string) {}

  private start(): void {
    if (this.child !== undefined) return
    const child = spawnHelper(this.exePath)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    child.on('exit', () => {
      // Everything waiting dies with it, and the next call starts a fresh one rather than
      // hanging against a process that is gone.
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('the C# navigation helper exited'))
      }
      this.pending.clear()
      this.child = undefined
      this.loadedRoot = null
      this.loading = null
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
        reject(new Error(`the C# navigation helper did not answer "${op}" within ${timeoutMs / 1000}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child?.stdin?.write(`${JSON.stringify({ id, op, ...params })}\n`)
    })
  }

  /** Builds the index for `root` if it is not the one already loaded. Concurrent callers
   * share one load rather than starting several against a single-threaded helper. */
  async ensureLoaded(root: string): Promise<Record<string, unknown>> {
    if (this.loadedRoot === root) return { ok: true, cached: true }
    if (this.loading !== null) return this.loading
    this.loading = this.send('load', { root }, LOAD_TIMEOUT_MS)
      .then((r) => {
        if (r['ok'] === true) this.loadedRoot = root
        return r
      })
      .finally(() => { this.loading = null })
    return this.loading
  }

  async ask(op: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.send(op, params, ASK_TIMEOUT_MS)
  }

  async stop(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    try { child.stdin?.end() } catch { /* already gone */ }
    try { await child } catch { /* it exits non-zero when killed; not a failure here */ }
  }
}

/**
 * The shared helper, or `null` when this build has no vendored one.
 *
 * `null` is an ordinary answer, not a failure: the tool that uses this reports "C#
 * navigation is not available in this build" and the session continues with the file tools
 * it always had. A missing optional binary must never be a broken session.
 */
export function navProcess(): NavProcess | null {
  const exe = resolveHelper(process.env[ROSLYN_ENV], dirname(fileURLToPath(import.meta.url)))
  if (exe === null) return null
  if (current === null) current = new NavProcess(exe)
  return current
}

/**
 * Where the helper is, given what the environment says and where this module sits.
 *
 * Two sources, in order. The env var is how the packaged app points at its own staged copy,
 * and it wins when it names a file that exists. Otherwise the copy vendored in this checkout,
 * found relative to this module — which is what the Tauri launcher's variable was doing all
 * along and the CLI and ws-bridge never did, so those two advertised `csharp_nav` and could
 * only ever answer "not available in this build". A set-but-wrong variable falls through to
 * the vendored copy rather than failing: pointing at nothing is a stale launcher, not an
 * instruction to switch the feature off.
 *
 * Takes both inputs rather than reading them, so the rule can be tested rather than inferred.
 */
export function resolveHelper(fromEnv: string | undefined, moduleDir: string): string | null {
  if (fromEnv !== undefined && fromEnv.trim() !== '' && existsSync(fromEnv)) return fromEnv
  for (const up of ['../../..', '../../../..']) {
    const candidate = join(moduleDir, up, 'vendor', 'roslyn', 'roslyn-nav.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

export async function stopNavProcess(): Promise<void> {
  const p = current
  current = null
  await p?.stop()
}

/**
 * Absolute path from the helper into something the model can use.
 *
 * The helper reports the path it was given, which is absolute and — because it joins a
 * forward-slashed root to Windows-relative parts — mixed-separator. The model addresses
 * workspace-relative forward-slashed paths and nothing else, so this is not cosmetic: a
 * path it cannot pass back to `read_file` is a dead end.
 */
export function toWorkspacePath(absolute: string, workspaceRoot: string): string {
  const normalisedAbs = absolute.replace(/[\\/]+/g, sep)
  const normalisedRoot = workspaceRoot.replace(/[\\/]+/g, sep)
  const rel = relative(normalisedRoot, normalisedAbs)
  if (rel === '' || rel.startsWith('..')) return absolute.replace(/\\/g, '/')
  return rel.replace(/\\/g, '/')
}
