import { MCP_TOOL_PREFIX } from '../permissions/rules.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ApprovalPreview, PermissionKey, Tool, ToolContext, ToolResult } from '../tools/types.js'
import { countLines, headLines, overflowNotice, spillToLog } from '../tools/output-log.js'
import { McpClient } from './client.js'
import type { ServerConfig } from './config.js'
import type { McpToolDef } from './protocol.js'

/**
 * Connects the configured servers and turns what they offer into registered tools.
 *
 * The design decision that made MCP admissible at all lives in `permissions/engine.ts`, not
 * here: `isExternalTool` puts everything under `mcp__` into a family that ASKS by default.
 * Without it, a tool contributed by a third-party server -- the least trustworthy code in
 * the process -- would have fallen through the engine's two name-based families and been the
 * only ungated thing in it. That is the reason `docs/DESIGN.md` §6 cut MCP the first time.
 */

/**
 * The ceiling on tools contributed across ALL servers.
 *
 * Every schema is sent on every request and becomes part of llama.cpp's constraint grammar.
 * Four chatty servers would silently spend thousands of tokens per step on schemas the model
 * never calls, on the machine where context is the scarcest resource there is. Exceeding it
 * is reported, never silent -- a cap nobody is told about reads as "everything is here".
 */
export const MAX_MCP_TOOLS = 32

/** Result text over this is paged through a log file, like every other tool's output. */
const MAX_OUTPUT_CHARS = 8_000
const HEAD_LINES = 60

export type ServerState = 'connected' | 'failed'

export interface ServerStatus {
  name: string
  state: ServerState
  toolCount: number
  problem?: string
}

/**
 * `mcp__<server>__<tool>`, lowercased, with everything outside `[a-z0-9_]` replaced.
 *
 * Not cosmetic: `parseRule`'s `TOOL_NAME_RE` is `^[a-z_][a-z0-9_]*$`, so a name it rejects
 * is a tool nobody can write a permission rule for -- neither an allow nor a deny. A server
 * called `github-issues` with a tool called `create.issue` has to become something
 * spellable, or it is ungovernable.
 */
export function sanitizeSegment(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  return cleaned === '' ? 'x' : cleaned
}

/** `parseRule` also caps a rule at a sane length; keep names well inside it. */
const MAX_NAME_CHARS = 64

export function toolNameFor(server: string, tool: string): string {
  const name = `${MCP_TOOL_PREFIX}${sanitizeSegment(server)}__${sanitizeSegment(tool)}`
  return name.length <= MAX_NAME_CHARS ? name : name.slice(0, MAX_NAME_CHARS)
}

/**
 * A server's declared input schema, or a safe stand-in.
 *
 * A malformed schema is not a local problem: llama.cpp builds ONE constraint grammar from
 * every tool schema in the request, so a schema it cannot compile breaks every call in the
 * session, not just this tool's. Replacing it costs this tool its arguments and keeps the
 * session working.
 */
export function usableSchema(raw: unknown): { schema: Record<string, unknown>; replaced: boolean } {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) &&
      (raw as Record<string, unknown>)['type'] === 'object') {
    return { schema: raw as Record<string, unknown>, replaced: false }
  }
  return { schema: { type: 'object', properties: {} }, replaced: true }
}

function previewArgs(args: unknown): string {
  try {
    const text = JSON.stringify(args ?? {}, null, 2)
    return text.length > 2_000 ? `${text.slice(0, 2_000)}\n... (clipped)` : text
  } catch {
    return String(args)
  }
}

function buildMcpTool(
  config: ServerConfig,
  def: McpToolDef,
  registeredName: string,
  client: () => McpClient | null,
): { tool: Tool<Record<string, unknown>>; problem?: string } {
  const { schema, replaced } = usableSchema(def.inputSchema)
  const readOnly = config.trustReadOnlyHints && def.annotations?.readOnlyHint === true

  const tool: Tool<Record<string, unknown>> = {
    name: registeredName,
    readOnly,
    description: def.description
      ? `[${config.name}] ${def.description}`
      : `[${config.name}] ${def.name}`,
    parameters: schema,
    // The server validates its own arguments against its own schema. Re-validating here
    // could only reject calls the server would have accepted, using a worse copy of its
    // rules -- so this checks the one thing the tool contract requires and nothing else.
    validate(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'arguments must be a JSON object' }
      }
      return { ok: true, args: raw as Record<string, unknown> }
    },
    // No spec: an MCP call carries no command, no target and no paths, so a rule is either
    // this tool (`mcp__sqlite__query`) or the whole server (`mcp__sqlite`). `suggestRules`
    // offers both, most specific first.
    permissionKey(): PermissionKey {
      return { tool: registeredName }
    },
    approvalPreview(args): ApprovalPreview {
      return {
        summary: `${config.name}: ${def.name}`,
        detail:
          `MCP server "${config.name}" (${config.source})\n` +
          `Tool: ${def.name}${def.description ? ` — ${def.description}` : ''}\n\n` +
          `Arguments:\n${previewArgs(args)}`,
      }
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const connected = client()
      if (!connected) {
        return {
          ok: false,
          content: `The MCP server "${config.name}" is not connected, so ${def.name} was not run.`,
        }
      }
      let result: { ok: boolean; text: string }
      try {
        result = await connected.callTool(def.name, args, ctx.signal)
      } catch (e) {
        return { ok: false, content: `${config.name}/${def.name} failed: ${(e as Error).message}` }
      }
      if (result.text.length <= MAX_OUTPUT_CHARS) {
        return { ok: result.ok, content: result.text, display: result.text }
      }
      // Same treatment as a long build log: paged, not elided, so the model can read the
      // part it needs instead of re-running the call with a narrower guess.
      const log = await spillToLog(ctx.workspace, `mcp-${sanitizeSegment(config.name)}`, result.text)
      const content = log === null
        ? `${headLines(result.text, HEAD_LINES)}\n... (output truncated; the log file could not be written)`
        : `${headLines(result.text, HEAD_LINES)}` +
          overflowNotice(log, Math.min(HEAD_LINES, countLines(result.text)))
      return { ok: result.ok, content, display: result.text }
    },
  }

  return replaced
    ? {
      tool,
      problem: `${config.name}/${def.name} declares an input schema that is not a JSON object ` +
        'schema; it was registered with no arguments',
    }
    : { tool }
}

