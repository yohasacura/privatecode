/**
 * A minimal Chrome DevTools Protocol client.
 *
 * CDP is a JSON-RPC dialect over one WebSocket: every request carries a monotonic `id` and
 * is answered by a frame carrying the same id; everything else is an event. In *flattened*
 * mode (`Target.attachToTarget({flatten: true})`) both directions also carry a `sessionId`
 * naming which attached target the message belongs to, which is what lets one socket serve
 * the browser and every page on it.
 *
 * Written by hand rather than pulled from a library on purpose: the whole protocol surface
 * this project needs is request/response, event dispatch, and a timeout, and Node 24 ships
 * a global `WebSocket`. Adding puppeteer-core for that would have been the single largest
 * dependency in a project whose entire point is that it runs offline from a folder.
 */

/** Nothing this client sends should take anywhere near this long against a local browser. */
const DEFAULT_TIMEOUT_MS = 30_000

export interface CdpError extends Error {
  /** The protocol-level error code, when the browser sent one rather than the socket failing. */
  code?: number
}

type Pending = {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

function cdpError(message: string, code?: number): CdpError {
  const e = new Error(message) as CdpError
  if (code !== undefined) e.code = code
  return e
}

export class CdpConnection {
  private readonly socket: WebSocket
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<(params: any, sessionId?: string) => void>>()
  private nextId = 1
  private closeReason: Error | null = null
  private resolveClosed!: (why: Error | null) => void

  /**
   * Resolves — never rejects — when the socket closes, carrying the reason as an Error when
   * the close was not a clean local `close()`. A caller awaiting teardown must not have to
   * wrap it in a try, and a floating rejection here would take the process down.
   */
  readonly closed: Promise<Error | null>

  private constructor(socket: WebSocket) {
    this.socket = socket
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve })
    socket.addEventListener('message', (ev) => this.onMessage(ev))
    socket.addEventListener('close', (ev) => {
      const why = this.closeReason ??
        cdpError(`the browser connection closed (code ${(ev as CloseEvent).code})`)
      this.failAll(why)
      this.resolveClosed(this.closeReason === null ? why : null)
    })
    socket.addEventListener('error', () => {
      // A WebSocket 'error' event carries no useful detail by design (it would leak
      // cross-origin information in a browser). The 'close' that follows is where the
      // reason lives, so this only makes sure a socket that errors without ever opening
      // does not leave callers waiting for a close that never comes.
      if (socket.readyState === WebSocket.CLOSED) {
        this.failAll(cdpError('the browser connection failed'))
      }
    })
  }

  static connect(wsUrl: string, opts: { timeoutMs?: number } = {}): Promise<CdpConnection> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = new WebSocket(wsUrl)
      } catch (e) {
        reject(cdpError(`could not open ${wsUrl}: ${(e as Error).message}`))
        return
      }
      const timer = setTimeout(() => {
        try { socket.close() } catch { /* already gone */ }
        reject(cdpError(`timed out connecting to the browser at ${wsUrl}`))
      }, timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new CdpConnection(socket))
      }, { once: true })
      socket.addEventListener('close', () => {
        clearTimeout(timer)
        // Harmless once `resolve` has already run: a settled promise ignores this.
        reject(cdpError(`the browser closed the connection to ${wsUrl} before it was ready`))
      }, { once: true })
    })
  }

  /**
   * One protocol call. Rejects on a protocol error, on the timeout, or if the socket closes
   * with the call still outstanding — a caller must never be left awaiting a browser that
   * has gone away.
   */
  send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(this.closeReason ?? cdpError(`${method}: the browser connection is not open`))
    }
    const id = this.nextId++
    const message: Record<string, unknown> = { id, method, params }
    if (sessionId !== undefined) message['sessionId'] = sessionId

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(cdpError(`${method} did not answer within ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.socket.send(JSON.stringify(message))
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(cdpError(`${method} could not be sent: ${(e as Error).message}`))
      }
    })
  }

  /** Subscribe to a CDP event. Returns the unsubscribe function. */
  on(event: string, fn: (params: any, sessionId?: string) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn)
    return () => { set!.delete(fn) }
  }

  close(): void {
    if (this.closeReason === null) this.closeReason = cdpError('the connection was closed locally')
    try { this.socket.close() } catch { /* already gone */ }
  }

  private onMessage(ev: MessageEvent): void {
    let frame: any
    try {
      frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    } catch {
      return // A frame we cannot parse is a frame we cannot act on; dropping it is all there is.
    }

    if (typeof frame?.id === 'number') {
      const pending = this.pending.get(frame.id)
      if (!pending) return // A late answer to a call that already timed out.
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.error) {
        pending.reject(cdpError(`${pending.method}: ${frame.error.message ?? 'protocol error'}`, frame.error.code))
      } else {
        pending.resolve(frame.result ?? {})
      }
      return
    }

    if (typeof frame?.method === 'string') {
      const set = this.listeners.get(frame.method)
      if (!set) return
      // Copied before iterating: a listener that unsubscribes itself (the one-shot
      // navigation waiters in page.ts all do) would otherwise mutate the set mid-loop.
      for (const fn of [...set]) {
        try {
          fn(frame.params ?? {}, frame.sessionId)
        } catch { /* a listener's failure is not the connection's */ }
      }
    }
  }

  private failAll(why: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(why)
    }
    this.pending.clear()
  }
}
