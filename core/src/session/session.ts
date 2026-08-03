import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { Agent, type AgentEvents, type AgentOptions, type StepInfo, type TurnResult } from '../agent/loop.js'
import { buildSystemPrompt } from '../agent/prompt.js'
import type { InteractionPort } from '../interaction.js'
import type { LlamaClient } from '../llama/client.js'
import type { ChatMessage } from '../llama/types.js'
import type { AgentMode, PermissionEngine } from '../permissions/engine.js'
import type { Toolset } from '../tools/default-set.js'
import type { ToolContext } from '../tools/types.js'
import { Transcript } from '../transcript/transcript.js'
import { Workspace } from '../workspace.js'
import {
  COMPACTION_ACK_TEXT, COMPACTION_BRIEFING_PREFIX, generateCompaction, selectCompactionTail,
} from './compaction.js'
import { SessionStore, type SessionMeta } from './store.js'

/** Task 9: background auto-compaction. Omitting this entirely from `SessionOptions`
 * turns the feature off completely -- no trigger check ever runs, no background
 * generation is ever started, however full the context gets. */
export interface CompactionOptions {
  /** The model's context window, in tokens -- the denominator `fillRatio` divides by. */
  contextLength: number
  /** Fraction of `contextLength` that trips the background trigger. Default 0.8. */
  triggerRatio?: number
  /** How many of the old transcript's trailing messages a swap keeps verbatim (subject
   * to the clean-boundary walk -- see `selectCompactionTail`). Default 6. */
  keepRecent?: number
}

/** One compaction lifecycle event, for a host to render (the REPL dims a one-liner for
 * `'started'` and `'applied'`; see `repl.ts`). `droppedMessages` is only ever present on
 * `'applied'` -- the other three states have nothing to report yet. */
export interface CompactionEvent {
  state: 'started' | 'ready' | 'applied' | 'failed'
  droppedMessages?: number
}

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
  /** Absent -> the feature is off; see `CompactionOptions`. */
  compaction?: CompactionOptions
  onCompaction?(info: CompactionEvent): void
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
 * A multi-turn conversation: one CURRENT Transcript, persisted incrementally, that
 * survives mode switches and process restarts (when constructed with a `store`).
 *
 * `Agent` fixes its `allowedTools` and its view of the permission mode at construction
 * time, so it cannot itself represent a conversation that changes mode partway through.
 * `Session` is what makes that possible: it builds a new `Agent` around its transcript for
 * every `send()`, so a mode switch (`setMode`) takes effect on the very next turn without
 * ever touching, splitting, or re-appending anything in the transcript itself (the system
 * prompt is appended only when the transcript is empty, which stays true across every
 * rebuild after the first).
 *
 * Building fresh per turn rather than caching one `Agent` instance also happens to be the
 * only clean way to thread each call's own `AbortSignal` through: `Agent` has no public
 * way to rebind a signal after construction. Since `Agent` construction is pure (aside
 * from that guarded system-prompt append), this costs nothing and is behaviorally
 * indistinguishable, when the mode has not changed, from reusing a cached instance.
 *
 * Task 9 adds the one exception to "the transcript is never touched": auto-compaction
 * swaps the WHOLE `Transcript` object for a new one (never edits the old one in place --
 * the append-only law holds per-object, forever; see `applyCompactionSwap`). `this.transcript`
 * is therefore reassignable, not `readonly`, but it is reassigned in exactly one place.
 */
export class Session {
  readonly id: string
  readonly meta: SessionMeta