export class McpManager {
  private readonly clients = new Map<string, McpClient>()
  private readonly statuses: ServerStatus[] = []
  /** The registry names each server's tools were registered under, so `close` can take them back. */
  private readonly toolNames = new Map<string, string[]>()

  /** Whether a server of this name is connected (or failed and recorded). */
  has(name: string): boolean {
    return this.statuses.some((s) => s.name === name)
  }

  /**
   * Disconnects one server and unregisters its tools — a plugin's server after the plugin
   * was disabled. Never throws.
   */
  async close(name: string, registry: ToolRegistry): Promise<void> {
    const client = this.clients.get(name)
    this.clients.delete(name)
    for (const tool of this.toolNames.get(name) ?? []) registry.unregister(tool)
    this.toolNames.delete(name)
    const at = this.statuses.findIndex((s) => s.name === name)
    if (at !== -1) this.statuses.splice(at, 1)
    if (client !== undefined) await client.close().catch(() => {})
  }

  /** What connected, what failed and why. Read by `status` so the app can show it. */
  servers(): ServerStatus[] {
    return this.statuses.map((s) => ({ ...s }))
  }

  /**
   * Connects every configured server IN PARALLEL and registers what came back.
   *
   * A server that fails contributes zero tools and one problem string; the session runs.
   * That is the same discipline `loadHooks` and `loadFormatRules` already follow, and it is
   * the right one: a broken server in a config file is a configuration issue, not a reason
   * the user cannot work today.
   */
  async connectAll(configs: ServerConfig[], registry: ToolRegistry): Promise<string[]> {
    const problems: string[] = []
    const settled = await Promise.all(configs.map(async (config) => {
      try {
        const client = await McpClient.connect(config.spec, { name: config.name })
        const tools = await client.listTools()
        return { config, client, tools }
      } catch (e) {
        return { config, error: (e as Error).message }
      }
    }))

    let registered = 0
    for (const outcome of settled) {
      const { config } = outcome
      if ('error' in outcome) {
        this.statuses.push({ name: config.name, state: 'failed', toolCount: 0, problem: outcome.error })
        problems.push(outcome.error)
        continue
      }

      this.clients.set(config.name, outcome.client)
      let count = 0
      let dropped = 0
      for (const def of outcome.tools) {
        if (registered >= MAX_MCP_TOOLS) {
          dropped++
          continue
        }
        const name = this.uniqueName(config.name, def.name, registry)
        const built = buildMcpTool(config, def, name, () => this.clients.get(config.name) ?? null)
        try {
          registry.register(built.tool)
        } catch (e) {
          problems.push(`could not register ${name}: ${(e as Error).message}`)
          continue
        }
        if (built.problem) problems.push(built.problem)
        this.toolNames.set(config.name, [...(this.toolNames.get(config.name) ?? []), name])
        registered++
        count++
      }
      if (dropped > 0) {
        problems.push(
          `${config.name}: ${dropped} tool(s) were not registered — the ${MAX_MCP_TOOLS}-tool ` +
          'limit across all MCP servers was reached. Disable a server you are not using.',
        )
      }
      this.statuses.push({ name: config.name, state: 'connected', toolCount: count })
    }
    return problems
  }

  /**
   * A registered name nothing else has taken.
   *
   * Two servers can offer the same tool name after sanitisation (`github-issues` and
   * `github_issues` both become `github_issues`), and the registry throws on a duplicate.
   * A numeric suffix keeps both reachable; the alternative is one server silently losing a
   * tool because another was configured first.
   */
  private uniqueName(server: string, tool: string, registry: ToolRegistry): string {
    const base = toolNameFor(server, tool)
    if (!registry.get(base)) return base
    for (let n = 2; n < 100; n++) {
      const candidate = `${base}_${n}`.slice(0, MAX_NAME_CHARS)
      if (!registry.get(candidate)) return candidate
    }
    return base // the register() call will fail and be reported; nothing silent
  }

  /** Never throws: shutdown runs on paths that are already failing. */
  async closeAll(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    this.toolNames.clear()
    this.statuses.length = 0
    await Promise.all(clients.map((c) => c.close().catch(() => {})))
  }
}
