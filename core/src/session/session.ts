import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { Agent, type AgentEvents, type AgentOptions, type TurnResult } from '../agent/loop.js'
import type { InteractionPort } from '../interaction.js'
import type { LlamaClient } from '../llama/client.js'
import type { AgentMode, PermissionEngine } from '../permissions/engine.js'
import type { Toolset } from '../tools/default-set.js'
import type { ToolContext } from '../tools/types.js'
import { Transcript } from '../transcript/transcript.js'
import { Workspace } from '../workspace.js'
import { SessionStore, type SessionMeta } from './store.js'

export interface SessionOptions {
  client: LlamaClient
  toolset: Toolset // from createToolset()
  workspaceRoot: string
  mode?: AgentMode // default 'normal'
  interaction?: InteractionPort
  engine?: PermissionEngine
  store?: SessionStore // omit -> in-memory only (tests, one-shot CLI)
  resume?: string // session id to load
  maxSteps?: number
  events?: AgentEvents
}

const PLAN_MODE_NOTE = '(mode is now plan: investigate and propose; do not edit)'

function noteFor(mode: AgentMode): string {
  return mode === 'plan' ? PLAN_MODE_NOTE : `(mode is now ${mode})`
}

/** First user message, whitespace-collapsed and capped, used as the session's title. */
function titleFrom(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 60 ? collapsed.slice(0, 60) : collapsed
}

function generateId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  // 2 bytes -> exactly 4 hex characters.
  return `s-${stamp}-${randomBytes(2).toString('hex')}`
}

/**
 * A multi-turn conversation: one Transcript, persisted incrementally, that survives mode
 * switches and process restarts (when constructed with a `store`).
 *
 * `Agent` fixes its `allowedTools` and its view of the permission mode at construction
 * time, so it cannot itself represent a conversation that changes mode partway through.
 * `Session` is what makes that possible: it owns the one `Transcript` for the whole
 * conversation's life and builds a new `Agent` around it for every `send()`, so a mode
 * switch (`setMode`) takes effect on the very next turn without ever touching, splitting,
 * or re-appending anything in the transcript itself (the system prompt is appended only
 * when the transcript is empty, which stays true across every rebuild after the first).
 *
 * Building fresh per turn rather than caching one `Agent` instance also happens to be the
 * only clean way to thread each call's own `AbortSignal` through: `Agent` has no public
 * way to rebind a signal after construction. Since `Agent` construction is pure (aside
 * from that guarded system-prompt append), this costs nothing and is behaviorally
 * indistinguishable, when the mode has not changed, from reusing a cached instance.
 */
export class Session {
  readonly id: string
  readonly meta: SessionMeta

  private readonly opts: SessionOptions
  private readonly transcript: Transcript
  private readonly workspace: Workspace
  /** How many of transcript.messages() have already been written to the store. */
  private persistedCount: number
  /** Whether the title has been set yet (independent of whether it ended up empty). */
  private titled: boolean
  /** Set by setMode(), consumed (and cleared) by the next send(). */
  private pendingModeNote: string | undefined

