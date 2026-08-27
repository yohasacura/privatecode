import {
  CLIENT_INFO,
  isRequest,
  isResponse,
  METHOD_NOT_FOUND,
  PROTOCOL_VERSION,
  renderContent,
  type JsonRpcMessage,
  type McpCallToolResult,
  type McpServerInfo,
  type McpToolDef,
} from './protocol.js'
import {
  HttpTransport,
  StdioTransport,
  type HttpServerSpec,
  type McpTransport,
  type ServerSpec,
  type StdioServerSpec,
} from './transport.js'

/**
 * One connected MCP server.
 *
 * The client is deliberately small. It initialises, lists tools once, and calls them; it
 * subscribes to nothing and serves nothing. Everything a server might ask of a client —
 * sampling, roots, elicitation — is answered with "method not found" rather than ignored,
 * because a server blocked waiting for a reply is a hang, and a hang inside a tool call is
 * indistinguishable to the user from the model being slow.
 */

const INITIALIZE_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 20_000
/** A tool call may legitimately be slow (a query, a build). The turn's own signal is the
 * user's way out; this is only a backstop against a server that has stopped answering. */
const CALL_TIMEOUT_MS = 120_000

export interface McpTimeouts {
  initializeMs?: number
  listMs?: number
  callMs?: number
}
/** No real server has this many tools; a runaway cursor loop does. */
const MAX_LIST_PAGES = 20

export interface McpCallResult {
  ok: boolean
  text: string
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

export class McpClient {
  readonly serverInfo: McpServerInfo
  private readonly transport: McpTransport
  private readonly timeouts: Required<McpTimeouts>
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closedWhy: string | null = null

  private constructor(transport: McpTransport, serverInfo: McpServerInfo, timeouts: McpTimeouts) {
    this.transport = transport
    this.serverInfo = serverInfo
    this.timeouts = {
      initializeMs: timeouts.initializeMs ?? INITIALIZE_TIMEOUT_MS,
      listMs: timeouts.listMs ?? LIST_TIMEOUT_MS,
      callMs: timeouts.callMs ?? CALL_TIMEOUT_MS,
    }
  }

  static async connect(
    spec: ServerSpec,
    opts: { name: string; timeouts?: McpTimeouts },
  ): Promise<McpClient> {
    const transport: McpTransport = spec.kind === 'stdio'
      ? new StdioTransport(spec as StdioServerSpec)
      : new HttpTransport(spec as HttpServerSpec)

    const client = new McpClient(transport, { name: opts.name }, opts.timeouts ?? {})
    transport.onMessage((m) => client.onMessage(m))
    transport.onClose((why) => client.onClosed(why))

    try {
      const result = await client.request<{ serverInfo?: McpServerInfo; protocolVersion?: string }>(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          // Empty rather than aspirational: declaring a capability this client does not
          // implement invites a server to use it, and then the call hangs.
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
        client.timeouts.initializeMs,
      )
      // The CONFIGURED name is what rules and tool names are built from, so it stays
      // authoritative -- a server must not be able to rename itself into another server's
      // permission rules. Only the version is taken from what it reports, for display.
      if (typeof result.serverInfo?.version === 'string') {
        client.serverInfo.version = result.serverInfo.version
      }
      await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      return client
    } catch (e) {
      await transport.close().catch(() => {})
      const detail = transport instanceof StdioTransport ? transport.stderrTail() : ''
      throw new Error(
        `could not start "${opts.name}" (${transport.describe}): ${(e as Error).message}` +
        (detail === '' ? '' : `\n${detail}`),
      )
    }
  }

  /** Every tool the server offers, following `nextCursor` to the end. */
  async listTools(): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await this.request<{ tools?: McpToolDef[]; nextCursor?: string }>(
        'tools/list',
        cursor === undefined ? {} : { cursor },
        this.timeouts.listMs,
      )
      for (const tool of result.tools ?? []) {
        if (typeof tool?.name === 'string' && tool.name !== '') tools.push(tool)
      }
      if (typeof result.nextCursor !== 'string' || result.nextCursor === '') return tools
      cursor = result.nextCursor
    }
    return tools
  }

  /**
   * Calls a tool and flattens the answer to text.
   *
   * A tool that reports `isError` is a FAILED tool call, not a thrown exception: the model
   * needs to read what went wrong and adjust, exactly as it does for a non-zero exit code.
   */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const result = await this.request<McpCallToolResult>(
      'tools/call',
      { name, arguments: args ?? {} },
      this.timeouts.callMs,
      signal,
    )
    const text = renderContent(result.content)
    const structured = result.structuredContent !== undefined
      ? JSON.stringify(result.structuredContent, null, 2)
      : ''
    const body = [text, structured].filter((s) => s !== '').join('\n') ||
      '(the server returned no content)'
    return { ok: result.isError !== true, text: body }
  }

  async close(): Promise<void> {
    this.onClosed('the connection was closed locally')
    await this.transport.close().catch(() => {})
  }

  // ---------------------------------------------------------------------------------------

  private request<T>(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (this.closedWhy !== null) return Promise.reject(new Error(this.closedWhy))
    const id = this.nextId++
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params }

    return new Promise<T>((resolve, reject) => {
      const settleWith = (e: Error): void => {
        this.pending.delete(id)
        clearTimeout(timer)
        offAbort?.()
        reject(e)
      }
      const timer = setTimeout(
        () => settleWith(new Error(`${method} did not answer within ${Math.round(timeoutMs / 1000)} s`)),
        timeoutMs,
      )
      // The user's Esc must land inside a slow MCP call the same way it lands inside a slow
      // model call: a turn that cannot be interrupted while a server thinks is a turn the
      // user cannot get out of.
      let offAbort: (() => void) | undefined
      if (signal) {
        if (signal.aborted) {
          settleWith(new Error('cancelled'))
          return
        }
        const onAbort = (): void => settleWith(new Error('cancelled'))
        signal.addEventListener('abort', onAbort, { once: true })
        offAbort = () => signal.removeEventListener('abort', onAbort)
      }

      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); offAbort?.(); resolve(value as T) },
        reject: (e) => { clearTimeout(timer); offAbort?.(); reject(e) },
        timer,
        method,
      })

      this.transport.send(message).catch((e: Error) => settleWith(e))
    })
  }

  private onMessage(m: any): void {
    if (isResponse(m)) {
      const pending = typeof m.id === 'number' ? this.pending.get(m.id) : undefined
      if (!pending) return // a late answer to something that already timed out
      this.pending.delete(m.id as number)
      if (m.error) {
        pending.reject(new Error(`${pending.method}: ${m.error.message ?? 'server error'}`))
      } else {
        pending.resolve(m.result ?? {})
      }
      return
    }

    if (isRequest(m)) {
      // Answered, not ignored. A server that asked for sampling and got silence would wait
      // forever, and its wait would be inside our tool call.
      void this.transport.send({
        jsonrpc: '2.0',
        id: m.id,
        error: {
          code: METHOD_NOT_FOUND,
          message: `PrivateCode does not implement ${m.method}`,
        },
      } as JsonRpcMessage).catch(() => {})
    }
    // Notifications (tools/list_changed, logging) are dropped: this client re-lists nothing
    // mid-session, because the tool schemas were already sent to the model in message 0 of
    // an append-only transcript and cannot be changed under it.
  }

  private onClosed(why: string): void {
    if (this.closedWhy !== null) return
    this.closedWhy = why
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`${pending.method}: ${why}`))
    }
    this.pending.clear()
  }
}
