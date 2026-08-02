import type { Workspace } from '../workspace.js'
import type { InteractionPort, TodoStore } from '../interaction.js'

export interface ToolContext {
  workspace: Workspace
  signal?: AbortSignal
  interaction?: InteractionPort
  todos?: TodoStore
}

export interface ToolResult {
  ok: boolean
  /** Text handed back to the model as the tool message. Keep it short: it is permanent. */
  content: string
}

export type Validation<A> = { ok: true; args: A } | { ok: false; error: string }

/** What the permission engine matches rules against. Built by the tool itself. */
export interface PermissionKey {
  tool: string
  /** For command-running tools: the exact command line. */
  command?: string
  /** For file tools: workspace-relative paths this call touches. */
  paths?: string[]
}

export interface ApprovalPreview {
  summary: string
  detail: string
}

export interface Tool<A> {
  name: string
  description: string
  /** JSON Schema for the arguments; llama.cpp turns this into a constraint grammar. */
  parameters: Record<string, unknown>
  /**
   * True if this tool cannot change the workspace, or anything else, no matter what
   * arguments it is called with. This is the sole source of truth for what plan mode may
   * offer: `Agent` derives its plan-mode tool list from this flag via
   * `ToolRegistry.readOnlyNames()` rather than trusting a separately-maintained name list,
   * so a tool that forgets to declare itself does not silently become plan-safe (the
   * field is required, so leaving it out is a compile error) and a plan-mode caller
   * cannot forget to restrict the tool list (there is nothing for it to remember).
   */
  readOnly: boolean
  /**
   * Semantic validation. The schema grammar already guarantees well-formed JSON and the
   * right types; this catches arguments that are valid and still useless, such as an
   * empty search_text.
   */
  validate(raw: unknown): Validation<A>
  execute(args: A, ctx: ToolContext): Promise<ToolResult>
  /** Return a permission key for this invocation; used by the permission system. */
  permissionKey?(args: A): PermissionKey
  /** Return human-readable text for approvals. */
  approvalPreview?(args: A): ApprovalPreview
}
