import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { Agent, type AgentEvents, type AgentOptions, type StepInfo, type TurnResult } from '../agent/loop.js'
import { buildSystemPrompt } from '../agent/prompt.js'
import { LoopDetector } from '../agent/loop-detector.js'
import { CheckpointStore, type Checkpoint } from '../checkpoints/store.js'
import { commandsFrom, WorkLog } from './worklog.js'
import type { LoadedMemory } from '../memory/project-memory.js'
import type { FormatRule } from '../format/config.js'
import { createFormatRunner, type FormatRunner } from '../format/runner.js'
import { createHookRunner, type HookRunner, type HookSpec } from '../hooks/hooks.js'
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
 * `'started'`, `'applied'`, `'postponed'`, and `'failed'`; see `repl.ts`). `droppedMessages`
 * is only ever present on `'applied'` -- the other four states have nothing to report yet.
 *
 * `'postponed'` covers two distinct causes, both non-failures the session recovers from on
 * its own: (1) the background generation was aborted by a new `send()` arriving mid-attempt
 * (or, for `/compact`, by the user cancelling it) -- see `runBackgroundCompaction` and
 * `forceCompact`; (2) a completed summary would have produced a no-progress swap (the new
 * transcript isn't meaningfully smaller than the old one) and was abandoned rather than
 * applied -- see `applyCompactionSwap`'s `NO_PROGRESS_RATIO` guard. Neither case is a
 * generation error, so neither uses `'failed'`. */
export interface CompactionEvent {
  state: 'started' | 'ready' | 'applied' | 'postponed' | 'failed'
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
  /**
   * Project memory, ALREADY LOADED by the host (mirroring how `engine` is handed
   * pre-loaded layers rather than reading files itself). Frozen for this session's life:
   * it lives in the system message, and rewriting message 0 is what the append-only
   * transcript discipline forbids.
   */
  memory?: LoadedMemory
  /** Formatter rules from the settings layers, already parsed by the host. Empty or absent
   * means no formatting, which is the normal case. */
  formatRules?: FormatRule[]
  /** After-tool hooks from the settings layers, already parsed by the host. */
  hooks?: HookSpec[]
  /**
   * Snapshot the workspace after every turn that changed it, and record what changed in
   * a work log. Absent means neither happens, which is what every caller that predates
   * long runs gets — a one-shot task has nothing to review in the morning.
   */
  longRun?: boolean
  /** Absent -> the feature is off; see `CompactionOptions`. */
  compaction?: CompactionOptions
  onCompaction?(info: CompactionEvent): void
}

const PLAN_MODE_NOTE = '(mode is now plan: investigate and propose; do not edit)'

/** Important-5 guard (see `applyCompactionSwap`): a swap is abandoned, not applied, when
 * the NEW transcript's `approxTokens()` is still at least this fraction of the OLD
 * transcript's -- i.e. it didn't shrink by a meaningful margin (a `keepRecent` at or past
 * the transcript's own length, or a clean-boundary walk-back that ate nearly the whole
 * tail, both leave a swap that frees ~nothing). 0.9 rather than "any shrink at all
 * counts": a swap that only trims a sliver isn't worth the generation cost or the
 * audit-trail bloat of a marker + a barely-smaller transcript either. */
const NO_PROGRESS_RATIO = 0.9

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
  /** The assembled AGENTS.md block, or undefined when nothing loaded. Read once from
   * `opts.memory` so both build sites — `buildAgent` and `applyCompactionSwap` — use the
   * same text and cannot drift. */
  private readonly memoryText: string | undefined
  /** The project's formatter, when `.privatecode/settings.json` configures one. */
  private readonly formatRunner: FormatRunner | undefined
  /** Built once per Session so a hook's failure counter spans the session, not one turn. */
  private readonly hookRunner: HookRunner | undefined
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
  /** Set when the in-flight background compaction was just aborted (a new `send()`
   * arriving mid-attempt, not a genuine failure) -- consumed exactly once by the very
   * next `maybeStartBackgroundCompaction` call, which is that SAME `send()`'s own tail
   * call, so it doesn't immediately restart an attempt on the transcript it just finished
   * aborting. A LATER `send()`, once this is cleared, re-triggers normally if still over
   * threshold. */
  private skipNextTrigger = false

  constructor(opts: SessionOptions) {
    this.opts = opts
    this.workspace = new Workspace(opts.workspaceRoot)
    // Frozen here, once: both places that build a system message read this field, so they
    // cannot drift, and a mid-session edit to AGENTS.md cannot reach message 0.
    this.memoryText = opts.memory && opts.memory.text !== '' ? opts.memory.text : undefined
    this.formatRunner = opts.formatRules && opts.formatRules.length > 0
      ? createFormatRunner(opts.formatRules, this.workspace)
      : undefined
    this.hookRunner = opts.hooks && opts.hooks.length > 0
      ? createHookRunner(opts.hooks, this.workspace)
      : undefined

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

    // Built here rather than lazily so a long run's very first turn already has a baseline
    // to diff against -- the "before I touched anything" point is the one a morning rewind
    // most often wants, and it only exists if it is taken before any work happens.
    this.checkpoints = opts.longRun ? new CheckpointStore(opts.workspaceRoot) : null
    this.workLog = opts.longRun ? new WorkLog(opts.workspaceRoot) : null
  }

  /**
   * Problems from the long-run machinery, for a host to surface alongside settings problems.
   * Read after each turn: the store reports lazily, as it discovers git is missing or the
   * workspace cannot be written.
   */
  longRunProblems(): string[] {
    return [...(this.checkpoints?.problems ?? []), ...(this.workLog?.problems ?? [])]
  }

  /** The checkpoints taken in this workspace, newest first. Empty when not a long run. */
  async listCheckpoints(limit?: number): Promise<Checkpoint[]> {
    return this.checkpoints ? this.checkpoints.list(limit) : []
  }

  /**
   * Restores the workspace to a checkpoint and APPENDS a note saying so.
   *
   * The append is the whole point and is not bookkeeping: the transcript is append-only by
   * law, and the model has just been told, in messages it still believes, that it edited
   * files that no longer contain those edits. Silently restoring the files would leave it
   * acting on a workspace it thinks it knows. It is told instead.
   */
  async rewind(checkpointId: string): Promise<{ restored: Checkpoint; undo: Checkpoint }> {
    if (!this.checkpoints) throw new Error('this session is not keeping checkpoints')
    if (this.sending) throw new Error('a turn is running; stop it before rewinding')
    const result = await this.checkpoints.rewind(checkpointId)
    this.lastCheckpoint = result.restored
    this.transcript.append({
      role: 'user',
      content:
        `The workspace was rolled back to checkpoint ${result.restored.id} by the user. ` +
        'Any file changes you made after that point are gone from disk, whatever earlier ' +
        `messages say. Re-read any file before editing it. To undo this rollback the user ` +
        `can restore checkpoint ${result.undo.id}.`,
    })
    this.persistIfPossible()
    return result
  }

  /** Writes any transcript messages the store has not seen yet. Shared by send() and
   * rewind(), which both append outside a turn's own persistence path. */
  private persistIfPossible(): void {
    const store = this.opts.store
    if (!store) return
    const all = this.transcript.messages()
    const fresh = all.slice(this.persistedCount)
    if (fresh.length > 0) {
      store.appendMessages(this.id, fresh)
      this.persistedCount = all.length
    }
    store.saveMeta(this.meta)
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
    // The work log's "Ran" line is built from what the tools ACTUALLY returned, tapped here
    // rather than reconstructed from the transcript afterwards: run_command's first result
    // line carries the real exit code, and the alternative -- trusting the model's prose
    // about whether the tests passed -- is exactly what the log exists not to do.
    const captureToolResult = (name: string, result: { ok: boolean; content: string }): void => {
      if (this.workLog) this.turnCommands.push({ name, args: this.lastToolArgs.get(name) ?? '', content: result.content, ok: result.ok })
      host?.onToolResult?.(name, result as never)
    }
    const captureToolCall = (name: string, args: string): void => {
      if (this.workLog) this.lastToolArgs.set(name, args)
      host?.onToolCall?.(name, args)
    }
    return { ...host, onStepDone: captureStepDone, onToolCall: captureToolCall, onToolResult: captureToolResult }
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

      this.turnNumber += 1
      this.turnCommands = []
      this.lastToolArgs.clear()
      // The baseline: the state before this session touched anything. Taken lazily on the
      // first turn rather than in the constructor, because a session that is only resumed
      // to be read should not commit anything at all.
      if (this.checkpoints && this.lastCheckpoint === null) {
        this.lastCheckpoint = await this.checkpoints.take({})
      }

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

      await this.recordTurn(text, result)

      // Last, so it observes this turn's own final fillRatio (a step just completed above,
      // so latestPromptTokens is as fresh as it will be until the NEXT send()).
      this.maybeStartBackgroundCompaction()

      return result
    } finally {
      this.sending = false
    }
  }

  /**
   * Snapshots what the turn changed and writes one work-log entry.
   *
   * Runs after persistence and before the compaction trigger, and never throws: a session
   * whose log or checkpoint failed is worse off, but failing the user's turn over it —
   * after the work is already done and saved — would be worse still.
   */
  private async recordTurn(ask: string, result: TurnResult): Promise<void> {
    if (!this.checkpoints || !this.workLog) return
    try {
      const previous = this.lastCheckpoint
      const taken = await this.checkpoints.take({ sessionId: this.id, turn: this.turnNumber })
      if (taken) this.lastCheckpoint = taken

      // Only when something actually changed: `take` returns null for a read-only turn, and
      // diffing a checkpoint against itself would print an empty stat that reads as an
      // answer rather than as "nothing happened".
      const diffStat = taken && previous ? await this.checkpoints.diffStat(previous.id, taken.id) : ''

      this.workLog.append({
        at: new Date(),
        turn: this.turnNumber,
        ask,
        ...(taken ? { checkpoint: taken.id } : {}),
        ...(diffStat !== '' ? { diffStat } : {}),
        commands: commandsFrom(this.turnCommands),
        ended: result.stoppedBecause,
        steps: result.steps,
      })
    } catch { /* see the doc comment: never at the cost of the turn */ }
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
        const applied = this.applyCompactionSwap(result.summary)
        // Only a genuine apply bumps updatedAt/saveMeta -- an abandoned (no-progress)
        // swap changed nothing about the session worth persisting. send()'s own post-turn
        // code does this unconditionally for the auto-trigger path; forceCompact has no
        // such wrapper around it, so it must do so itself.
        if (applied) {
          this.meta.updatedAt = new Date().toISOString()
          this.opts.store?.saveMeta(this.meta)
        }
      } catch {
        // Same abort-is-not-failure reasoning as runBackgroundCompaction's catch below: a
        // user cancelling /compact via Esc/Ctrl+C is not a generation error and should
        // read as a calm 'postponed', not a scary 'failed'.
        this.opts.onCompaction?.({ state: signal?.aborted ? 'postponed' : 'failed' })
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

  /**
   * The PUBLIC half of single-slot discipline: hosts MUST call this before discarding a
   * `Session` outright -- a `/new`/`/resume` rebuild that replaces it with a fresh one, or
   * process shutdown -- never just let it fall out of scope. A background compaction has
   * no owner to notice the `Session` is gone; left running, it keeps occupying the
   * server's one concurrency slot (`-np 1`) and would still be in flight when a
   * replacement session's very first turn tries to send, queueing behind a generation
   * whose result nothing will ever use.
   *
   * Reuses the same private abort machinery `send()`'s own single-slot discipline calls
   * (`abortInFlightCompaction`): aborts the in-flight generation and awaits its settling,
   * so the slot is genuinely free by the time this resolves, not just marked for future
   * cleanup. Also discards any `pendingSummary` already waiting to swap in -- a summary
   * generated off a transcript this call means to stop relying on is not worth applying
   * on some later turn.
   *
   * A no-op when nothing is in flight and nothing is pending (the common case: most
   * sessions are discarded well under the compaction trigger). Leaves the session itself
   * fully usable afterward -- only in-flight/pending compaction state is discarded, never
   * the transcript -- so a caller that does NOT go on to discard the `Session` can keep
   * sending turns on it exactly as before.
   */
  async abortCompaction(): Promise<void> {
    await this.abortInFlightCompaction()
    this.pendingSummary = undefined
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
   * Before reassigning, the Important-5 no-progress guard compares the NEW transcript's
   * `approxTokens()` against the OLD's (see `NO_PROGRESS_RATIO`): a swap that doesn't
   * meaningfully shrink the transcript is abandoned -- the summary is discarded, nothing
   * is persisted, `this.transcript` is left exactly as it was, and `'postponed'` fires
   * instead of `'applied'`. Returns `true` iff the swap actually applied (callers that
   * need to know -- `forceCompact`, to decide whether to bump `updatedAt` -- check this).
   *
   * Persistence mirrors the swap: the marker line and the WHOLE new transcript's messages
   * are written together via `appendCompactionSwap` -- ONE store call, ONE `appendFileSync`
   * (never a marker write followed by a separate messages write: a crash between two such
   * calls would leave a marker with no payload after it, which `load()` would read back as
   * an empty or system-less session) -- rather than a diff against the old file. This is
   * the simpler, more robust form the brief calls for, over trying to replay a partial
   * reconstruction. `persistedCount` is reset to match, so the very next persistence step
   * (this same `send()`'s own, a few lines below where this is called from, or
   * `forceCompact`'s caller re-entering `send()` later) only ever writes what the NEW
   * transcript gains from here on.
   */
  private applyCompactionSwap(summary: string): boolean {
    const keepRecent = this.opts.compaction?.keepRecent ?? 6
    const { tail, droppedMessages } = selectCompactionTail(this.transcript.messages(), keepRecent)

    const next = new Transcript()
    next.append({
      role: 'system',
      // THE re-anchor. Compaction rebuilds the system message for a fresh Transcript, so
      // passing the same memory here is what carries it across every swap -- no new
      // mechanism, and nothing to forget. It is the memory the session STARTED with, which
      // is also why a mid-session edit to AGENTS.md never appears: message 0 is not
      // rewritten, it is rebuilt from the same frozen text.
      content: buildSystemPrompt({
        workspaceRoot: this.workspace.root,
        mode: this.meta.mode,
        ...(this.memoryText !== undefined ? { memory: this.memoryText } : {}),
      }),
    })
    next.append({ role: 'user', content: `${COMPACTION_BRIEFING_PREFIX}\n${summary}` })
    next.append({ role: 'assistant', content: COMPACTION_ACK_TEXT })
    for (const m of tail) next.append(m)

    const oldApproxTokens = this.transcript.approxTokens()
    if (next.approxTokens() >= oldApproxTokens * NO_PROGRESS_RATIO) {
      // No-progress guard: applying anyway would write a marker + a same-size-or-bigger
      // transcript on every over-threshold turn, forever, freeing no context. Discard the
      // summary and touch nothing -- `this.transcript` (the OLD one) stays live.
      //
      // Nulling here mirrors the successful-swap path below for the same reason: without
      // it, the very next fillRatio() check would still see the stale (already-over-
      // threshold) prompt-token count that triggered this attempt and could re-fire
      // immediately off nothing new. Nulling defers to the next real step's own usage
      // numbers -- if none arrives before the next check (e.g. an aborted turn), the
      // trigger simply stays quiet until one does; if the turn about to run DOES complete
      // a step, that step's fresh number is what the next check sees, exactly as it
      // should.
      this.latestPromptTokens = null
      // same one-send back-off as the abort path: retrying immediately would regenerate the same unusable summary
      this.skipNextTrigger = true
      this.opts.onCompaction?.({ state: 'postponed' })
      return false
    }

    const store = this.opts.store
    if (store) {
      store.appendCompactionSwap(this.id, { summary, droppedMessages }, next.messages())
    }

    this.transcript = next
    this.persistedCount = next.messages().length
    // fillRatio must wait for a real measurement against the NEW transcript -- the stale
    // pre-swap prompt-token count would otherwise immediately look "still over threshold"
    // against the just-shrunk transcript and re-trigger a pointless compaction of the
    // transcript this very call just produced.
    this.latestPromptTokens = null
    this.opts.onCompaction?.({ state: 'applied', droppedMessages })
    return true
  }

  /**
   * The automatic trigger: starts a background summary generation over the CURRENT
   * messages when the context is full enough and nothing is already pending or ready.
   * Fire-and-forget from `send()`'s point of view -- `compactionInFlight` is what lets a
   * LATER `send()` find it again to abort it (single-slot discipline) or, once it
   * resolves, find nothing left in flight and a ready summary waiting to swap in.
   */
  private maybeStartBackgroundCompaction(): void {
    // Consumed exactly once, regardless of anything else below -- see the field's own
    // doc comment. This is what makes the abort-caused postponement a one-send back-off
    // rather than a standing suppression: the very next call after it's set (this same
    // send()'s own tail call) clears it and skips, and every call after THAT behaves as
    // if it had never been set.
    if (this.skipNextTrigger) {
      this.skipNextTrigger = false
      return
    }

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
   * The background worker itself. NEVER rejects: a genuine generation failure reports
   * `'failed'`, while a caller-initiated abort (a new `send()` arriving mid-attempt, via
   * `abortInFlightCompaction`) reports `'postponed'` instead -- these are NOT the same
   * thing to a user. `'failed'` used to cover both, but an abort is the single-slot
   * discipline working exactly as designed, not a broken generation; reporting it as
   * "failed" every time is needlessly scary, and could even read as a livelock symptom
   * (start -> abort -> restart -> immediately over threshold again -> start -> abort ...)
   * to a user watching an active session. `skipNextTrigger` is this method's other half
   * of that fix: set alongside `'postponed'` so the send() that just did the aborting
   * doesn't also immediately restart a new attempt (see `maybeStartBackgroundCompaction`).
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
      if (signal.aborted) {
        this.skipNextTrigger = true
        this.opts.onCompaction?.({ state: 'postponed' })
      } else {
        this.opts.onCompaction?.({ state: 'failed' })
      }
    }
  }

  /**
   * One per session, not one per turn: the loop worth catching spans turns. A model that
   * re-runs the same failing command once per turn for an hour looks reasonable inside each
   * turn and is the exact failure an overnight run has to survive.
   */
  private readonly loopDetector = new LoopDetector()

  /** Built only for a long run; see `SessionOptions.longRun`. */
  private readonly checkpoints: CheckpointStore | null
  private readonly workLog: WorkLog | null
  /** The checkpoint the last turn ended on, so the next one can diff against it. */
  private lastCheckpoint: Checkpoint | null = null
  /** 1-based, counted by this session rather than read off the transcript: a compaction
   * swap changes the message count and must not renumber the log. */
  private turnNumber = 0
  /** Filled by the event tap during a turn, read and cleared when it ends. */
  private turnCommands: { name: string; args: string; content: string; ok: boolean }[] = []
  /** `onToolCall` carries the arguments and `onToolResult` does not, so the last call's
   * arguments are held here to be paired with its result. One tool runs per step, so a
   * single slot per name is exact. */
  private readonly lastToolArgs = new Map<string, string>()

  private buildAgent(signal?: AbortSignal): Agent {
    const context: ToolContext = {
      workspace: this.workspace,
      todos: this.opts.toolset.todos,
      // The toolset owns it, so it survives a session switch: closing a page the user is
      // looking at because they clicked Resume would be its own small betrayal.
      browser: this.opts.toolset.browser,
    }
    // Built once per Session, so the circuit breaker inside it counts failures across the
    // whole session rather than resetting every turn.
    if (this.formatRunner) context.format = this.formatRunner
    if (this.opts.interaction) context.interaction = this.opts.interaction

    const agentOpts: AgentOptions = {
      client: this.opts.client,
      registry: this.opts.toolset.registry,
      context,
      transcript: this.transcript,
      loopDetector: this.loopDetector,
    }
    if (this.memoryText !== undefined) agentOpts.memory = this.memoryText
    if (this.opts.engine) {
      // mode intentionally omitted here -- see the constructor's invariant note. Agent
      // resolves opts.permissions.mode instead, which is always meta.mode by now.
      agentOpts.permissions = this.opts.engine
    } else {
      agentOpts.mode = this.meta.mode
    }
    if (this.opts.interaction) agentOpts.interaction = this.opts.interaction
    if (this.hookRunner) agentOpts.hooks = this.hookRunner
    // Always composed, even when no host events were supplied: Session must keep tapping
    // onStepDone for contextUsage()/fillRatio() on every turn, host renderer or not (a
    // one-shot CLI call, or a test, may never pass `events` at all).
    agentOpts.events = this.composeEvents(this.opts.events)
    if (this.opts.maxSteps !== undefined) agentOpts.maxSteps = this.opts.maxSteps
    if (signal) agentOpts.signal = signal

    return new Agent(agentOpts)
  }
}
