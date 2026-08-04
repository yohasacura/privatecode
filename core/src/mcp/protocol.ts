/**
 * The slice of the Model Context Protocol this client speaks.
 *
 * MCP is JSON-RPC 2.0 with a handshake and a small set of methods. Only the tool-facing
 * ones are here: `initialize`, `notifications/initialized`, `tools/list` and `tools/call`.
 * Prompts, resources, sampling and roots are deliberately absent — this project has its own
 * answer for each (slash commands, `read_file`, one local model, the workspace jail), and a
 * half-implemented capability is worse than an absent one because a server will believe it.
 */

/** The protocol revision this client claims. Servers negotiate down when they must. */
export const PROTOCOL_VERSION = '2025-06-18'

export const CLIENT_INFO = { name: 'PrivateCode', version: '0.1.0' } as const

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export function isResponse(m: any): m is JsonRpcResponse {
  return m !== null && typeof m === 'object' && m.id !== undefined && m.method === undefined
}

export function isRequest(m: any): m is JsonRpcRequest {
  return m !== null && typeof m === 'object' && m.id !== undefined && typeof m.method === 'string'
}

/** JSON-RPC's "method not found". Used to answer server-initiated requests we do not serve. */
export const METHOD_NOT_FOUND = -32601

export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; title?: string }
}

export interface McpContentBlock {
  type: string
  text?: string
  uri?: string
  mimeType?: string
  resource?: { uri?: string; text?: string; mimeType?: string }
}

export interface McpCallToolResult {
  content?: McpContentBlock[]
  structuredContent?: unknown
  isError?: boolean
}

export interface McpServerInfo {
  name: string
  version?: string
}

/**
 * Flattens a server's `content` blocks into text.
 *
 * Images and audio become a one-line note rather than being dropped silently: the model
 * needs to know something was returned that it cannot see (this build has no vision tower —
 * `docs/DESIGN.md` §6), or it will conclude the call returned nothing and try again.
 */
export function renderContent(blocks: McpContentBlock[] | undefined): string {
  if (!blocks || blocks.length === 0) return ''
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'image':
        parts.push('[an image was returned; this model cannot read images]')
        break
      case 'audio':
        parts.push('[audio was returned; this model cannot hear audio]')
        break
      case 'resource': {
        const r = block.resource ?? {}
        parts.push(typeof r.text === 'string'
          ? `[${r.uri ?? 'resource'}]\n${r.text}`
          : `[resource: ${r.uri ?? 'unnamed'}]`)
        break
      }
      case 'resource_link':
        parts.push(`[resource: ${block.uri ?? 'unnamed'}]`)
        break
      default:
        // An unknown block type is a newer protocol revision, not an error. Say what arrived.
        parts.push(`[${block.type} content]`)
    }
  }
  return parts.join('\n')
}