  private readonly opts: SessionOptions
  private transcript: Transcript
  private readonly workspace: Workspace
  /** How many of transcript.messages() have already been written to the store. Reset to
   * the new transcript's full length at a compaction swap (its messages were just written
   * as fresh JSONL lines right after the marker -- see `applyCompactionSwap`). */
  private persistedCount: number
  /** Whether the title has been set yet (independent of whether it ended up empty). */
  private titled: boolean
  /** Set by setMode(), consumed (and cleared) by the next send(). */
  private pendingModeNote: string | undefined
  /** Guard against concurrent send() calls. persistedCount and pendingModeNote are not concurrency-safe. */
  private sending = false
  /** The newest server-reported `usage.prompt_tokens`, from the latest completed step
   * across the session's whole life (not just the current turn). `null` until the first
   * step of the first turn completes. See `contextUsage()`. */
  private latestPromptTokens: number | null = null
  /** Running total of `usage.completion_tokens` across every completed step this session
   * has ever run. Recorded per the Task 7 brief; not yet exposed on its own -- `fillRatio`
   * intentionally uses `latestPromptTokens` alone (the next step's prompt size already
   * includes every prior completion), so this total is here for a later consumer. */
  private cumulativeCompletionTokens = 0
  /** The one background `generateCompaction` call in flight, if any -- single-slot
   * discipline (only ever one at a time; a new `send()` aborts it first). `promise`
   * NEVER rejects (see `runBackgroundCompaction`), so awaiting it to let the abort settle
   * is always safe. */
  private compactionInFlight: { controller: AbortController; promise: Promise<void> } | undefined
  /** A finished briefing waiting for the NEXT send() to swap in, before that turn runs. */
  private pendingSummary: string | undefined

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
      // NTFS case-insensitivity: two spellings of one directory must not read as different.
      if (resolve(meta.workspaceRoot).toLowerCase() !== resolve(opts.workspaceRoot).toLowerCase()) {
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
   * Real usage numbers where available, alongside the always-on heuristic.
   *
   * `promptTokens` is the newest server-reported prompt size (the latest completed step's
   * `usage.prompt_tokens`, tapped off the agent's own events -- see `composeEvents`), and
   * is `null` until the first step of the first turn completes; `approxTokens` is the
   * existing character-count heuristic over the transcript, which is always available
   * (including before the first step) and never null.
   */
  contextUsage(): { promptTokens: number | null; approxTokens: number } {
    return { promptTokens: this.latestPromptTokens, approxTokens: this.approxTokens() }
  }

  /**
   * How full the model's context window is, as a fraction of `contextLength`, or `null`
   * before the first step (mirroring `contextUsage().promptTokens`).
   *
   * Deliberately just `promptTokens / contextLength`, not `promptTokens + this turn's
   * completion so far`: the *next* step's own prompt size already includes every
   * completion the model has produced up to that point, so adding completion tokens on
   * top here would double-count them. This is also Task 9's compaction trigger input; it
   * does not special-case a mode-note or a compaction having just run (Task 9's own
   * concern, not this one's).
   */
  fillRatio(contextLength: number): number | null {
    if (this.latestPromptTokens === null) return null
    return this.latestPromptTokens / contextLength
  }

  /**
   * Builds the `AgentEvents` actually handed to `Agent`: the host's own events (if any),
   * composed with -- never replaced by -- an internal tap on `onStepDone` that records
   * `contextUsage()`'s inputs. Every other host handler (onThinking, onToolCall, ...)
   * passes through completely untouched; only `onStepDone` is wrapped, and the wrapped
   * version always calls the host's own `onStepDone` too (when one was given), so a host
   * renderer -- e.g. the REPL's per-step timing line -- keeps firing exactly as before.
   */
  private composeEvents(host: AgentEvents | undefined): AgentEvents {
    const captureStepDone = (info: StepInfo): void => {
      if (info.promptTokens !== undefined) this.latestPromptTokens = info.promptTokens
      if (info.completionTokens !== undefined) {
        this.cumulativeCompletionTokens += info.completionTokens
      }
      host?.onStepDone?.(info)
    }
    return { ...host, onStepDone: captureStepDone }
  }

  /**
   * Runs one turn and persists whatever it produced, regardless of outcome. The pending
   * mode note (if any) is prefixed into `text` -- never its own message -- before the
   * turn runs.
   *
   * Task 9's compaction lifecycle brackets the turn: single-slot discipline aborts any
   * background summary generation still running (awaiting it settle) BEFORE this turn
   * touches the model, a ready summary swaps in FIRST (so the turn below already runs on
   * the NEW transcript -- `buildAgent`, `beforeCount`, and the mode-note restore check all
   * read `this.transcript` fresh, so they see the post-swap object automatically, with no
   * separate "was there a swap" branch needed), and the trigger check that may START the
   * next background generation runs last, after this turn's own persistence.
   */
  async send(text: string, signal?: AbortSignal): Promise<TurnResult> {
    if (this.sending) {
      throw new Error('a turn is already running in this session')
    }
    this.sending = true
    try {
      await this.abortInFlightCompaction()
      this.swapInCompactionIfReady()

      const note = this.pendingModeNote
      this.pendingModeNote = undefined
      const userText = note ? `${note}\n${text}` : text

      const agent = this.buildAgent(signal)
      // Captured AFTER buildAgent() (which may append the system prompt on a fresh
      // transcript) and BEFORE runTurn(), so a length comparison after the call tells us,
      // directly, whether the user message actually reached the transcript.
      const beforeCount = this.transcript.messages().length
      const result = await agent.runTurn(userText)

      // Restore the note only when the user message itself never reached the transcript --
      // checked directly against the transcript rather than via `result.steps`, which counts
      // completed model-call rounds, not appends. `steps === 0` used to stand in for this,
      // but it is also what an abort mid-step-1 reports (runTurn: `steps: step - 1`), and
      // that case's user message DID make it in before the step ran -- and, since Task 5,
      // that step may ALSO have appended a partial assistant message marked interrupted.
      // Re-prefixing the note onto the next send() in either of those cases would duplicate
      // it: once already sitting in the transcript on the aborted turn's user message, once
      // again on the next one. Only runTurn's very first check -- signal already aborted
      // before the user message is appended at all -- truly leaves the transcript untouched.
      if (result.stoppedBecause === 'aborted' && note !== undefined &&
          this.transcript.messages().length === beforeCount) {
        this.pendingModeNote = note
      }

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

      // Last, so it observes this turn's own final fillRatio (a step just completed above,
      // so latestPromptTokens is as fresh as it will be until the NEXT send()).
      this.maybeStartBackgroundCompaction()

      return result
    } finally {
      this.sending = false
    }
  }

  /**
   * The manual escape hatch (`/compact` in the REPL): runs one compaction cycle right
   * now, synchronously, and applies it immediately -- no waiting for a background
   * generation or a following `send()`. Available even when `SessionOptions.compaction`
   * was never set: that option only gates the AUTOMATIC 80%-fill trigger, not this
   * explicit, user-requested one, and `keepRecent` still has its own default (6) to fall
   * back on when a host never configured either.
   *
   * Shares `abortInFlightCompaction` with `send()`'s single-slot discipline: a background
   * generation already running is aborted first (its result, if any, discarded -- this
   * call always regenerates fresh off the CURRENT transcript, and a summary that was
   * merely "ready" but not yet swapped in is discarded too, for the same reason). Emits
   * the same `onCompaction` states `send()`'s own lifecycle does (`'started'` then either
   * `'ready'` + `'applied'`, or `'failed'`), so a host's existing renderer needs no special
   * case for the manual path.
   */
  async forceCompact(signal?: AbortSignal): Promise<void> {
    if (this.sending) {
      throw new Error('a turn is already running in this session')
    }
    this.sending = true
    try {
      await this.abortInFlightCompaction()
      this.pendingSummary = undefined

      this.opts.onCompaction?.({ state: 'started' })
      try {
        const result = await generateCompaction(
          this.opts.client,
          { messages: this.transcript.messages(), workspaceRoot: this.opts.workspaceRoot },
          signal,
        )
        this.opts.onCompaction?.({ state: 'ready' })
        this.applyCompactionSwap(result.summary)
      } catch {
        this.opts.onCompaction?.({ state: 'failed' })
      }
    } finally {
      this.sending = false
    }
  }

  /**
   * Single-slot discipline (the server runs `-np 1`): a no-op when nothing is running,
   * otherwise aborts the in-flight background generation and waits for it to actually
   * settle before returning. Safe to await unconditionally -- `runBackgroundCompaction`
   * catches everything itself (an abort included) and its returned promise never rejects.
   */
  private async abortInFlightCompaction(): Promise<void> {
    const inFlight = this.compactionInFlight
    if (!inFlight) return
    inFlight.controller.abort()
    await inFlight.promise
  }

  /** Applies a ready summary, if one is waiting, before the turn about to run. A no-op
   * otherwise (the common case: most turns run with no compaction pending at all). */
  private swapInCompactionIfReady(): void {
    if (this.pendingSummary === undefined) return
    const summary = this.pendingSummary
    this.pendingSummary = undefined
    this.applyCompactionSwap(summary)
  }

  /**
   * The swap itself: builds a brand-new `Transcript` -- system prompt rebuilt for the
   * CURRENT mode, the one synthetic briefing/ack pair, then the old transcript's tail
   * (verbatim, clean-boundary-walked -- see `selectCompactionTail`) -- and only then
   * reassigns `this.transcript` to it. The old `Transcript` object itself is never
   * touched; this is a swap of the reference `this.transcript` holds, not an edit.
   *
   * Persistence mirrors that: the marker line is written first, then the WHOLE new
   * transcript's messages as fresh JSONL lines (never a diff against the old file) --
   * the simpler, more robust form the brief calls for, over trying to replay a partial
   * reconstruction. `persistedCount` is reset to match, so the very next persistence
   * step (this same `send()`'s own, a few lines below where this is called from, or
   * `forceCompact`'s caller re-entering `send()` later) only ever writes what the NEW
   * transcript gains from here on.
   */
  private applyCompactionSwap(summary: string): void {
    const keepRecent = this.opts.compaction?.keepRecent ?? 6
    const { tail, droppedMessages } = selectCompactionTail(this.transcript.messages(), keepRecent)

    const next = new Transcript()
    next.append({
      role: 'system',
      content: buildSystemPrompt({ workspaceRoot: this.workspace.root, mode: this.meta.mode }),
    })
    next.append({ role: 'user', content: `${COMPACTION_BRIEFING_PREFIX}\n${summary}` })
    next.append({ role: 'assistant', content: COMPACTION_ACK_TEXT })
    for (const m of tail) next.append(m)

    const store = this.opts.store
    if (store) {
      store.appendCompactionMarker(this.id, { summary, droppedMessages })
      store.appendMessages(this.id, next.messages())
    }

    this.transcript = next
    this.persistedCount = next.messages().length
    this.opts.onCompaction?.({ state: 'applied', droppedMessages })
  }

  /**
   * The automatic trigger: starts a background summary generation over the CURRENT
   * messages when the context is full enough and nothing is already pending or ready.
   * Fire-and-forget from `send()`'s point of view -- `compactionInFlight` is what lets a
   * LATER `send()` find it again to abort it (single-slot discipline) or, once it
   * resolves, find nothing left in flight and a ready summary waiting to swap in.
   */
  private maybeStartBackgroundCompaction(): void {
    const cfg = this.opts.compaction
    if (!cfg) return
    if (this.compactionInFlight || this.pendingSummary !== undefined) return

    const ratio = this.fillRatio(cfg.contextLength)
    const triggerRatio = cfg.triggerRatio ?? 0.8
    if (ratio === null || ratio < triggerRatio) return

    const controller = new AbortController()
    const messages = this.transcript.messages()
    const promise = this.runBackgroundCompaction(messages, controller.signal)
    this.compactionInFlight = { controller, promise }
    this.opts.onCompaction?.({ state: 'started' })
  }

  /**
   * The background worker itself. NEVER rejects: a genuine generation failure and a
   * caller-initiated abort are both reported the same way, as one `'failed'` event --
   * from a host's perspective both mean exactly the same thing ("no summary is coming
   * from this attempt, the session carries on uncompacted, and the next `send()` may
   * start a fresh attempt if it's still over threshold"), and collapsing them into one
   * code path is simpler than distinguishing an abort as a non-failure that a host would
   * need its own case for.
   */
  private async runBackgroundCompaction(messages: readonly ChatMessage[], signal: AbortSignal): Promise<void> {
    try {
      const result = await generateCompaction(
        this.opts.client, { messages, workspaceRoot: this.opts.workspaceRoot }, signal,
      )
      this.pendingSummary = result.summary
      this.compactionInFlight = undefined
      this.opts.onCompaction?.({ state: 'ready' })
    } catch {
      this.compactionInFlight = undefined
      this.opts.onCompaction?.({ state: 'failed' })
    }
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
    // Always composed, even when no host events were supplied: Session must keep tapping
    // onStepDone for contextUsage()/fillRatio() on every turn, host renderer or not (a
    // one-shot CLI call, or a test, may never pass `events` at all).
    agentOpts.events = this.composeEvents(this.opts.events)
    if (this.opts.maxSteps !== undefined) agentOpts.maxSteps = this.opts.maxSteps
    if (signal) agentOpts.signal = signal

    return new Agent(agentOpts)
  }
}
