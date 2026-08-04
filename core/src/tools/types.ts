import type { Workspace } from '../workspace.js'
import type { InteractionPort, TodoStore } from '../interaction.js'
import type { FormatRunner } from '../format/runner.js'

export interface ToolContext {
  workspace: Workspace
  signal?: AbortSignal
  interaction?: InteractionPort
  todos?: TodoStore
  /** The project's formatter, when one is configured. Absent means "no formatting", which
   * is the normal case. See `format/runner.ts` for why this runs inside the write tools
   * rather than as an after-tool hook. */
  format?: FormatRunner
}

export interface ToolResult {
  ok: boolean
  /** Text handed back to the model as the tool message. Keep it short: it is permanent. */
  content: string
  /**
   * The same result, untruncated, for a HUMAN reader — the app's transcript, never the
   * model. Optional: only tools that deliberately clip `content` to protect the context
   * window set it.
   *
   * The two audiences have opposite requirements and used to share one string, which meant
   * the person watching a build got the same middle-elided 8 KB the model did. A model
   * cannot afford a 200 KB test log in its permanent transcript; a person debugging that
   * build cannot work without it.
   */
  display?: string
}

export type Validation<A> = { ok: true; args: A } | { ok: false; error: string }

/** What the permission engine matches rules against. Built by the tool itself. */
export interface PermissionKey {
  tool: string
  /** For command-running tools: the exact command line. */
  command?: string
  /** For file tools: workspace-relative paths this call touches. */
  paths?: string[]
  /**
   * For tools that reach something outside this machine's filesystem: the resource this
   * call acts on, as a URL or origin. Matched with the same exact-or-`:*`-prefix semantics
   * as `command`, so `browser(http://localhost:*)` reads the way a person expects.
   *
   * Deliberately NOT `command`, even though the matching is identical: `command` keys are
   * run through the engine's `HARD_DENY` table first, and those patterns fire on ordinary
   * URLs — `https://github.com/git/push` matches the git-push pattern and `.../format c:`
   * matches the format-volume one. Reusing the field would mean a browser could not open a
   * page whose path happened to contain the word "push".
   */
  target?: string
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
  /**
   * Return human-readable text for approvals. `ctx` is offered for a tool that needs it
   * (e.g. to describe a path relative to the workspace root) but every current
   * implementation ignores it — a function declaring fewer parameters than this type
   * satisfies it fine, since the extra argument is simply never read.
   */
  approvalPreview?(args: A, ctx: ToolContext): ApprovalPreview
}
