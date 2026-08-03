import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  HostEventMap,
  HostEventName,
  HostMethodMap,
  HostMethodName,
  HostOutbound,
} from '@core/host/protocol'

/**
 * The frontend half of the Plan 4 protocol client: one small `ProtocolClient` interface,
 * backed by either of two transports that both move whole ndjson lines --
 *
 * - **Tauri IPC** (`TauriTransport`): `invoke('sidecar_send', { line })` to send, and the
 *   `sidecar-line` event (see `app/src-tauri/src/main.rs`) to receive. This is the ONLY
 *   transport a release build ever uses.
 * - **Dev WebSocket bridge** (`WsTransport`): a plain `WebSocket` to `core/src/host/
 *   ws-bridge.ts`'s `ws://127.0.0.1:<port>/?token=<token>` URL. This is what lets the
 *   controller drive the real frontend from a plain browser tab with no Tauri window at
 *   all -- selected purely by the presence of a `?ws=<url>` query parameter (see
 *   `transportFromLocation`), and never reachable in a release build's own URL space.
 *
 * All strict protocol TYPES (`HostEventMap`, `HostMethodMap`, ...) come from core's
 * `src/host/protocol.ts` via the `@core/*` tsconfig path alias, imported with `import
 * type` everywhere in this file -- erased entirely at build time, so no core runtime code
 * is pulled into the app bundle through this alias (see tsconfig.json's own comment on the
 * same point). The one exception is `isHostOutboundEvent` below: a three-line predicate
 * deliberately REIMPLEMENTED here rather than importing core's `isHostEvent` runtime
 * function, so the cross-package dependency stays strictly types-only end to end.
 */

function isHostOutboundEvent(msg: HostOutbound): msg is Extract<HostOutbound, { event: string }> {
  return 'event' in msg
}

/** The wire shape a `HostRequest` takes on this side -- constructed locally rather than
 * imported, for the same types-only reason as `isHostOutboundEvent` above (this is a
 * plain object literal, not logic, so "no duplicate type definitions" does not apply: its
 * shape is still exactly `HostRequest` from protocol.ts, referenced by the call sites'
 * generic parameters, not redeclared). */
interface WireRequest { id: number; method: string; params?: unknown }

/** One raw duplex line-channel: whole ndjson lines in, whole ndjson lines out. Framing
 * (one JSON value per line) is guaranteed by both backing transports already -- a Tauri
 * event payload is one already-complete line (main.rs's `BufReader::lines()` guarantees
 * that), and a WebSocket text message is one already-complete frame (`ws-bridge.ts` sends
 * exactly one `encodeLine()` result per `ws.send()` call) -- so, unlike the stdio
 * transport, NEITHER side of this needs `LineDecoder`'s partial-chunk reassembly. */
interface RawTransport {
  send(line: string): void
  onLine(cb: (line: string) => void): void
  /** Fires once the channel is actually usable. Tauri IPC has no handshake at all -- it
   * is ready the instant it exists, so `TauriTransport` invokes `cb` synchronously,
   * before `onOpen` even returns. The WebSocket transport genuinely has to wait for its
   * connection to complete first (see `WsTransport`'s own comment on the bug this caught:
   * a `send()` issued before that finishes must not be silently dropped). */
  onOpen(cb: () => void): void
  /** Fires at most once, when the underlying channel is known to be gone. */
  onClose(cb: () => void): void
  close(): void
}

class TauriTransport implements RawTransport {
  private lineUnlisten: UnlistenFn | undefined
  private closeUnlisten: UnlistenFn | undefined
  private lineCbs: Array<(line: string) => void> = []
  private closeCbs: Array<() => void> = []

  constructor() {
    void listen<string>('sidecar-line', (event) => {
      for (const cb of this.lineCbs) cb(event.payload)
    }).then((un) => { this.lineUnlisten = un })
    void listen('sidecar-exit', () => {
      for (const cb of this.closeCbs) cb()
    }).then((un) => { this.closeUnlisten = un })
  }

  send(line: string): void {
    void invoke('sidecar_send', { line })
  }
  onOpen(cb: () => void): void { cb() }
  onLine(cb: (line: string) => void): void { this.lineCbs.push(cb) }
  onClose(cb: () => void): void { this.closeCbs.push(cb) }
  close(): void {
    this.lineUnlisten?.()
    this.closeUnlisten?.()
  }
}