  constructor(opts: SessionOptions) {
    this.opts = opts
    this.workspace = new Workspace(opts.workspaceRoot)

    if (opts.resume !== undefined) {
      if (!opts.store) {
        throw new Error('Session: "resume" requires a "store" to load the session from')
      }
      const { meta, transcript } = opts.store.load(opts.resume)

      // A transcript replayed against a different workspace tree would silently lie about
      // what it did and did not touch -- refuse rather than proceed.
      if (resolve(meta.workspaceRoot) !== resolve(opts.workspaceRoot)) {
        throw new Error(
          `session "${opts.resume}" belongs to workspace "${meta.workspaceRoot}", not ` +
          `"${opts.workspaceRoot}"; refusing to resume it against a different workspace`,
        )
      }
      // The resumed meta's own mode wins unless the caller explicitly asked for another.
      if (opts.mode !== undefined) meta.mode = opts.mode

      this.id = meta.id
      this.meta = meta
      this.transcript = transcript
      this.persistedCount = transcript.count()
      this.titled = meta.title !== ''
    } else {
      const now = new Date().toISOString()
      this.id = generateId()
      this.meta = {
        id: this.id,
        title: '',
        createdAt: now,
        updatedAt: now,
        workspaceRoot: opts.workspaceRoot,
        mode: opts.mode ?? opts.engine?.mode ?? 'normal',
      }
      this.transcript = new Transcript()
      this.persistedCount = 0
      this.titled = false
    }

    // Invariant maintained for the rest of this Session's life: whenever an engine is
    // present, engine.mode and meta.mode always agree (setMode keeps both in lockstep
    // below), so buildAgent() can safely omit `mode` from AgentOptions entirely and let
    // Agent resolve it from the engine -- passing a stale `mode` alongside a live engine
    // is exactly the desync a prior review found (Agent would otherwise write the stale
    // value back onto the engine and clobber it).
    if (this.opts.engine) this.opts.engine.mode = this.meta.mode
  }

  get mode(): AgentMode {
    return this.meta.mode
  }

  /**
   * Records the new mode and queues a one-line note for the next `send()` to prefix into
   * the user's text (never appended as its own transcript entry: two adjacent user
   * messages would deviate from the chat template the model was trained on). A no-op
   * mode (same as the current one) changes nothing and leaves any already-queued note
   * alone.
   */
  setMode(mode: AgentMode): void {
    if (mode === this.meta.mode) return
    this.meta.mode = mode
    if (this.opts.engine) this.opts.engine.mode = mode
    this.pendingModeNote = noteFor(mode)
  }

  approxTokens(): number {
    return this.transcript.approxTokens()
  }

  /**
   * Runs one turn and persists whatever it produced, regardless of outcome. The pending
   * mode note (if any) is prefixed into `text` -- never its own message -- before the
   * turn runs.
   */
  async send(text: string, signal?: AbortSignal): Promise<TurnResult> {
    const note = this.pendingModeNote
    this.pendingModeNote = undefined
    const userText = note ? `${note}\n${text}` : text

    const agent = this.buildAgent(signal)
    const result = await agent.runTurn(userText)

    if (!this.titled) {
      this.meta.title = titleFrom(text)
      this.titled = true
    }
    this.meta.updatedAt = new Date().toISOString()

    const store = this.opts.store
    if (store) {
      // Slices from transcript.messages(), never held references: append() already
      // deep-freezes its stored entries, so this is the read-only view, not a live alias.
      const all = this.transcript.messages()
      const fresh = all.slice(this.persistedCount)
      if (fresh.length > 0) {
        store.appendMessages(this.id, fresh)
        this.persistedCount = all.length
      }
      store.saveMeta(this.meta)
    }

    return result
  }

  private buildAgent(signal?: AbortSignal): Agent {
    const context: ToolContext = { workspace: this.workspace, todos: this.opts.toolset.todos }
    if (this.opts.interaction) context.interaction = this.opts.interaction

    const agentOpts: AgentOptions = {
      client: this.opts.client,
      registry: this.opts.toolset.registry,
      context,
      transcript: this.transcript,
    }
    if (this.opts.engine) {
      // mode intentionally omitted here -- see the constructor's invariant note. Agent
      // resolves opts.permissions.mode instead, which is always meta.mode by now.
      agentOpts.permissions = this.opts.engine
    } else {
      agentOpts.mode = this.meta.mode
    }
    if (this.opts.interaction) agentOpts.interaction = this.opts.interaction
    if (this.opts.events) agentOpts.events = this.opts.events
    if (this.opts.maxSteps !== undefined) agentOpts.maxSteps = this.opts.maxSteps
    if (signal) agentOpts.signal = signal

    return new Agent(agentOpts)
  }
}
