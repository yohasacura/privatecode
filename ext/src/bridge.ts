import * as vscode from 'vscode'
import { SessionHost } from '../../core/src/host/host.js'
import type { HostOutbound, HostEvent } from '../../core/src/host/protocol.js'

/**
 * The agent, hosted inside the extension host.
 *
 * `SessionHost` was built transport-agnostic (plan 4): the Tauri build reached it through
 * ndjson over a child process's stdio, and this one simply calls `handle()` in-process --
 * the extension host IS Node, so there is no sidecar, no vendored runtime, and no
 * unsigned binary for Windows to distrust. Requests get a monotonic id and their reply is
 * matched back here; unsolicited events go to whichever turn is currently listening.
 */

type Listener = (event: HostEvent) => void

export class AgentBridge {
  private readonly host: SessionHost
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private listener: Listener | null = null
  private nextId = 1
  private initialized: { workspaceRoot: string; serverUrl: string } | null = null

  constructor() {
    this.host = new SessionHost({
      transport: {
        send: (msg: HostOutbound) => {
          if ('event' in msg) {
            this.listener?.(msg)
            return
          }
          const p = this.pending.get(msg.id)
          if (!p) return
          this.pending.delete(msg.id)
          if ('error' in msg) p.reject(new Error(msg.error.message))
          else p.resolve(msg.result)
        },
      },
    })
  }

  /** One RPC. Rejects with the host's own message on an error reply -- never throws. */
  call(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      void this.host.handle({ id, method, params })
    })
  }

  /** Events are consumed by exactly one turn at a time (the host refuses overlapping
   * turns anyway), so a single slot is the honest shape rather than an emitter. */
  listen(listener: Listener | null): void {
    this.listener = listener
  }

  /**
   * Ensures a session exists for this workspace and server. Re-inits when either changed
   * (the user edited `privatecode.serverUrl`, or switched folder) -- `init` is a full
   * reset on the host side, which is exactly right for that.
   */
  async ensureSession(workspaceRoot: string, serverUrl: string): Promise<void> {
    if (this.initialized
      && this.initialized.workspaceRoot === workspaceRoot
      && this.initialized.serverUrl === serverUrl) {
      return
    }
    await this.call('init', { workspaceRoot, serverUrl })
    this.initialized = { workspaceRoot, serverUrl }
  }

  async dispose(): Promise<void> {
    await this.host.shutdown()
  }
}

/** `privatecode.serverUrl`, read fresh each turn so a settings change takes effect at once. */
export function serverUrl(): string {
  return vscode.workspace.getConfiguration('privatecode')
    .get<string>('serverUrl', 'http://127.0.0.1:8080')
}

export function configuredMode(): string {
  return vscode.workspace.getConfiguration('privatecode').get<string>('mode', 'normal')
}