class WsTransport implements RawTransport {
  private ws: WebSocket
  private lineCbs: Array<(line: string) => void> = []
  private closeCbs: Array<() => void> = []
  /** Lines sent before the WebSocket handshake completes -- `new WebSocket(url)` returns
   * immediately with `readyState === CONNECTING`, but `ProtocolClientImpl` starts
   * accepting `call()`s the instant it is constructed (see its own doc comment on why
   * 'open' is set optimistically for both transports). Caught the same way as the
   * state-replay bug above: a `status` call fired right after `createClient()` was
   * silently dropped on the floor (`ws.send()` throws if the socket isn't OPEN, so the
   * naive version of this either lost the line outright or threw past its caller) and its
   * promise hung forever. Queued here and flushed in the 'open' handler instead. */
  private queue: string[] = []
  private openCbs: Array<() => void> = []

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.addEventListener('open', () => {
      for (const line of this.queue) this.ws.send(line)
      this.queue = []
      for (const cb of this.openCbs) cb()
    })
    this.ws.addEventListener('message', (event: MessageEvent<string>) => {
      const text = typeof event.data === 'string' ? event.data : ''
      if (text === '') return
      for (const cb of this.lineCbs) cb(text)
    })
    this.ws.addEventListener('close', () => {
      for (const cb of this.closeCbs) cb()
    })
  }

  send(line: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(line)
    else this.queue.push(line)
  }
  onLine(cb: (line: string) => void): void { this.lineCbs.push(cb) }
  onOpen(cb: () => void): void {
    if (this.ws.readyState === WebSocket.OPEN) cb()
    else this.openCbs.push(cb)
  }
  onClose(cb: () => void): void { this.closeCbs.push(cb) }
  close(): void { this.ws.close() }
}

/**
 * The agent process's recent stderr, newest last. Tauri builds only.
 *
 * This is the only channel that can explain WHY the agent is not answering, and the
 * unreachable-agent screen shows it verbatim rather than paraphrasing: a Node stack trace
 * or a missing-file path is worth more than any message this app could invent.
 */
export async function sidecarStderr(): Promise<string[]> {
  try {
    return await invoke<string[]>('sidecar_stderr')
  } catch {
    return []
  }
}

/** Stops and restarts the agent process. Tauri builds only. The caller reloads the window
 * afterwards: a fresh sidecar means a fresh `SessionHost`, and reloading is the honest way
 * to get the frontend's own state back in step with it. */
export async function restartSidecar(): Promise<void> {
  await invoke('restart_sidecar')
}

/**
 * Resolves `promise`, or rejects with `message` after `ms`.
 *
 * Used for the very first request of a run. Every failure mode of the agent process --
 * spawned-then-killed, crashed before the WebView registered its `sidecar-exit` listener
 * (a Tauri event fired before a listener exists is simply lost), a pipe that never
 * connects -- looks identical from here: a promise that never settles. Without this the
 * window sat on "starting the agent…" forever with no way out, which is exactly what it
 * did the first time it was run for real.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))) },
    )
  })
}

/** `?ws=<url>` selects the dev WebSocket bridge; its absence means "real Tauri IPC". Read
 * from `window.location.search` by the caller (kept out of this module so it stays
 * testable without a DOM `location`). */
export function wsUrlFromSearch(search: string): string | undefined {
  const url = new URLSearchParams(search).get('ws')
  return url ?? undefined
}

export type ConnectionState = 'connecting' | 'open' | 'closed'

export interface ProtocolClient {
  /** Calls one host method, resolving with its typed result or rejecting with the error
   * reply's message. Every call gets a fresh id; replies are matched back to their
   * pending call by that id, same as `core/src/host/host.ts`'s own request/reply
   * contract. */
  call<M extends HostMethodName>(
    method: M,
    params: HostMethodMap[M]['params'],
  ): Promise<HostMethodMap[M]['result']>
  /** Subscribes to one event name; returns an unsubscribe function. Multiple subscribers
   * to the same event are all called, in subscription order. */
  on<K extends HostEventName>(event: K, handler: (data: HostEventMap[K]) => void): () => void
  onStateChange(handler: (state: ConnectionState) => void): () => void
  state(): ConnectionState
  close(): void
}

