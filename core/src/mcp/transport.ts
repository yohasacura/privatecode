import { execa } from 'execa'
import type { JsonRpcMessage } from './protocol.js'

/**
 * The two ways to reach an MCP server.
 *
 * Both are reduced to the same three-method interface, so `McpClient` never branches on
 * which one it is talking to — the JSON-RPC bookkeeping is identical, and the differences
 * (a pipe versus a POST, a process versus a session header) belong here.
 */
export interface McpTransport {
  send(message: JsonRpcMessage): Promise<void>
  onMessage(fn: (m: any) => void): void
  onClose(fn: (why: string) => void): void
  close(): Promise<void>
  /** For error messages: what the user wrote in their settings. */
  readonly describe: string
}

export interface StdioServerSpec {
  kind: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface HttpServerSpec {
  kind: 'http'
  url: string
  headers?: Record<string, string>
}

export type ServerSpec = StdioServerSpec | HttpServerSpec

/** Keep the tail: a stack trace's last lines say what actually failed. */
const MAX_STDERR_CHARS = 8_000

/** How long a server gets to exit on its own after stdin closes, before it is killed. */
const GRACEFUL_EXIT_MS = 1_500

// Extracted so the field below can be typed as `ReturnType<typeof spawnServer>`: execa 9
// parameterises `ResultPromise` by the exact options object, and the generic-free form is
// not assignable to it under exactOptionalPropertyTypes.
function spawnServer(spec: StdioServerSpec) {
  return execa(spec.command, spec.args ?? [], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    // The parent env plus the spec's: an MCP server routinely needs PATH, and the spec's
    // own vars come from a file only the user can write (`.privatecode/` is write-denied
    // to every model-issued tool), which is what makes running this acceptable at all.
    env: { ...process.env, ...(spec.env ?? {}) },
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    reject: false,
    windowsHide: true,
    // A server spawned through a shell wrapper (npx, uvx) is the common case on Windows,
    // where those are `.cmd` shims Node cannot spawn directly. The cost is that our direct
    // child is cmd.exe, which is why `close()` kills the tree rather than the child.
    shell: process.platform === 'win32',
  })
}

export class StdioTransport implements McpTransport {
  readonly describe: string
  private readonly child: ReturnType<typeof spawnServer>
  private readonly handlers: ((m: any) => void)[] = []
  private readonly closeHandlers: ((why: string) => void)[] = []
  private buffer = ''
  private stderr = ''
  private closed = false
  /**
   * Resolves when the process is gone. Created HERE, in the constructor, not inside
   * `close()`: a server that crashed on startup has already exited by the time anyone calls
   * close, so a listener attached then never fires and the shutdown waits out its full grace
   * period for a process that died seconds ago. Measured: 3.7 s to report a crash that took
   * 40 ms to happen.
   */
  private readonly exited: Promise<void>

  constructor(spec: StdioServerSpec) {
    this.describe = `${spec.command} ${(spec.args ?? []).join(' ')}`.trim()
    this.child = spawnServer(spec)

    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (chunk: string) => {
      // The single most common failure is a server that prints a stack trace and exits.
      // Without its stderr the user gets "the connection closed" and nothing else.
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_CHARS)
    })
    let resolveExited!: () => void
    this.exited = new Promise<void>((resolve) => { resolveExited = resolve })
    this.child.on('exit', (code) => {
      resolveExited()
      this.fail(`the server exited (code ${code ?? '?'})`)
    })
    this.child.on('error', (e: Error) => {
      resolveExited()
      this.fail(`the server could not be started: ${e.message}`)
    })
  }

  /** Whatever the server wrote to stderr, for an error message that explains itself. */
  stderrTail(): string {
    return this.stderr.trim()
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error('the server connection is closed')
    const line = `${JSON.stringify(message)}\n`
    await new Promise<void>((resolve, reject) => {
      const stdin = this.child.stdin
      if (!stdin) {
        reject(new Error('the server has no stdin'))
        return
      }
      stdin.write(line, (e) => (e ? reject(e) : resolve()))
    })
  }

  onMessage(fn: (m: any) => void): void {
    this.handlers.push(fn)
  }

  onClose(fn: (why: string) => void): void {
    this.closeHandlers.push(fn)
  }

  /**
   * Shuts the server down the way the stdio transport specifies: close stdin, let it exit,
   * and only then kill.
   *
   * The kill is a TREE kill on Windows, and that is load-bearing rather than belt-and-braces.
   * `shell: true` above is required there — npx and uvx are `.cmd` shims that Node cannot
   * spawn directly — which means our direct child is `cmd.exe`, and `child.kill()` kills the
   * shim while the actual server process keeps running with our pipes open. Measured: a test
   * that closed a client still had the server alive five seconds later.
   */
  async close(): Promise<void> {
    this.closed = true
    try {
      this.child.stdin?.end()
    } catch { /* already gone */ }
    const gone = await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), GRACEFUL_EXIT_MS)),
    ])
    if (gone) return

    const pid = this.child.pid
    if (pid !== undefined && process.platform === 'win32') {
      try {
        await execa('taskkill', ['/PID', String(pid), '/T', '/F'], { reject: false, windowsHide: true })
      } catch { /* nothing more to try */ }
    }
    try {
      this.child.kill()
    } catch { /* already gone */ }
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 2_000))])
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // Servers do print the occasional stray line to stdout. Dropping it is right —
        // the alternative is tearing down a working connection over a log message.
        continue
      }
      for (const fn of this.handlers) fn(parsed)
    }
  }

  private fail(why: string): void {
    if (this.closed) return
    this.closed = true
    const tail = this.stderrTail()
    const message = tail === '' ? why : `${why}\n${tail}`
    for (const fn of this.closeHandlers) fn(message)
  }
}

