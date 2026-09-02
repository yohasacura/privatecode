import { execa } from 'execa'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve as pathResolve, sep } from 'node:path'
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
  /** Files written since the helper last saw them, by absolute path. See `markDirty`. */
  private readonly dirty = new Set<string>()
  /** Set by `stop()` and never cleared: a stopped helper must stay stopped. Without it, a
   * caller that kept its own reference across a workspace switch — the background edge
   * harvest is exactly that caller — would have its next question respawn the exe AFTER
   * `stopNavProcess()` dropped this instance, leaving a .NET process nothing can ever
   * reach again. A crash is different: `stopped` stays false there, so the established
   * restart-on-next-call behavior for a died helper is untouched. */
  private stopped = false

  constructor(private readonly exePath: string) {}

  private start(): void {
    if (this.stopped) throw new Error('the C# navigation helper was stopped')
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
    if (this.loadedRoot === root) {
      await this.flushDirty()
      // The flush may have found a helper too old to sync and dropped the index.
      if (this.loadedRoot === root) return { ok: true, cached: true }
    }
    if (this.loading !== null) return this.loading
    this.dirty.clear()
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

  /** The loaded compilation no longer describes the code. See `noteWorkspaceWrite`. */
  invalidate(): void {
    this.loadedRoot = null
    this.dirty.clear()
  }

  /**
   * One file changed on disk. Remembered rather than acted on: the next question re-reads
   * exactly these files into the index (`sync`), which is a parse of one file where the old
   * rule was a reload of the tree — 0.5–12 s, paid after every edit that a question followed.
   * A file outside the loaded root is not in the index and is not remembered.
   */
  markDirty(absolutePath: string): void {
    if (this.loadedRoot === null) return
    if (!isUnder(absolutePath, this.loadedRoot)) return
    this.dirty.add(absolutePath)
  }

  private async flushDirty(): Promise<void> {
    if (this.dirty.size === 0) return
    const files = [...this.dirty]
    this.dirty.clear()
    let reply: Record<string, unknown>
    try {
      reply = await this.send('sync', { files }, ASK_TIMEOUT_MS)
    } catch {
      this.loadedRoot = null
      return
    }
    // A helper from before `sync` existed answers "unknown op"; the reload it always did
    // is still the right answer there.
    if (reply['ok'] !== true) this.loadedRoot = null
  }

  /**
   * The compile errors the code has now, from the helper's own compilation, or `null` when
   * the helper cannot say — an older build without the op, an index that failed to load. The
   * caller falls back to the project's real build; a null here is "not available", never
   * "no errors".
   */
  async diagnostics(root: string, files: string[]): Promise<CsharpDiagnostics | null> {
    let loaded: Record<string, unknown>
    try {
      loaded = await this.ensureLoaded(root)
    } catch {
      return null
    }
    if (loaded['ok'] !== true) return null
    for (const f of files) this.dirty.delete(f)
    let reply: Record<string, unknown>
    try {
      reply = await this.send('diagnostics', { files }, ASK_TIMEOUT_MS)
    } catch {
      return null
    }
    if (reply['ok'] !== true) return null
    const rows = Array.isArray(reply['errors']) ? reply['errors'] as Record<string, unknown>[] : []
    return {
      errors: rows.map((r) => ({
        file: typeof r['file'] === 'string' ? r['file'] : '',
        line: typeof r['line'] === 'number' ? r['line'] : 0,
        column: typeof r['column'] === 'number' ? r['column'] : 0,
        code: typeof r['code'] === 'string' ? r['code'] : '',
        message: typeof r['message'] === 'string' ? r['message'] : '',
      })),
      reported: typeof reply['reported'] === 'number' ? reply['reported'] : rows.length,
      suppressed: typeof reply['suppressed'] === 'number' ? reply['suppressed'] : 0,
      baseline: typeof reply['baseline'] === 'number' ? reply['baseline'] : 0,
      bound: typeof reply['bound'] === 'number' ? reply['bound'] : 0,
      trees: typeof reply['trees'] === 'number' ? reply['trees'] : 0,
      ms: typeof reply['ms'] === 'number' ? reply['ms'] : 0,
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    const child = this.child
    if (child === undefined) return
    try { child.stdin?.end() } catch { /* already gone */ }
    try { await child } catch { /* it exits non-zero when killed; not a failure here */ }
  }
}

export interface CsharpError {
  /** Absolute, as the helper reports it; `toWorkspacePath` makes it addressable. */
  file: string
  line: number
  column: number
  code: string
  message: string
}

export interface CsharpDiagnostics {
  /** At most thirty; `reported` says how many there were. */
  errors: CsharpError[]
  reported: number
  /** Errors the tree already had at load and which are not this edit's to answer for. */
  suppressed: number
  baseline: number
  /** Files whose bodies were bound to answer; the tree has `trees` in all. */
  bound: number
  trees: number
  ms: number
}

/** `abs` is `root` or inside it, ignoring case and separator spelling. */
function isUnder(abs: string, root: string): boolean {
  const a = pathResolve(abs).toLowerCase()
  const r = pathResolve(root).toLowerCase()
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Which folder the C# index is built over.
 *
 * The helper takes ONE root, so a multi-folder workspace has to choose. The solution file is
 * the honest signal — a `.sln` or `.csproj` is what makes a folder a C# project — and the
 * primary folder is only the fallback for when nothing says otherwise, which is also the
 * single-folder case. Checked shallowly on purpose: a solution lives at the top of its
 * project, and walking every mount deeply on each call would cost more than the answer.
 */
export function csharpRoot(workspace: { mounts: readonly { root: string }[]; root: string }): string {
  for (const mount of workspace.mounts) {
    let entries: string[]
    try {
      entries = readdirSync(mount.root)
    } catch {
      continue
    }
    if (entries.some((e) => e.toLowerCase().endsWith('.sln') || e.toLowerCase().endsWith('.csproj'))) {
      return mount.root
    }
  }
  return workspace.root
}

/**
 * The instant C# check: the errors `files` (absolute paths, all `.cs`) left the compilation
 * with, or `null` when there is no helper to ask. The session runs this after an edit where
 * it used to run the build, and still runs the build when the turn ends — this compilation
 * is faithful enough to say "you broke X" in 300 ms, not faithful enough to replace the
 * command the owner wrote into the settings.
 */
export async function csharpCheck(root: string, files: string[]): Promise<CsharpDiagnostics | null> {
  const nav = navProcess()
  if (nav === null) return null
  return nav.diagnostics(root, files)
}

/**
 * The shared helper, or `null` when this build has no vendored one.
 *
 * `null` is an ordinary answer, not a failure: the tool that uses this reports "C#
 * navigation is not available in this build" and the session continues with the file tools
 * it always had. A missing optional binary must never be a broken session.
 */
export function navProcess(): NavProcess | null {
  const exe = resolveHelper(process.env[ROSLYN_ENV], moduleDir())
  if (exe === null) return null
  if (current === null) current = new NavProcess(exe)
  return current
}

/**
 * This module's directory, or null in the shipped build.
 *
 * The sidecar is bundled to CommonJS, where esbuild compiles `import.meta` to `{}` — so
 * `import.meta.url` is `undefined` and `fileURLToPath` on it THROWS. `search-code.ts` and
 * `tree-sitter.ts` do the same thing safely only because they check their environment
 * variable first and return before touching `import.meta`; passing the directory as an
 * eagerly-evaluated argument removed exactly that protection, and `navProcess()` threw on
 * every call in the packaged app — while the CLI and every test, which are real ES modules,
 * went on passing. Found by reading the bundler's own warning rather than by anything failing.
 *
 * Null rather than an error: in the packaged build the launcher sets the variable, so there
 * is nothing to fall back to and nothing has gone wrong.
 */
function moduleDir(): string | null {
  const url = import.meta.url as string | undefined
  if (typeof url !== 'string' || url === '') return null
  return dirname(fileURLToPath(url))
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
export function resolveHelper(fromEnv: string | undefined, from: string | null): string | null {
  if (fromEnv !== undefined && fromEnv.trim() !== '' && existsSync(fromEnv)) return fromEnv
  // Null means the caller could not work out where it lives — a CommonJS bundle — and the
  // env var is then the only answer there is.
  if (from === null) return null
  for (const up of ['../../..', '../../../..']) {
    const candidate = join(from, up, 'vendor', 'roslyn', 'roslyn-nav.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Told that a file changed, so the next question is answered about the code as it is now.
 *
 * `ensureLoaded` returns `{ ok: true, cached: true }` whenever the root matches the one it
 * loaded, and nothing but the helper dying ever cleared that. So the compilation was built
 * once per workspace and every answer after the session's first edit described the code as it
 * had been at load time — with `ok: true`, which is what makes it the same failure this tool
 * already had once: confidently wrong rather than unavailable.
 *
 * It went unnoticed because the seven sessions that certified the tool ran in PLAN mode, where
 * no write is possible. It bites in exactly the sessions this is for.
 *
 * Remembering the file rather than reloading here: a reload costs 0.5-12 s depending on the
 * project, and most writes are never followed by another navigation question. The next `ask`
 * re-reads exactly the files that changed (`NavProcess.markDirty`), and only if there is one.
 *
 * Takes the ABSOLUTE path: the model's own workspace-relative spelling is relative to the
 * workspace, and in a multi-folder workspace the index is rooted at one folder of it.
 */
export function noteWorkspaceWrite(absolutePath: string): void {
  if (!absolutePath.toLowerCase().endsWith('.cs')) return
  current?.markDirty(absolutePath)
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
