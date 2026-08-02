import type { Workspace } from '../workspace.js'

export interface ToolContext {
  workspace: Workspace
  signal?: AbortSignal
}

export interface ToolResult {
  ok: boolean
  /** Text handed back to the model as the tool message. Keep it short: it is permanent. */
  content: string
}

export type Validation<A> = { ok: true; args: A } | { ok: false; error: string }

export interface Tool<A> {
  name: string
  description: string
  /** JSON Schema for the arguments; llama.cpp turns this into a constraint grammar. */
  parameters: Record<string, unknown>
  /**
   * Semantic validation. The schema grammar already guarantees well-formed JSON and the
   * right types; this catches arguments that are valid and still useless, such as an
   * empty search_text.
   */
  validate(raw: unknown): Validation<A>
  execute(args: A, ctx: ToolContext): Promise<ToolResult>
}