/**
 * Streamable HTTP: every message is a POST, and the response is either one JSON object or
 * an SSE stream of them.
 *
 * There is no long-lived GET stream here. That channel exists so a server can push
 * unsolicited notifications, and this client subscribes to nothing — every message it cares
 * about is the answer to something it just sent. Opening a stream to receive notifications
 * for capabilities we do not implement would be a connection held open for nothing.
 */
export class HttpTransport implements McpTransport {
  readonly describe: string
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly handlers: ((m: any) => void)[] = []
  private readonly closeHandlers: ((why: string) => void)[] = []
  private sessionId: string | null = null
  private closed = false

  constructor(spec: HttpServerSpec) {
    this.describe = spec.url
    this.url = spec.url
    this.headers = spec.headers ?? {}
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error('the server connection is closed')
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.headers,
    }
    if (this.sessionId !== null) headers['mcp-session-id'] = this.sessionId

    let response: Response
    try {
      response = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(message) })
    } catch (e) {
      throw new Error(`could not reach ${this.url}: ${(e as Error).message}`)
    }

    const returned = response.headers.get('mcp-session-id')
    if (returned) this.sessionId = returned

    if (!response.ok) {
      // Header NAMES, never their values: an Authorization value is the whole secret, and
      // this string ends up in a problem the UI displays.
      const sent = Object.keys(this.headers).join(', ') || 'none'
      throw new Error(
        `${this.url} answered ${response.status} ${response.statusText}` +
        (response.status === 401 || response.status === 403
          ? ` (headers sent: ${sent}). Check the token in your settings.`
          : ''),
      )
    }

    // 202 with no body is the correct answer to a notification.
    if (response.status === 202 || response.headers.get('content-length') === '0') return

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      await this.readEventStream(response)
      return
    }
    const text = await response.text()
    if (text.trim() === '') return
    this.dispatch(text)
  }

  onMessage(fn: (m: any) => void): void {
    this.handlers.push(fn)
  }

  onClose(fn: (why: string) => void): void {
    this.closeHandlers.push(fn)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.sessionId === null) return
    // Best-effort: a server that does not implement session deletion is not a problem.
    try {
      await fetch(this.url, {
        method: 'DELETE',
        headers: { ...this.headers, 'mcp-session-id': this.sessionId },
      })
    } catch { /* the session will time out on its own */ }
  }

  /** Reads `data:` frames until the stream ends. */
  private async readEventStream(response: Response): Promise<void> {
    const body = response.body
    if (!body) return
    const decoder = new TextDecoder()
    let buffer = ''
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE events are separated by a blank line; a single event may span several
        // `data:` lines, which are joined with newlines.
        for (;;) {
          const split = buffer.search(/\r?\n\r?\n/)
          if (split === -1) break
          const raw = buffer.slice(0, split)
          buffer = buffer.slice(split).replace(/^\r?\n\r?\n/, '')
          const data = raw.split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n')
          if (data !== '') this.dispatch(data)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private dispatch(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    for (const m of messages) {
      for (const fn of this.handlers) fn(m)
    }
  }
}
