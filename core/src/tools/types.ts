import type { Workspace } from '../workspace.js'
import type { InteractionPort, TodoStore } from '../interaction.js'
import type { FormatRunner } from '../format/runner.js'
import type { BrowserManager } from '../browser/manager.js'
import type { LoadedSkills } from '../skills/skills.js'
import type { ReadMemory } from './read-memory.js'
import type { DatabaseSettings } from '../sql/settings.js'
import type { SubAgentOutcome } from '../agent/subagent.js'

export interface ToolContext {
  workspace: Workspace
  /**
   * Which session this call belongs to, when the caller knows.
   *
   * Only `search_history` reads it, and only to tell "this conversation" from "every other
   * one" — a distinction that matters because the two answer different questions: the
   * middle of THIS session that compaction summarised away, against where something was
   * done before. Absent for the one-shot CLI and most tests, which have no session to be in.
   */
  sessionId?: string
  signal?: AbortSignal
  /**
   * Live output, for tools that produce it over time — run_command's stdout/stderr as it
   * arrives. Display-only: the final ToolResult is still the complete, authoritative
   * record; these chunks exist so a two-minute build is a scrolling log instead of a
   * frozen spinner. Absent for hosts that render nothing (tests, one-shot CLI).
   */
  onLiveOutput?: (text: string) => void
  interaction?: InteractionPort
  todos?: TodoStore
  /** The browser, when this host provides one. Lazy: holding it starts nothing. */
  browser?: BrowserManager
  /** The HEADLESS renderer the `web` tool escalates to for JavaScript-shell pages.
   * A separate instance from `browser` on purpose: reading a page for research must
   * never flash a window, and the visible browser's page must never be navigated away
   * under the user by a background read. Lazy like its sibling. */
  webRenderer?: BrowserManager
  /**
   * The database this workspace works against, when one is configured.
   *
   * Absent is the ordinary state — most workspaces have no database — and the tool says
   * so plainly, naming the file to write, rather than failing. The connection string is
   * carried rather than the open connection: the helper owns the connection, and it is
   * opened on first use so a workspace whose server is down still starts a session.
   */
  database?: DatabaseSettings
  /** The project's formatter, when one is configured. Absent means "no formatting", which
   * is the normal case. See `format/runner.ts` for why this runs inside the write tools
   * rather than as an after-tool hook. */
  format?: FormatRunner
  /**
   * The skills this session was built with, for `use_skill` to resolve a name against.
   *
   * Only the LOCATIONS travel here — bodies are read from disk at call time (see
   * `readSkillText`), so a skill edited while the app is open takes effect on the next call
   * rather than the next session. Absent means the session has none, which is the normal
   * state of a workspace nobody has written one for.
   */
  skills?: LoadedSkills
  /**
   * What has already been shown to the model, so a repeat read can answer with what
   * changed instead of the file again. Absent means every read is a first read, which is
   * what a one-shot caller and most tests want. See `read-memory.ts`.
   */
  reads?: ReadMemory
  /**
   * Runs one narrow job in a worker with its own conversation, and returns what it
   * concluded. See `agent/subagent.ts`.
   *
   * A function rather than the client and the registry, because a tool that held those
   * could build any agent it liked; this one can only ask for a role that exists. The
   * session owns the machinery, which is also where the window size and the abort
   * signal already live.
   *
   * Absent for hosts with no model to run one with, and `delegate` says so plainly
   * rather than failing: the caller can do the reading itself.
   */
  delegate?: (role: string, task: string, signal?: AbortSignal) => Promise<SubAgentOutcome>
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
  /**
   * Return a permission key for this invocation; used by the permission system.
   *
   * `ctx` is offered for a tool whose key depends on state the arguments do not carry — the
   * browser keys most of its actions on the page that is currently open, not on anything
   * the model wrote. Every other implementation declares one parameter and ignores it,
   * which satisfies this type fine.
   *
   * Optional, so a caller that has no context (a test, a tool inspecting its own key) can
   * still ask for one. An implementation that reads `ctx` must therefore tolerate its
   * absence rather than assume the agent loop is the only caller.
   */
  permissionKey?(args: A, ctx?: ToolContext): PermissionKey
  /**
   * Return human-readable text for approvals. `ctx` is offered for a tool that needs it
   * (e.g. to describe a path relative to the workspace root) but every current
   * implementation ignores it — a function declaring fewer parameters than this type
   * satisfies it fine, since the extra argument is simply never read.
   */
  approvalPreview?(args: A, ctx: ToolContext): ApprovalPreview
}