class ProtocolClientImpl implements ProtocolClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private listeners = new Map<string, Set<(data: unknown) => void>>()
  private stateListeners = new Set<(state: ConnectionState) => void>()
  private currentState: ConnectionState = 'connecting'

  constructor(private readonly transport: RawTransport) {
    transport.onLine((line) => this.handleLine(line))
    // The transport can close on its own (a WS drop, the sidecar exiting) as well as via
    // our own `close()` -- either way, every call still waiting on a reply that will now
    // never arrive must be rejected, not left hanging forever.
    transport.onClose(() => {
      this.setState('closed')
      this.rejectAllPending('protocol transport closed')
    })
    // 'open' is reported only once the TRANSPORT says it is actually ready -- see
    // `RawTransport.onOpen`'s doc comment. `TauriTransport` fires this synchronously
    // (Tauri IPC has no handshake); `WsTransport` waits for the real WebSocket 'open'
    // event, and (just as importantly) queues any `call()` issued before then instead of
    // dropping it -- see `WsTransport`'s own comment on the bug this fixed.
    transport.onOpen(() => this.setState('open'))
  }

  private setState(next: ConnectionState): void {
    if (this.currentState === next) return
    this.currentState = next
    for (const cb of this.stateListeners) cb(next)
  }

  private handleLine(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return // a malformed line here is a transport bug, not something the UI can act on
    }
    if (typeof msg !== 'object' || msg === null) return
    const outbound = msg as HostOutbound
    if (isHostOutboundEvent(outbound)) {
      const handlers = this.listeners.get(outbound.event)
      if (handlers) for (const h of handlers) h(outbound.data)
      return
    }
    if ('id' in outbound) {
      const pending = this.pending.get(outbound.id)
      if (!pending) return
      this.pending.delete(outbound.id)
      if ('error' in outbound) pending.reject(new Error(outbound.error.message))
      else pending.resolve(outbound.result)
    }
  }

  call<M extends HostMethodName>(method: M, params: HostMethodMap[M]['params']): Promise<HostMethodMap[M]['result']> {
    const id = this.nextId++
    // Every `HostMethodMap` entry's `params` is a concrete shape (`Empty` at worst, never
    // `undefined`) -- see protocol.ts's method table -- so `params` is always present on
    // the wire, never conditionally spread.
    const req: WireRequest = { id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.transport.send(JSON.stringify(req))
    })
  }

  on<K extends HostEventName>(event: K, handler: (data: HostEventMap[K]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    const wrapped = handler as (data: unknown) => void
    set.add(wrapped)
    return () => set?.delete(wrapped)
  }

  /**
   * Subscribes to every FUTURE state change, and -- critically -- calls `handler`
   * immediately, synchronously, with the CURRENT state before returning. Without this
   * replay, a caller that constructs the client and subscribes right after (exactly what
   * `App.tsx` does) would silently miss the 'open' transition: the constructor sets that
   * state before returning, i.e. strictly before the caller has had any chance to
   * subscribe at all, so a subscriber added a line later than `createClient()` would
   * otherwise never learn the client is already open. Caught by hand while verifying
   * Task 4's dev-bridge round trip: `client.state()` correctly reported 'open', but the
   * UI's own connection dot stayed stuck on 'connecting' forever, because nothing had
   * ever re-delivered that first transition to the component's subscription.
   */
  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(handler)
    handler(this.currentState)
    return () => this.stateListeners.delete(handler)
  }

  state(): ConnectionState { return this.currentState }

  close(): void {
    this.transport.close()
    this.setState('closed')
    this.rejectAllPending('protocol client closed')
  }

  private rejectAllPending(reason: string): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id)
      p.reject(new Error(reason))
    }
  }
}

/** Constructs a client over the dev WS bridge when `wsUrl` is given, or the Tauri IPC
 * transport otherwise. Exported separately from `createClientFromLocation` so tests can
 * inject a fake `RawTransport` directly. */
export function createClient(wsUrl: string | undefined): ProtocolClient {
  const transport: RawTransport = wsUrl !== undefined ? new WsTransport(wsUrl) : new TauriTransport()
  return new ProtocolClientImpl(transport)
}

/** For tests only: builds a `ProtocolClient` directly over a caller-supplied
 * `RawTransport` (a fake), bypassing both real transports entirely. */
export function createClientForTesting(transport: RawTransport): ProtocolClient {
  return new ProtocolClientImpl(transport)
}

export type { RawTransport }
