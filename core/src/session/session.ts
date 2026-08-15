import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import {
  Agent, DEFAULT_STEP_TIMEOUT_MS, MAX_COLD_START_MS, PREFILL_MS_PER_TOKEN,
  type AgentEvents, type AgentOptions, type StepInfo, type StepPreamble, type TurnResult,
} from '../agent/loop.js'
import { buildSystemPrompt } from '../agent/prompt.js'
import { LoopDetector } from '../agent/loop-detector.js'
import type { Checkpoint } from '../checkpoints/store.js'
import { CheckpointSet } from '../checkpoints/set.js'
import { soleUnit, type SnapshotUnit } from '../checkpoints/units.js'
import { commandsFrom, WorkLog } from './worklog.js'
import { recordToolOutcome } from '../host/replay.js'
import { DecisionQueue, queueingPort } from './decisions.js'
import type { Mount } from '../mounts.js'
import type { LoadedMemory } from '../memory/project-memory.js'
import type { DatabaseSettings } from '../sql/settings.js'
import type { LoadedSkills } from '../skills/skills.js'
import type { FormatRule } from '../format/config.js'
import { createFormatRunner, type FormatRunner } from '../format/runner.js'
import { createHookRunner, type HookRunner, type HookSpec } from '../hooks/hooks.js'
import type { VerifySpec } from '../verify/config.js'
import { runVerify, verifyFailureMessage } from '../verify/runner.js'
import type { InteractionPort, TodoItem } from '../interaction.js'
import { LlamaRequestError, type LlamaClient } from '../llama/client.js'
import type { ChatMessage } from '../llama/types.js'
import type { AgentMode, PermissionEngine } from '../permissions/engine.js'
import type { Toolset } from '../tools/default-set.js'
import type { ToolContext } from '../tools/types.js'
import { Transcript } from '../transcript/transcript.js'
import { Workspace } from '../workspace.js'
import {
  COMPACTION_ACK_TEXT, COMPACTION_BRIEFING_PREFIX, continuationInventory, generateCompaction,
  selectCompactionTail, touchedPaths,
} from './compaction.js'
import { SessionStore, type CompactionMarker, type SessionMeta } from './store.js'

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
  /**
   * Why a `'postponed'` changed nothing, when the answer is worth distinguishing.
   *
   * `'nothing-to-gain'` means the conversation is too short for a summary to be smaller than
   * what it would replace — not a failure, and not the same thing as a compaction that tried
   * and could not help.
   */
  reason?: 'nothing-to-gain'
  /**
   * What the swap actually did, present only on `'applied'`.
   *
   * A compaction used to pass almost invisibly — five seconds of status text — while being
   * the single most consequential thing that happens to a session: from then on the model
   * works from the briefing, not from the conversation. If something was lost, that is worth
   * seeing at the moment it happens rather than inferring it three turns later from odd
   * behaviour.
   */
  detail?: {
    beforeTokens: number
    afterTokens: number
    /** The briefing the model wrote for itself, verbatim. */
    summary: string
    /** How many recent messages were carried over untouched. */
    keptMessages: number
  }
}

export interface SessionOptions {
  client: LlamaClient
  toolset: Toolset // from createToolset()
  workspaceRoot: string
  /**
   * The folders this workspace is made of, primary first. Omit for a plain single-folder
   * workspace, which is what every existing caller does and what the tests rely on.
   */
  mounts?: readonly Mount[]
  /**
   * What the undo store snapshots: one unit per writable folder, plus one per git
   * repository nested inside one. Discovered by the caller (it needs a disk scan); omitted,
   * this is the single store a plain workspace has always had.
   */
  units?: readonly SnapshotUnit[]
  mode?: AgentMode // default 'normal'
  interaction?: InteractionPort
  engine?: PermissionEngine
  store?: SessionStore // omit -> in-memory only (tests, one-shot CLI)
  resume?: string // session id to load
  maxSteps?: number
  /**
   * How often a still-running turn may snapshot the work tree. Defaults to
   * `MID_TURN_CHECKPOINT_MS`; `0` snapshots after every step that wrote.
   *
   * The trade is between what a rewind can cost you and what the snapshots cost to take —
   * a checkpoint is a real commit over the whole tree. Two minutes suits a workspace of
   * ordinary size; a small one can afford to be tighter.
   */
  checkpointIntervalMs?: number
  events?: AgentEvents
  /**
   * Project memory, ALREADY LOADED by the host (mirroring how `engine` is handed
   * pre-loaded layers rather than reading files itself). Frozen for this session's life:
   * it lives in the system message, and rewriting message 0 is what the append-only
   * transcript discipline forbids.
   */
  memory?: LoadedMemory
  /**
   * The skills this workspace offers, ALREADY LOADED by the host — same discipline as
   * `memory` and `engine`: the Session is handed ready-made state rather than reading files
   * itself. Its `catalogue` goes in the system message; the list itself reaches `use_skill`
   * through the tool context.
   */
  /** What earlier sessions learned, ALREADY LOADED and already re-checked against the code
   * it describes — see `memory/project-notes.ts`. */
  notes?: string
  skills?: LoadedSkills
  /** The database this workspace works against, when one is configured. Absent — the normal
   * case — leaves the `database` tool answering with where to configure one. */
  database?: DatabaseSettings
  /** Its shape, ALREADY FETCHED, for the cached prefix. Read by the caller rather than here
   * because it crosses a network: a session must start whether or not the server answers. */
  databaseSchema?: string
  /**
   * Re-renders the repository map around the files the session has touched.
   *
   * Called at a compaction swap and nowhere else. That moment is chosen because it is the
   * one time the system message is being rebuilt anyway — doing it per turn is Aider's
   * design and would cost a full prompt-cache re-prefill on every request (measured: 90 s on
   * a 43k transcript), which is more than a better-ordered map can be worth. It is also the
   * moment the answer is best: by then the session has a subject, and the map that survives
   * the swap can be about the work rather than about the project in the abstract.
   */
  rerankRepoMap?: (focus: readonly string[]) => string
  /** The project map, ALREADY BUILT by the host -- mirroring how `memory` and `engine`
   * arrive ready-made. Carried across compaction swaps for the same reason memory is: it
   * belongs to the session, not to one agent instance. */
  repoMap?: string
  /** Formatter rules from the settings layers, already parsed by the host. Empty or absent
   * means no formatting, which is the normal case. */
  formatRules?: FormatRule[]
  /** After-tool hooks from the settings layers, already parsed by the host. */
  hooks?: HookSpec[]
  /**
   * The project's own check, run after any turn that wrote something. Absent means the
   * feature is off, which is the right default: a verify command is a promise about how
   * long every writing turn takes, and only the project's owner can make it.
   */
  verify?: VerifySpec
  /**
   * Per-folder verify commands, keyed by folder name, from the workspace profile.
   *
   * The profile is the ONLY source for an attached folder's command. A verify command is a
   * shell command run without a per-run approval, and reading one out of a folder you merely
   * pointed at would be a way to execute arbitrary code by reference. An entry here also
   * overrides `verify` for the primary folder, which is what makes a workspace able to say
   * "in this combination, check it this way".
   */
  verifyFolders?: Record<string, VerifySpec>
  /** Fired for every verify run, pass or fail, so a window can show that it happened. A
   * check that silently added thirty seconds to each turn would read as the app hanging.
   * `folder` is present only in a multi-folder workspace, where "which one" is a question. */
  onVerify?(info: {
    command: string; ok: boolean; attempt: number; folder?: string
    exitCode?: number; problem?: string
  }): void
  /**
   * Snapshot the workspace after every turn that changed it, and record what changed in
   * a work log. Absent means neither happens, which is what every caller that predates
   * long runs gets — a one-shot task has nothing to review in the morning.
   */
  longRun?: boolean
  /**
   * Park an unanswered approval or question instead of blocking on it forever.
   *
   * Absent means today's behaviour exactly: a request waits for a person indefinitely, which
   * is right when there IS a person. See `session/decisions.ts`.
   */
  unattended?: { approvalTimeoutMs?: number }
  /** Absent -> the feature is off; see `CompactionOptions`. */
  compaction?: CompactionOptions
  onCompaction?(info: CompactionEvent): void
}

/** What counts as changing the workspace, for `turnFootprint`. Mirrors the permission
 * engine's own write family; restated here rather than imported so a change to the gate's
 * membership is a deliberate decision in both places. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['edit_file', 'write_file', 'move_file', 'delete_file'])
const COMMAND_TOOLS: ReadonlySet<string> = new Set(['run_command', 'background_task'])

const PLAN_MODE_NOTE = '(mode is now plan: investigate and propose; do not edit)'

/** How many times one turn may be handed its own verification failure.
 *
 * Two, not more: the first round is the fix a model can usually make from a compiler error,
 * the second covers a fix that broke something adjacent. Past that it is guessing, and each
 * guess is another write to a workspace that is already broken. */
const MAX_VERIFY_ROUNDS = 2

/**
 * Room kept clear in the window for a summary request: the ~4.5k tokens the generation may
 * produce (compaction.ts's RETRY_MAX_TOKENS) plus a margin for the chat template's own
 * scaffolding, which is not in any per-message estimate.
 *
 * Sized generously on purpose. Being wrong low costs a few hundred tokens of transcript in
 * one summary; being wrong high costs the whole remedy, which is the failure this exists to
 * remove.
 */
const SUMMARY_OUTPUT_RESERVE = 8_000

/**
 * The most transcript one summary request may carry.
 *
 * 40k at the 393 tok/s measured here is ~100 s of prefill — fast enough to finish between
 * two messages, and with room to spare against every timeout in the path. The alternative,
 * sizing it to the window, produced a request that took as long as the problem it was
 * solving.
 */
const SUMMARY_MAX_INPUT_TOKENS = 40_000

/**
 * The share of the window a compaction may leave occupied by kept-verbatim recent messages.
 *
 * A fifth, so a compacted session starts with room to work rather than one turn from the
 * ceiling again. Measured before this: keeping six messages by count alone left 111.7k of
 * 131.1k, and the very next turn was back at the wall.
 */
const TAIL_SHARE = 0.2

/**
 * Below this much replaceable conversation, a summary cannot be smaller than what it
 * replaces: the briefing alone is budgeted at 3000 tokens (compaction.ts's MAX_TOKENS),
 * plus the acknowledgement and the instruction. Twice that is the point where the trade
 * starts being worth a generation.
 */
const MIN_COMPACTABLE_TOKENS = 6_000

/**
 * How much room a turn needs beyond what the transcript already occupies: the user's message
 * plus a few steps of tool results and reasoning.
 *
 * Deliberately small next to the 80% background trigger — this is not a second opinion about
 * when to compact, it is the backstop for a conversation that is already at the edge.
 */
const PRE_TURN_HEADROOM = 4_000

/** How often a still-running turn may snapshot the work tree. Two minutes bounds what a
 * rewind can cost you at two minutes of work, and bounds the price at one commit per two
 * minutes however long the turn runs. See `Session.checkpointLongTurn`. */
const MID_TURN_CHECKPOINT_MS = 120_000

/**
 * How much work must accumulate before the project's check runs again inside a turn.
 *
 * Both gates matter and they guard different things. The write count stops a check running
 * after a one-line edit; the interval stops a burst of edits triggering three builds in a
 * minute. Five writes is roughly "a coherent piece of work", and four minutes is long enough
 * that even a slow suite is a small fraction of the turn it is protecting.
 */
/**
 * The interval a check falls back to once it has proved slow. Not a gate on a fast one: a
 * 1.07 s incremental build after each write is cheaper than the step the model would spend
 * running it itself, and `MID_TURN_VERIFY_WRITES` — five writes — fired less often than the
 * model's own median of one, so it could never displace the habit.
 */
const MID_TURN_VERIFY_MS = 240_000

/**
 * How many unchecked writes may pile up before the check runs anyway, mid-edit.
 *
 * A multi-file change should not be interrupted, but a rename touching twenty files must not
 * go unchecked for twenty steps either — the value of the check is that it fires near the
 * mistake. Eight is roughly "a large but coherent edit".
 */
const VERIFY_BURST_CAP = 8

/** Past this, a check cannot run per write without dominating the turn it protects. */
const SLOW_VERIFY_SECONDS = 8

/**
 * Where the model is told how full its context is.
 *
 * Below 60% there is nothing to act on and the reminder would be noise. 85% is close enough
 * that the next compaction is likely within a few steps, which is exactly when writing
 * something down is worth a step. The 80% figure the automatic trigger uses sits between the
 * last two on purpose: the model gets a warning before the thing happens, not after.
 */
const CONTEXT_FILL_MARKS = [0.6, 0.75, 0.85] as const

/** The only tools the work log's "Ran" line is built from — `commandsFrom` drops everything
 * else. Kept beside the capture rather than only inside the formatter, because the point is
 * to not RETAIN what will be discarded. */
const LOGGED_TOOLS = new Set(['run_command', 'background_task'])

/**
 * Prefill cost and the ceiling on a cold wait both live in `loop.ts` now.
 *
 * They were measured twice, independently, for two budgets that turned out to be the same
 * quantity: this file's 393 tok/s while warming a compacted session, and the loop's own
 * 2.1-3.8 ms/token while a step waited for its first token. Two copies of a number nobody
 * would think to update together is how they drift.
 */

/**
 * What every request carries that `Transcript.approxTokens()` cannot see: the tool schemas.
 *
 * Measured, not guessed — 15 tools, 10,149 characters of JSON schema, ~2,538 tokens by the
 * same chars/4 rule. It is sent with every single request and was simply missing from the
 * fill estimate, which is one of the reasons the estimate read low enough to let an
 * over-long prompt through.
 */
const TOOL_SCHEMA_TOKENS = 2_600

/** What the retry says instead of repeating the user's message, which is already in the
 * compacted tail. */
const OVERFLOW_RETRY_NOTE =
  'The conversation had outgrown the context window and has just been compacted. Continue ' +
  'with the request above, using the briefing for anything the summary replaced.'

/**
 * The prompt size llama.cpp reported when it refused, or null when this was some other
 * failure.
 *
 * Reads the server's own JSON body (`exceed_context_size_error`, `n_prompt_tokens`) rather
 * than the status code alone: a 400 can mean other things, and acting on the wrong one would
 * compact a conversation for no reason.
 */
export function contextOverflowTokens(e: unknown): number | null {
  if (!(e instanceof LlamaRequestError) || e.body === undefined) return null
  try {
    const parsed = JSON.parse(e.body) as { error?: { type?: string; n_prompt_tokens?: number } }
    if (parsed.error?.type !== 'exceed_context_size_error') return null
    const tokens = parsed.error.n_prompt_tokens
    return typeof tokens === 'number' && tokens > 0 ? tokens : null
  } catch {
    return null
  }
}

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
  /**
   * The compaction the RESUMED transcript opens on, or null -- for a session created fresh,
   * or resumed from a file that never compacted.
   *
   * Set once, at construction, and deliberately NOT updated by swaps this process performs:
   * it exists so a resumed conversation can be shown with its history-fold in it, and a
   * swap that happens while the window is open is already on screen as a live event. Its
   * one reader is the host's replay at resume time.
   */
  readonly loadedCompaction: CompactionMarker | null

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
  /** The skills catalogue, frozen the same way and for the same reason as `memoryText`.
   * Note the asymmetry this creates deliberately: the catalogue survives a compaction swap
   * unchanged, while a skill's BODY is re-read from disk on every `use_skill` call. */
  private readonly skillsText: string | undefined
  /** Frozen like the rest of message 0: a note recorded this session lands in the next. */
  private readonly notesText: string | undefined
  /**
   * NOT readonly, and this is the one thing in the frozen set that moves. At a compaction
   * swap the system message is rebuilt anyway, so that is the one moment the map can be
   * re-ordered around the work at no cache cost — and the moment it is worth most, because
   * only by then does the session have a subject. A second swap re-focuses from here again.
   */
  private repoMapText: string | undefined
  /**
   * Every path this session has touched, ACROSS swaps.
   *
   * `touchedPaths` reads the transcript, and after a swap the transcript holds the briefing —
   * which carries no tool calls — plus a short tail. So the second compaction of a session
   * saw almost nothing: simulated against the four real swaps in the recorded corpus, the
   * inventory named 2 paths where the session had touched 38, then 10 against 43, then 22
   * against 51. The briefing's whole job is to carry "what have I opened" across the gap as
   * data rather than as something the model remembered to write down, and it was quietly
   * losing most of it at exactly the moment it mattered most.
   */
  private readonly touchedSeen = new Set<string>()
  private readonly touchedChanged = new Set<string>()
  private schemaText: string | undefined
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
    this.workspace = new Workspace(opts.mounts ?? opts.workspaceRoot)
    // Frozen here, once: both places that build a system message read this field, so they
    // cannot drift, and a mid-session edit to AGENTS.md cannot reach message 0.
    this.memoryText = opts.memory && opts.memory.text !== '' ? opts.memory.text : undefined
    this.skillsText = opts.skills && opts.skills.catalogue !== '' ? opts.skills.catalogue : undefined
    this.notesText = opts.notes !== undefined && opts.notes !== '' ? opts.notes : undefined
    this.repoMapText = opts.repoMap !== undefined && opts.repoMap !== '' ? opts.repoMap : undefined
    // Carried across a compaction swap unchanged, unlike the map: the map is re-ranked
    // around what the session turned out to be about, and a schema has no such focus -- it
    // is the same database it was an hour ago, and re-reading it would cost a round trip to
    // produce identical text.
    this.schemaText = opts.databaseSchema !== undefined && opts.databaseSchema !== ''
      ? opts.databaseSchema : undefined
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
      const { meta, transcript, compaction } = opts.store.load(opts.resume)

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
      this.loadedCompaction = compaction
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
      this.loadedCompaction = null
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
    // A SET of units, not one store: a folder that contains its own git repository cannot be
    // snapshotted as one tree (git records the nested one as a pointer and a rewind restores
    // nothing inside it), so coverage is one shadow store per unit. `units` is discovered by
    // the caller because that needs a disk scan and this constructor is synchronous; without
    // it this is the single store it has always been.
    this.checkpoints = opts.longRun
      ? new CheckpointSet(opts.units ?? [soleUnit(opts.workspaceRoot)], opts.workspaceRoot)
      : null
    this.workLog = opts.longRun ? new WorkLog(opts.workspaceRoot) : null
    // The queue exists for any long run; whether it INTERCEPTS is a separate, runtime
    // question. Sitting in front of the window, an approval must wait for the person, not
    // time out into a file they will read tomorrow.
    this.decisions = opts.longRun || opts.unattended ? new DecisionQueue(opts.workspaceRoot) : null
    this.unattendedActive = opts.unattended !== undefined

    // The other half of the correctness condition recorded at `applyCompactionSwap`, and it
    // was missing. The toolset — and with it the read memory — is built once per WORKSPACE
    // and reused for every `sessions.new` and `sessions.resume`, so a fresh session inherited
    // the previous one's reads and answered a first read with "unchanged since you read it
    // earlier in this session, the text you already have is current" about text that appears
    // in no transcript this session can see. A lie the model has no way to detect. Replayed
    // over one recorded app run of three sessions sharing a toolset, it would have answered
    // that way 11 times and been right none of them.
    this.opts.toolset.reads?.clear()
  }

  /**
   * Problems from the long-run machinery, for a host to surface alongside settings problems.
   * Read after each turn: the store reports lazily, as it discovers git is missing or the
   * workspace cannot be written.
   */
  longRunProblems(): string[] {
    // DRAINED, not read. Every caller reports what it gets; leaving the arrays full meant
    // the same problem was re-reported on every later call, and the window only avoided
    // showing it three times because it deduplicates. Taking them also makes this safe to
    // call often, which is what a turn measured in hours needs — a checkpoint that stopped
    // working at hour one should not have to wait for the run to end to say so.
    const drain = (xs: string[] | undefined): string[] => (xs ? xs.splice(0) : [])
    return [
      ...drain(this.checkpoints?.problems as string[] | undefined),
      ...drain(this.workLog?.problems as string[] | undefined),
      ...drain(this.decisions?.problems as string[] | undefined),
    ]
  }

  /** Requests parked because nobody answered them. Empty unless this is an unattended run. */
  pendingDecisions(): ReturnType<DecisionQueue['pending']> {
    return this.decisions ? this.decisions.pending() : []
  }

  /**
   * Turns parking on or off.
   *
   * Called when an unattended run starts and stops. The flag is what decides whether an
   * unanswered approval waits forever (right, when someone is watching) or is queued (right,
   * when nobody is) — the queue's mere existence must not change how a supervised session
   * behaves.
   */
  setUnattended(active: boolean): void {
    this.unattendedActive = active
  }

  /** The queue itself, for a host that needs to resolve entries. */
  decisionQueue(): DecisionQueue | null {
    return this.decisions
  }

  /** The agent's own todo list, which the unattended runner uses to build each nudge. */
  todos(): readonly TodoItem[] {
    return this.opts.toolset.todos.list()
  }

  /**
   * Running totals of the two things that count as WORK: files written and commands run.
   *
   * The unattended runner compares this before and after a turn to answer "did anything
   * happen". Cumulative rather than per-turn so the comparison is a subtraction the caller
   * makes, with no state to reset and nothing to get out of step if a turn throws.
   *
   * Reading and thinking are excluded on purpose. A turn that only read files may well have
   * been useful once; two in a row are a model narrating instead of working, and that is
   * the failure that looks most like progress from the outside.
   */
  turnFootprint(): { writes: number; commands: number } {
    return { writes: this.writeCount, commands: this.commandCount }
  }

  /**
   * Runs the project's own check after a turn that changed something, and hands a failure
   * back to the model before the turn is allowed to end.
   *
   * The failure this exists for: the agent finishes, says "done", and leaves a workspace
   * that no longer compiles. Nobody finds out until a person runs the tests, and by then the
   * turn is over and the context has moved on. Kept INSIDE the turn, so the fix happens
   * where the model still knows what it was attempting and why.
   *
   * Four conditions gate it, and each rules out a way of being annoying rather than useful:
   * a turn that wrote nothing cannot have broken anything; a turn that was aborted or timed
   * out never claimed to be finished; a rounds cap stops a model that cannot fix the failure
   * from grinding at it; and a verify command that cannot be STARTED is reported as a
   * configuration problem rather than as "your change broke the build", which would send
   * the model rewriting working code.
   */
  private async verifyAndFix(
    result: TurnResult, writesThisTurn: number, signal?: AbortSignal,
  ): Promise<TurnResult> {
    if (writesThisTurn === 0 || result.stoppedBecause !== 'done') return result

    // Nothing has been written since the mid-turn check last ran, and it passed. Running the
    // same command again over the same bytes would ask a question that has already been
    // answered — and now that the mid-turn check fires at every write boundary, that is the
    // ORDINARY case rather than a rare coincidence: a turn with one edit would otherwise
    // build twice. A failing last check still falls through, because the fix rounds below
    // are the part that acts on it.
    if (this.writesAtLastVerify === this.writeCount && this.lastVerifyFingerprint === 'ok') {
      return result
    }

    // Only the folders this turn actually wrote to, each with its own command. Running every
    // folder's suite after a one-line edit in one of them turns a thirty-second turn into
    // three minutes, and the folders that were not touched cannot have been broken.
    const jobs = this.verifyJobs()
    if (jobs.length === 0) return result

    let current = result
    for (const job of jobs) {
      current = await this.verifyOne(job, current, signal)
      // A folder still failing after its rounds is the end state; carrying on to the next
      // one would bury the failure the model was just handed.
      if (current.stoppedBecause !== 'done') return current
    }
    return current
  }

  /** The verify commands that apply to what this turn wrote, in mount order. */
  private verifyJobs(): { spec: VerifySpec; root: string; folder: string }[] {
    const jobs: { spec: VerifySpec; root: string; folder: string }[] = []
    for (const mount of this.workspace.mounts) {
      if (!this.writtenMounts.has(mount.name)) continue
      // The workspace profile wins for a folder that has an entry; otherwise the primary
      // folder falls back to its own settings files, which is what a single-folder workspace
      // has always used. An ATTACHED folder never supplies its own command: a verify command
      // is a shell command, and reading one out of a folder you merely pointed at is a way
      // to run arbitrary code by reference.
      const spec = this.opts.verifyFolders?.[mount.name] ?? (mount.primary ? this.opts.verify : undefined)
      if (spec) jobs.push({ spec, root: mount.root, folder: mount.name })
    }
    return jobs
  }

  private async verifyOne(
    job: { spec: VerifySpec; root: string; folder: string },
    result: TurnResult,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    let current = result
    for (let attempt = 1; attempt <= MAX_VERIFY_ROUNDS; attempt++) {
      if (signal?.aborted) return current
      const outcome = await runVerify(job.spec, job.root, signal)
      this.opts.onVerify?.({
        command: job.spec.command,
        ok: outcome.ok,
        attempt,
        ...(this.workspace.multi ? { folder: job.folder } : {}),
        ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}),
        ...(outcome.problem !== undefined ? { problem: outcome.problem } : {}),
      })
      if (outcome.ok) return current
      // A command that cannot run will not run any better on the second attempt, and the
      // model has already been told it is not its fault.
      if (outcome.problem !== undefined) return current

      const where = this.workspace.multi ? `In the "${job.folder}" folder: ` : ''
      const fixer = this.buildAgent(signal)
      const fixed = await fixer.runTurn(`${where}${verifyFailureMessage(job.spec, outcome)}`)
      // The fixer's result REPLACES the outcome — it is the later, truer statement of how the
      // turn ended — but its step count is its own, not the turn's. Replacing that outright
      // is what made the work log say "1 step" for a turn that had taken thirteen, and
      // `steps` is the only number in that log that says how much a turn did. It is now the
      // total: the work, plus the work of fixing what the work broke.
      current = { ...fixed, steps: current.steps + fixed.steps }
      // Aborted or out of steps: stop asking. The workspace is still broken and the
      // transcript says so, which is the honest end state.
      if (current.stoppedBecause !== 'done') return current
    }
    return current
  }

  /** Records the folder a successful write landed in, from the tool call's raw arguments. */
  private notePathWritten(rawArgs: string | undefined): void {
    if (rawArgs === undefined) return
    let parsed: { path?: unknown; to?: unknown }
    try {
      parsed = JSON.parse(rawArgs) as { path?: unknown; to?: unknown }
    } catch {
      return
    }
    // `move_file` reports its destination as `to`; every other write tool uses `path`.
    const target = typeof parsed.path === 'string' ? parsed.path
      : typeof parsed.to === 'string' ? parsed.to : undefined
    if (target === undefined) return
    try {
      const mount = this.workspace.mountFor(this.workspace.resolve(target))
      if (mount) this.writtenMounts.add(mount.name)
    } catch {
      // A path the jail refuses cannot have been written; nothing to record.
    }
  }

  /**
   * Records why the whole run stopped, as the last line of the work log.
   *
   * Separate from the per-turn entry because it is a different fact: the turns say what
   * happened, this says why there are no more of them. Someone reading at 8am scrolls to
   * the bottom for exactly this.
   */
  noteRunEnded(detail: string): void {
    this.workLog?.appendRunEnd(new Date(), this.turnNumber, detail)
  }

  /**
   * How much transcript a summary request may carry: the window, less the room the summary
   * itself needs to be generated into, less a margin for the chat template's own overhead.
   *
   * Zero when the window is unknown, which means "send everything" — the behaviour every
   * caller had before a session was found that no longer fit in it.
   */
  private summaryBudget(): number {
    const contextLength = this.opts.compaction?.contextLength
    if (contextLength === undefined || contextLength <= 0) return 0
    // Capped far below the window, not merely inside it.
    //
    // "The window minus a reserve" made a summary request nearly as large as the conversation
    // it was rescuing: ~123k tokens, five minutes of prefill before a word is generated, and
    // an answer that has to arrive before the client's own transport timeout. Measured on
    // this machine at 393 tok/s of prefill, that is the difference between a remedy that
    // finishes and one that keeps being interrupted — and in the session that prompted this,
    // compaction had NEVER once applied: zero markers in 374 messages.
    //
    // A summary does not need the whole conversation. `fitForSummary` already keeps the
    // system message, the opening exchange and the most recent work, which is what a
    // continuation is built from; the middle is what a summary is for.
    return Math.max(0, Math.min(contextLength - SUMMARY_OUTPUT_RESERVE, SUMMARY_MAX_INPUT_TOKENS))
  }

  /**
   * The deadline for a step that has to prefill the whole prompt before generating.
   *
   * Derived from this repo's own measurement rather than picked: `Transcript`'s benchmark
   * recorded 27.7 s to re-prefill a ~14.9k-token history, which is ~1.9 ms per token. At
   * 130k tokens that is four minutes of work the ordinary 90 s budget does not contain.
   * Capped below the client's own transport timeout, so a server that accepts the connection
   * and then goes quiet is still caught by something.
   */
  private coldStartTimeout(): number {
    const prefillMs = Math.ceil(this.approxTokens() * PREFILL_MS_PER_TOKEN)
    return Math.min(MAX_COLD_START_MS, DEFAULT_STEP_TIMEOUT_MS + prefillMs)
  }

  /**
   * How much a compaction could actually free: the messages a briefing would replace.
   *
   * Everything except the system message and the tail that would be kept verbatim — which is
   * exactly what `applyCompactionSwap` would drop.
   */
  private compactableTokens(): number {
    const messages = this.transcript.messages()
    const keepRecent = this.opts.compaction?.keepRecent ?? 6
    const tailBudget = this.opts.compaction?.contextLength === undefined
      ? 0
      : Math.floor(this.opts.compaction.contextLength * TAIL_SHARE)
    const { tail } = selectCompactionTail(messages, keepRecent, tailBudget)
    const floor = messages.length > 0 && messages[0]!.role === 'system' ? 1 : 0
    const middle = messages.slice(floor, messages.length - tail.length)
    return middle.reduce(
      (sum, m) => sum + Math.ceil(((m.content?.length ?? 0) + (m.reasoning_content?.length ?? 0)) / 4),
      0,
    )
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
  /**
   * Puts one file back to how it was before this session touched anything, and tells the
   * model.
   *
   * Telling it is the whole point, and is why this is a Session method rather than a store
   * call the host could make on its own: the transcript is what the model believes about
   * the workspace, and a file silently reverted underneath it is a belief that is now
   * wrong. The next turn would edit around changes that no longer exist.
   *
   * `note` is the user's reason, when they gave one. It rides the same message, because
   * "put it back" and "here is why" arriving separately is how the model concludes the
   * revert was a mistake and simply does it again.
   */
  async restoreFile(path: string, note?: string): Promise<{ removed: boolean }> {
    if (!this.checkpoints) throw new Error('this session is not keeping checkpoints')
    if (this.sending) throw new Error('a turn is running; stop it before reverting a file')
    // The baseline this session actually recorded, not "the oldest checkpoint still in the
    // listing". That was `(await this.checkpoints.list()).at(-1)`, and it was never the
    // session's baseline: `list()` defaults to fifty and the shadow repo is per WORKSPACE,
    // never pruned, so it returned the fiftieth-newest commit — or, in any session after the
    // first, the workspace's oldest commit, from someone else's work days ago.
    //
    // Mid-turn checkpoints turned a slow-burning wrongness into a fast one: a writing turn
    // now commits every two minutes, so a hundred-minute turn slides the whole fifty-entry
    // window on its own and "put it back" would restore a file to something the agent wrote
    // an hour into the very turn being undone. The message appended below states the
    // pre-session state as fact, so the model would then act on a description of the disk
    // that is false.
    const baseline = this.sessionBaseline
    if (!baseline) throw new Error('this session has no baseline to restore from')

    // Absolute: which folder — and which nested repository inside it — holds this file is a
    // fact about the disk, and a workspace-relative path cannot answer it.
    const result = await this.checkpoints.restoreFile(baseline.id, this.workspace.resolve(path))
    this.transcript.append({
      role: 'user',
      content:
        `The user reverted ${path} to how it was before this session started` +
        `${result.removed ? ' (it did not exist then, so it is now deleted)' : ''}. ` +
        'Whatever earlier messages say about that file no longer describes what is on disk; ' +
        're-read it before editing it again.' +
        (note !== undefined && note.trim() !== '' ? `\nThey said: ${note.trim()}` : ''),
    })
    this.persistIfPossible()
    return result
  }

  async rewind(checkpointId: string): Promise<{ restored: Checkpoint; undo: Checkpoint }> {
    if (!this.checkpoints) throw new Error('this session is not keeping checkpoints')
    if (this.sending) throw new Error('a turn is running; stop it before rewinding')
    const result = await this.checkpoints.rewind(checkpointId)
    // `undo` is a snapshot of the tree as it was a moment ago — which, on a session that has
    // not sent anything yet, IS the state it started from.
    //
    // Without this, a rewind before the first turn set `lastCheckpoint` and so made send()'s
    // "take a baseline" branch permanently false, leaving `sessionBaseline` null forever:
    // "Put back" on any file then answered "this session has no baseline to restore from"
    // for the rest of the session. Reaching it takes one click — open a workspace with
    // earlier checkpoints, restore one before typing anything — and it also catches a
    // RESUMED session that has not been sent to yet in this run.
    //
    // Only when nothing has been sent. The first version guarded on "no baseline was ever
    // recorded", and those are not the same condition: in a brand-new empty folder the
    // first turn's `take({})` had nothing to commit, so `sessionBaseline` stayed null for
    // the whole session — and this line then installed `result.undo`, a snapshot of the tree
    // as it stood at the REWIND, containing everything the agent had written. "Put back"
    // would have restored a file to the state the user had just rolled away from while the
    // transcript told the model it was the pre-session state: worse than the honest refusal
    // it replaced. The empty case is fixed where it belongs, in the store's baseline commit.
    if (this.turnNumber === 0) this.sessionBaseline ??= result.undo
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

  /**
   * Everything this session has touched: what the live transcript still shows, plus what
   * earlier swaps folded away.
   *
   * Both halves are needed. The accumulator alone misses the current stretch, and the
   * transcript alone is what produced an inventory naming 2 paths for a session that had
   * opened 38.
   */
  private allTouchedPaths(): { seen: string[]; changed: string[] } {
    const here = touchedPaths(this.transcript.messages())
    return {
      seen: [...new Set([...this.touchedSeen, ...here.seen])],
      changed: [...new Set([...this.touchedChanged, ...here.changed])],
    }
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
   * A read-only view of the conversation as it stands.
   *
   * Exists so a resumed session can be SHOWN, not only continued. The alternative was for
   * the host to re-read the session file it had just handed this object, which is both a
   * second parse of a possibly large transcript and, after a compaction swap, a different
   * answer: the file carries the marker and the messages before it, this carries what the
   * model will actually be sent next.
   */
  messages(): readonly ChatMessage[] {
    return this.transcript.messages()
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
   * The window the server actually serves, when it changes under a running session.
   *
   * The context length is not a property of this tool: it is whatever `-c` the user last
   * launched llama.cpp with, and they change it by stopping the server and starting it
   * again — which can happen at any point in a session that is already going. Everything
   * that depends on it (`compactionTrigger`, the tail budget, the summary input budget)
   * reads `opts.compaction.contextLength` at the moment it needs it rather than caching a
   * derived number, so replacing it here is enough and takes effect on the next check.
   *
   * Creating the options when they were absent is deliberate and is the valuable half: a
   * session that started while the server was still loading has compaction OFF, and this is
   * how it gets switched on once the server can finally say how big the window is, instead
   * of the user having to know to start a new session.
   */
  setContextLength(contextLength: number): void {
    if (!Number.isFinite(contextLength) || contextLength <= 0) return
    this.opts.compaction = { ...this.opts.compaction, contextLength }
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
      if (info.promptTokens !== undefined) {
        this.latestPromptTokens = info.promptTokens
        // The moment the truth was measured, in transcript characters. Everything appended
        // after this — a batched step's tool results above all — is invisible to that
        // number, and the fill check has to carry the difference itself.
        this.charsAtPromptCount = this.transcriptChars()
      }
      // Only when the server actually PROCESSED the prompt, which is what having counted its
      // tokens proves.
      //
      // `onStepDone` fires from `runStep`'s `finally`, so it also fires for a step that timed
      // out or was aborted — exactly the cases where the prefill did not finish. Clearing the
      // flag there told every later turn the cache was warm when nothing had been put in it,
      // and the session was handed the 90 s budget for a prompt needing several minutes. The
      // way in is ordinary: resume a large session and press Escape a few seconds into the
      // first step because you mistyped. Measured by an auditor: a 50k-token session given
      // 291,380 ms for its first step, aborted at 60 ms, and 9,000 ms for the next.
      if (info.promptTokens !== undefined) this.promptCacheCold = false
      if (info.completionTokens !== undefined) {
        this.cumulativeCompletionTokens += info.completionTokens
      }
      // The transcript is written HERE, per completed step, and not only at the end of the
      // turn as it was.
      //
      // A turn that ran forty steps and was then interrupted — the step ceiling, an Escape,
      // a crash — left nothing of those forty in the file. Measured on the recorded corpus:
      // 47 of 668 tool calls exist in the outcome sidecars and in no transcript line, in
      // three contiguous runs sitting exactly at turn seams. The model had SEEN those
      // results, so the turn itself was coherent; what was lost was the RECORD, and with it
      // resume, session search, and every retrospective — including the ones this project
      // has been drawing conclusions from.
      //
      // One short append against a step that takes tens of seconds. `persistIfPossible`
      // writes only what the store has not seen, so calling it repeatedly costs nothing when
      // nothing new has arrived, and the file stays append-only either way.
      this.persistIfPossible()
      host?.onStepDone?.(info)
    }
    // The work log's "Ran" line is built from what the tools ACTUALLY returned, tapped here
    // rather than reconstructed from the transcript afterwards: run_command's first result
    // line carries the real exit code, and the alternative -- trusting the model's prose
    // about whether the tests passed -- is exactly what the log exists not to do.
    const captureToolResult = (name: string, result: { ok: boolean; content: string }, callId: string): void => {
      // Whether each call WORKED, recorded here rather than in the host.
      //
      // `ToolResult.ok` never reaches the transcript — the model is given the result text and
      // nothing else — so this file beside the session is the only record of it, and it is
      // what puts a tick or a cross beside a restored tool card. It used to be written by
      // `SessionHost`, which meant only the window's own sessions had one: a `--unattended`
      // run persisted its transcript, appeared in the app's session list, and restored with a
      // green tick on every failed command of the night, because with nothing on disk
      // `assumedOk` guesses from the result text.
      //
      // Every front end reaches the model through a `Session`, and a `Session` knows its own
      // id and root, so this is the one place that covers all of them. Gated on `store`,
      // which is what makes a session something that exists on disk to be restored at all.
      if (this.opts.store) {
        recordToolOutcome(this.opts.workspaceRoot, this.id, callId, result.ok)
      }
      // Only what the log will actually use. `commandsFrom` discards every entry that is not
      // a command, at the end of the turn — so retaining the rest kept the full result text
      // of every read, search and edit alive until then, plus each call's arguments, which
      // for a write is the entire new file. With a turn capped at forty steps the array
      // could not hold more than forty entries; a turn measured in days retains everything
      // it ever did, to throw almost all of it away at the end.
      //
      // `Not run:` still has to be kept whole: `commandsFrom` reads that prefix to tell a
      // command that was refused from one that ran and failed.
      if (this.workLog && LOGGED_TOOLS.has(name)) {
        this.turnCommands.push({
          name, args: this.lastToolArgs.get(name) ?? '', content: result.content, ok: result.ok,
        })
      }
      // Only SUCCESSFUL calls count as work: a refused edit and a failed command both leave
      // the workspace exactly as it was, and counting them would make a turn that achieved
      // nothing look busy to the idle check.
      if (result.ok) {
        if (WRITE_TOOLS.has(name)) {
          this.writeCount += 1
          // Which FOLDER was written, so verify runs where the change landed instead of
          // everywhere. Read from the call's own arguments: the tool has already resolved
          // and jailed the path, and the transcript is not a place to re-derive it from.
          this.notePathWritten(this.lastToolArgs.get(name))
        } else if (COMMAND_TOOLS.has(name)) this.commandCount += 1
      }
      host?.onToolResult?.(name, result as never, callId)
    }
    const captureToolCall = (name: string, args: string): void => {
      // Recorded unconditionally now, not only for the work log: `captureToolResult` reads
      // it back to learn which folder a write landed in.
      this.lastToolArgs.set(name, args)
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
      // WAITS for a background compaction rather than killing it.
      //
      // Killing it was the old behaviour and it is exactly backwards. A compaction is only
      // ever running because the context is over the line, so the room it is making is the
      // room this very message needs: aborting it discarded the summary, ran the turn
      // against the same over-full transcript, and llama.cpp answered HTTP 400. Reported
      // from the running app — filled the context, saw "compacting", sent a message, got
      // the 400.
      //
      // The cost is that a message sent during a compaction waits for it. That is seconds,
      // it is visible (the window is already showing the compaction), and Escape still
      // works: an abort on the turn's own signal aborts the compaction too.
      await this.settleInFlightCompaction(signal)
      this.swapInCompactionIfReady()
      // Last line of defence: if the conversation still cannot fit, compact before the turn
      // rather than letting the server refuse it. A refusal here is permanent — every later
      // message hits the same wall.
      await this.compactIfOverWindow(signal)

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
        // `take` returns null when the tree is unchanged, which is the common case for a
        // workspace that already has checkpoints — and then the newest existing one
        // describes the pre-session state exactly, so it IS the baseline.
        this.lastCheckpoint = await this.checkpoints.take({})
          ?? (await this.checkpoints.list(1))[0] ?? null
        // Kept for the life of the session, unlike `lastCheckpoint`, which every mid-turn
        // and end-of-turn snapshot moves forward. `restoreFile` needs the point the session
        // STARTED from — see there.
        this.sessionBaseline = this.lastCheckpoint
      }
      // The mid-turn clock runs from the last snapshot of any kind, so a turn that starts
      // right after one does not immediately take another.
      this.lastCheckpointAtMs = Date.now()
      this.writesAtLastCheckpoint = this.writeCount
      // What the work log's diff for THIS turn is measured against. It cannot be
      // `lastCheckpoint` any more: mid-turn snapshots move that forward, so the entry would
      // describe only what happened since the last one instead of the whole turn.
      this.turnStartCheckpoint = this.lastCheckpoint

      const agent = this.buildAgent(signal)
      // Captured AFTER buildAgent() (which may append the system prompt on a fresh
      // transcript) and BEFORE runTurn(), so a length comparison after the call tells us,
      // directly, whether the user message actually reached the transcript.
      const beforeCount = this.transcript.messages().length
      // `writeCount` is cumulative across the session (the unattended idle check needs it
      // that way), so "did THIS turn change anything" is a difference, not a value.
      const writesBefore = this.writeCount
      this.writtenMounts.clear()
      let result: TurnResult
      try {
        result = await agent.runTurn(userText)
      } catch (e) {
        // The server's own refusal is the only reliable signal that the prompt did not fit:
        // every estimate this process can make is a guess, and the one it was making came in
        // low (chars/4 sees neither the 2.5k of tool schemas nor the chat template, and code
        // tokenizes denser than prose). Measured in the app: the pre-turn check passed and
        // llama.cpp still answered `request (133029 tokens) exceeds the available context
        // size (131072 tokens)`.
        const measured = contextOverflowTokens(e)
        if (measured === null) throw e
        // Ground truth, recorded before anything else: the next check has a real number
        // instead of an estimate.
        this.latestPromptTokens = measured
        await this.compactNow(signal)
        // A continuation, not the same message again: `runTurn` already appended the user's
        // text before the request failed, so it is sitting in the compacted tail. Re-sending
        // it verbatim would put the request in the transcript twice.
        try {
          result = await this.buildAgent(signal).runTurn(OVERFLOW_RETRY_NOTE)
        } catch (retryError) {
          const still = contextOverflowTokens(retryError)
          if (still === null) throw retryError
          // The retry met the same refusal, which means compaction could not make room —
          // the protected tail alone is bigger than the window. That state is normally
          // unreachable now (the loop's per-step result budget bounds what one step can
          // append), but a session recorded before the budget existed can still resume
          // into it, and the raw HTTP error it used to escape with sent an unattended run
          // chasing a server that was answering fine. Named for what it is instead.
          throw new Error(
            `the conversation's most recent messages alone are ${still} tokens against a ` +
            `${this.opts.compaction?.contextLength ?? 'smaller'}-token window, so compaction cannot make room. ` +
            'Start a new session; this tail cannot be replayed.',
          )
        }
      }
      result = await this.verifyAndFix(result, this.writeCount - writesBefore, signal)

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
   * A point to come back to from INSIDE a long turn.
   *
   * `recordTurn` snapshots once, after the turn ends. While a turn was at most forty steps
   * that was never more than a few minutes of work; with the ceiling gone a turn can run for
   * hours, and one checkpoint across all of it is not an undo — it is a single "throw the
   * whole thing away". This is the regression that removing the ceiling introduced, and it
   * would only ever have been noticed by someone who needed to rewind.
   *
   * Two conditions, and both matter. Something must have been WRITTEN since the last
   * snapshot — `take` returns null for an unchanged tree anyway, but asking git costs a
   * process, and most steps in a long turn read. And enough time must have passed, because
   * the cost is a real commit over the whole work tree (measured in this repo's own
   * checkpoint tests: hundreds of milliseconds to a few seconds), which is worth paying
   * every few minutes and not every few seconds.
   *
   * Never throws, for `recordTurn`'s reason: a failed snapshot must not take the turn down
   * with it.
   */
  /**
   * Run the project's own check DURING a long turn, not only when it ends.
   *
   * Measured across fifteen real sessions: a turn runs thirty-odd steps, and the check that
   * would have caught a mistake made at step four ran after step thirty. By then the model
   * has to reconstruct twenty-six steps of intent to understand the failure — and the
   * context that would have explained it is the context compaction just replaced.
   *
   * Runs at every write boundary, and SAYS SO WHEN IT PASSES. Both were the other way round,
   * and the corpus says both were wrong.
   *
   * The gate was five writes AND four minutes, on the reasoning that a real build is
   * expensive. Measured against what the model actually does: 95 of 621 recorded tool calls
   * — 15% of everything it did — were the model running `dotnet build` or `dotnet test` on
   * itself, and the median number of its own writes between those checks is ONE. The gate
   * fired strictly less often than the model already checked, so it could never displace the
   * habit it was built to make unnecessary. A warm incremental build on the user's project
   * measures 1.07 s against a step that averages 26 s.
   *
   * And the silence was the load-bearing part. The old comment argued that "a passing check
   * that announced itself would spend context to say nothing happened" — but a model with no
   * channel telling it the build is green has exactly one way to find out, and it spends a
   * whole step on it. Six tokens of `(build ok, 1.1s)` is the cheapest possible answer to a
   * question it was going to ask anyway.
   *
   * Three things keep it from becoming noise. An unchanged failure is reported as unchanged
   * rather than repeated, so the middle of a twelve-write refactor — legitimately red — costs
   * a line rather than the whole error list each time. A check that turns out to be slow
   * backs itself off and says once that it has. And it still reports rather than intervenes:
   * the end-of-turn `verifyAndFix` keeps its fix rounds, because interrupting a plan halfway
   * to demand a fix is how a model loses the thread it was holding.
   *
   * Never throws — a check that cannot run must not take the turn down.
   */
  private async verifyMidTurn(signal?: AbortSignal): Promise<void> {
    if (this.writeCount === this.writesAtLastVerify) return

    // Not after every write — after a RUN of writes ends.
    //
    // A change worth making often spans several files, and between the first edit and the
    // last the project does not compile because the work is half done, not because anything
    // is wrong. Renaming an interface breaks every file that mentions it until the final one
    // is saved. Showing the model that list of errors on the second edit of six invites it to
    // "fix" work that is simply unfinished, which is worse than not checking at all.
    //
    // The boundary that means something is the model doing something ELSE: a read, a command,
    // an answer. A step that wrote is a step still in the middle of the change; the first step
    // that does not is the moment the change is as done as it is going to get. This costs at
    // most one step of delay against checking eagerly, and buys not interrupting a multi-file
    // edit halfway through.
    //
    // The cap is the other half. A rename touching twenty files would otherwise go unchecked
    // for twenty steps, and the whole point is catching a mistake near where it was made.
    const writesInLastStep = this.writeCount - this.writeCountAtStepStart
    this.writeCountAtStepStart = this.writeCount
    const pending = this.writeCount - this.writesAtLastVerify
    if (writesInLastStep > 0 && pending < VERIFY_BURST_CAP) return
    // The back-off, and the only remaining time gate. A project whose check takes half a
    // minute cannot afford one per write, and the honest way to discover that is to have
    // measured it rather than to have guessed a constant.
    if (this.verifySlow && Date.now() - this.lastVerifyAtMs < MID_TURN_VERIFY_MS) return
    const jobs = this.verifyJobs()
    if (jobs.length === 0) return
    this.writesAtLastVerify = this.writeCount
    this.lastVerifyAtMs = Date.now()

    try {
      for (const job of jobs) {
        if (signal?.aborted) return
        const startedAt = Date.now()
        const outcome = await runVerify(job.spec, job.root, signal)
        const seconds = (Date.now() - startedAt) / 1000
        if (seconds > SLOW_VERIFY_SECONDS && !this.verifySlow) {
          this.verifySlow = true
          this.transcript.append({
            role: 'user',
            content:
              `[The check "${job.spec.command}" took ${seconds.toFixed(0)}s, so it will no ` +
              'longer run after every edit — at most once every few minutes. Run it yourself ' +
              'when you want to know sooner.]',
          })
        }
        this.opts.onVerify?.({
          command: job.spec.command,
          ok: outcome.ok,
          // 1, not 0: this check has exactly one attempt and never retries, and every other
          // emission counts from 1. A sentinel here would mean something different from the
          // same field everywhere else for no gain — the app only distinguishes `> 1`.
          attempt: 1,
          ...(this.workspace.multi ? { folder: job.folder } : {}),
          ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}),
          ...(outcome.problem !== undefined ? { problem: outcome.problem } : {}),
        })
        const where = this.workspace.multi ? `In the "${job.folder}" folder: ` : ''
        if (outcome.ok) {
          // The six tokens that are the whole point. Said only when the state CHANGED —
          // repeating "still fine" after every one of forty edits is the noise the old
          // silence was trying to avoid, and this keeps the answer without it.
          if (this.lastVerifyFingerprint !== 'ok') {
            this.lastVerifyFingerprint = 'ok'
            this.transcript.append({
              role: 'user',
              content: `[${where}${job.spec.command}: ok, ${seconds.toFixed(1)}s]`,
            })
          }
          continue
        }
        // A command that cannot START is a configuration problem, and telling the model its
        // change broke the build would send it rewriting working code.
        if (outcome.problem !== undefined) continue

        // Failing the same way as last time is not news. The middle of a refactor is
        // legitimately red for a dozen edits, and re-reading the same errors twelve times
        // costs more context than the errors are worth.
        const fingerprint = `fail:${job.folder ?? ''}:${outcome.output.slice(0, 800)}`
        if (fingerprint === this.lastVerifyFingerprint) {
          this.transcript.append({
            role: 'user',
            content: `[${where}${job.spec.command}: still failing, same errors as before.]`,
          })
          return
        }
        this.lastVerifyFingerprint = fingerprint
        this.transcript.append({
          role: 'user',
          content:
            `[Checked while you work — ${where}${verifyFailureMessage(job.spec, outcome)}\n\n` +
            'This ran automatically after your recent edits, so the cause is probably in ' +
            'them and is still fresh. Fix it now if it is yours; if it was already broken ' +
            'before this turn, say so and carry on.]',
        })
        return
      }
    } catch { /* see the doc comment */ }
  }

  /**
   * Tell the model how much of its window is gone, once per threshold it crosses.
   *
   * It is the only actor that can do anything about it — write a durable note, close out a
   * sub-task, stop opening a twentieth file — and until now it had no way to know. The
   * status bar has shown this to the USER since the beginning; the model was the one party
   * in the room working blind.
   *
   * Once per threshold, never repeated, so a long turn spends at most three lines on this.
   * Appended rather than put in the system message for the obvious reason: message 0 is
   * frozen, and a number in it would be a lie within one step.
   *
   * Deliberately says what to DO. "You are at 75%" is a fact the model cannot act on; the
   * two actions that actually preserve work across the compaction it is warning about are
   * recording what was learned and bringing the plan up to date.
   */
  private noteContextFill(): void {
    const contextLength = this.opts.compaction?.contextLength
    if (contextLength === undefined || contextLength <= 0) return
    const ratio = this.fillRatio(contextLength)
    if (ratio === null) return
    const crossed = CONTEXT_FILL_MARKS.filter((m) => ratio >= m && !this.fillMarksSeen.has(m))
    const mark = crossed[crossed.length - 1]
    if (mark === undefined) return
    for (const m of crossed) this.fillMarksSeen.add(m)
    this.transcript.append({
      role: 'user',
      content:
        `[Context is about ${Math.round(mark * 100)}% full. When it fills, the earlier part ` +
        'of this conversation is replaced by a summary — anything not written down is lost. ' +
        'Now is the moment to record what you have worked out with `remember`, and to bring ' +
        '`todo_write` up to date so the plan survives. Then carry on.]',
    })
  }

  private async checkpointLongTurn(step: number): Promise<void> {
    if (!this.checkpoints) return
    if (this.writeCount === this.writesAtLastCheckpoint) return
    const now = Date.now()
    if (now - this.lastCheckpointAtMs < (this.opts.checkpointIntervalMs ?? MID_TURN_CHECKPOINT_MS)) return
    try {
      const previous = this.lastCheckpoint
      const taken = await this.checkpoints.take({ sessionId: this.id, turn: this.turnNumber, step })
      // Recorded even when nothing was committed: the tree was unchanged after all, and
      // re-asking git on the very next step would spend the same process to learn the same
      // thing.
      this.writesAtLastCheckpoint = this.writeCount
      this.lastCheckpointAtMs = now
      if (taken) {
        // A line in the log for every snapshot, so a night that was one turn reads as a
        // timeline instead of a single entry written when it finally ended.
        if (this.workLog && previous) {
          const diff = await this.checkpoints.diffStat(previous.id, taken.id)
          this.workLog.appendProgress(new Date(), this.turnNumber, step, taken.id, diff)
        }
        this.lastCheckpoint = taken
      }
    } catch {
      // See the doc comment.
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
      // The state this turn STARTED from, not the newest snapshot: a long turn takes its own
      // checkpoints as it goes, and diffing against the last of those would report the tail
      // of the turn as though it were the whole of it.
      const previous = this.turnStartCheckpoint ?? this.lastCheckpoint
      const taken = await this.checkpoints.take({ sessionId: this.id, turn: this.turnNumber })
      if (taken) this.lastCheckpoint = taken
      this.lastCheckpointAtMs = Date.now()
      this.writesAtLastCheckpoint = this.writeCount

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
      await this.compactNow(signal)
    } finally {
      this.sending = false
    }
  }

  /**
   * One compaction cycle, right now, without the single-slot guard.
   *
   * Extracted from `forceCompact` so `send()` can use it too: a transcript that ALREADY
   * cannot fit has to be compacted before the turn, and `forceCompact` refuses while a send
   * is in progress — which, from inside `send()`, is always.
   */
  private async compactNow(signal?: AbortSignal): Promise<void> {
    {
      await this.abortInFlightCompaction()
      this.pendingSummary = undefined

      // Asked BEFORE the model is: can this possibly help?
      //
      // A swap replaces the middle of the conversation with a briefing and keeps the recent
      // tail. So it can only free space if the middle is bigger than the briefing that
      // replaces it — and on a short session it is not. Running anyway spent a full
      // generation to discover nothing and then reported "made no difference", which reads
      // as a failure rather than as "you do not need this yet".
      const middle = this.compactableTokens()
      if (middle < MIN_COMPACTABLE_TOKENS) {
        // The same two lines the no-progress guard below already had, and their absence here
        // cost a full summary generation every time. The trigger reads `latestPromptTokens`;
        // declining to compact left that number exactly as it was, so the very next check saw
        // the same fill ratio and fired again — and the background path has no
        // MIN_COMPACTABLE_TOKENS guard of its own, so it went all the way to generating a
        // summary of a transcript this branch had just decided was not worth compacting.
        this.latestPromptTokens = null
        this.skipNextTrigger = true
        this.opts.onCompaction?.({ state: 'postponed', reason: 'nothing-to-gain' })
        return
      }

      this.opts.onCompaction?.({ state: 'started' })
      // Set BEFORE the request, not after it succeeds: the cache is displaced by the prefill,
      // which happens whatever the generation goes on to do. See `beforeStep`.
      this.compactionDisplacedCache = true
      try {
        const result = await generateCompaction(
          this.opts.client,
          {
            messages: this.transcript.messages(),
            workspaceRoot: this.opts.workspaceRoot,
            budgetTokens: this.summaryBudget(),
          },
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
    }
  }

  /**
   * Compacts BEFORE the turn when the conversation already cannot fit in the window.
   *
   * The 80% background trigger handles the ordinary case; this is the backstop for a session
   * that got past it — one long turn that jumped the threshold in a single step, or one
   * resumed from disk. Reported from the running app: continuing such a session answered
   * every message with `request (133029 tokens) exceeds the available context size (131072
   * tokens)`, permanently.
   *
   * Uses the server's own last count when this process has one and the transcript's estimate
   * otherwise — a resumed session has no count, and that is exactly the case that was stuck.
   */
  private async compactIfOverWindow(signal?: AbortSignal): Promise<void> {
    const contextLength = this.opts.compaction?.contextLength
    if (contextLength === undefined || contextLength <= 0) return
    // This check weighs an estimate against the window using two FIXED costs — the tool
    // schemas that go with every request, and the headroom a turn needs. Below a window
    // several times their combined size those costs dominate and the comparison says
    // nothing but "compact", which is how a flat allowance came to fire on every send and
    // hang the host suite. Twice. The retry on the server's own refusal is the safety net
    // that works at any window size, so skipping here costs nothing.
    if (contextLength < (TOOL_SCHEMA_TOKENS + PRE_TURN_HEADROOM) * 4) return
    // The estimate has to carry what it cannot see, or it reads low exactly when it matters
    // most. That is true of BOTH branches now: the server count is ground truth for the
    // moment it was measured, and everything appended since — a batched step's results
    // above all — is exactly what it cannot see. Watched at the real window: one step
    // appended ~198k tokens, the check compared 3,552 against 131,072 and passed, and the
    // server refused the next request at 201,584.
    const appendedSince = Math.max(0, this.transcriptChars() - this.charsAtPromptCount)
    const used = this.latestPromptTokens !== null
      ? this.latestPromptTokens + Math.ceil(appendedSince / 4)
      : this.approxTokens() + TOOL_SCHEMA_TOKENS
    if (used + PRE_TURN_HEADROOM < contextLength) return
    await this.compactNow(signal)
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
   * Lets a background compaction finish, so its summary is there to swap in.
   *
   * Distinct from `abortInFlightCompaction`, which `forceCompact` still wants: that path
   * regenerates from the current transcript and a half-finished older attempt is worth
   * nothing to it. `send()` wants the opposite — whatever room is being made, it needs.
   *
   * The caller's signal still cuts it short, so Escape during "compacting…" stops the wait
   * AND the compaction, rather than leaving someone watching a spinner they cannot cancel.
   */
  private async settleInFlightCompaction(signal?: AbortSignal): Promise<void> {
    const inFlight = this.compactionInFlight
    if (!inFlight) return
    if (signal?.aborted) {
      inFlight.controller.abort()
      await inFlight.promise
      return
    }
    const onAbort = (): void => inFlight.controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await inFlight.promise
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
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
    // The kept tail is capped by SIZE as well as by count. Six messages carrying whole
    // files left 111.7k of a 131.1k window in place — a compaction that bought one turn.
    const tailBudget = this.opts.compaction?.contextLength === undefined
      ? 0
      : Math.floor(this.opts.compaction.contextLength * TAIL_SHARE)
    const { tail, droppedMessages } = selectCompactionTail(
      this.transcript.messages(), keepRecent, tailBudget,
    )

    // Everything the model was shown is gone with the transcript it was shown in. Keeping
    // the read memory across a swap would make "unchanged since you read it" true and
    // useless — the text it refers to no longer exists in the context — and would make a
    // diff a fragment of something the model can no longer see. This one line is the
    // correctness condition for the whole cheap-repeat-read idea.
    this.opts.toolset.reads?.clear()

    // BEFORE the system message is built, because that is what consumes it: re-order the
    // repository map around what this session turned out to be about. Guarded for the same
    // reason the inventory below is — an enrichment must not be able to cost the swap. A
    // failure leaves the map exactly as it was, which is the map that worked until now.
    try {
      const rerank = this.opts.rerankRepoMap
      if (rerank !== undefined) {
        const { seen, changed } = this.allTouchedPaths()
        // Changed first: a file the session edited is more its subject than one it read once.
        const focus = [...changed, ...seen]
        if (focus.length > 0) {
          const focused = rerank(focus)
          if (focused !== '') this.repoMapText = focused
        }
      }
    } catch { /* the previous map stands */ }

    // Fold what is about to be dropped into the accumulator BEFORE the transcript is
    // replaced. This is the last moment the outgoing messages exist.
    const outgoing = touchedPaths(this.transcript.messages())
    for (const p of outgoing.seen) this.touchedSeen.add(p)
    for (const p of outgoing.changed) this.touchedChanged.add(p)

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
        ...(this.notesText !== undefined ? { notes: this.notesText } : {}),
        ...(this.skillsText !== undefined ? { skills: this.skillsText } : {}),
        ...(this.repoMapText !== undefined ? { repoMap: this.repoMapText } : {}),
        ...(this.schemaText !== undefined ? { databaseSchema: this.schemaText } : {}),
        ...(this.workspace.multi
          ? { folders: this.workspace.mounts.map((m) => ({ name: m.name, access: m.access })) }
          : {}),
      }),
    })
    // The generated briefing, then the facts it is not allowed to get wrong. Computed from
    // the transcript being replaced and the live todo store, so "which files have I opened"
    // and "what is still open" survive a swap as data rather than as something the model
    // remembered to write down.
    //
    // Guarded, and the guard is the point rather than defensiveness for its own sake: this
    // is an ENRICHMENT of a briefing that already works, and it must never be able to cost
    // the session the briefing itself. A throw here would surface as a failed compaction —
    // trading the whole summary for a list of file paths. Caught while writing it, by a
    // caller whose toolset carries no todo store at all.
    let inventory = ''
    try {
      inventory = continuationInventory(
        this.transcript.messages(), this.opts.toolset.todos?.list() ?? [], this.allTouchedPaths(),
        // The root, so the briefing can carry the CONTENTS of the files this session changed
        // and not only their names. Measured on the longest recorded session: 9 of the 10
        // reads within eight steps of a swap were re-reads of paths the inventory had just
        // listed — the model being told what it had worked on and then having to go and look
        // at it again.
        this.workspace.root)
    } catch { /* the summary is what matters; the list is a bonus */ }
    next.append({
      role: 'user',
      content: `${COMPACTION_BRIEFING_PREFIX}\n${summary}${inventory === '' ? '' : `\n\n${inventory}`}`,
    })
    // The acknowledgement closes the briefing's round-trip -- unless the tail already opens
    // on an assistant message, which it can now do when a compaction lands mid-turn. Keeping
    // it there too would put two assistant messages back to back, and the natural shape is
    // the one a real conversation has: the briefing is read, and the model acts.
    if (tail[0]?.role !== 'assistant') {
      next.append({ role: 'assistant', content: COMPACTION_ACK_TEXT })
    }
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
      // FLUSH FIRST. The `.jsonl` is documented as the full audit trail, never trimmed, and
      // until compaction could run mid-turn that was true: a turn's messages were written
      // when it ended, and the only compaction that ever ran happened between turns, with
      // nothing unwritten.
      //
      // Between the steps of a turn that is still running, everything since `persistedCount`
      // is in memory and nowhere else. The swap below advances that cursor past all of it,
      // so without this line every mid-turn compaction silently and permanently deletes the
      // work of the stretch it summarises — for a 131k window, on the order of 97k tokens of
      // reasoning, tool calls and results per swap. The resumed conversation would not
      // notice (load() slices at the last marker either way), which is exactly why this
      // could have gone unseen: what is destroyed is the record. Session search reads the
      // whole file, history included, so text produced during a long turn would simply stop
      // being findable, forever.
      //
      // Two writes rather than one, and the order is the safety argument: if the process
      // dies between them the file holds the messages and no marker, so `load()` rebuilds
      // the FULL pre-swap transcript. Nothing is lost either way; the swap is simply not
      // applied yet.
      const pending = this.transcript.messages().slice(this.persistedCount)
      if (pending.length > 0) {
        store.appendMessages(this.id, pending)
        // The cursor moves with the WRITE, not with the swap. Leaving it until after
        // `appendCompactionSwap` meant that any failure of the second write — a full disk, a
        // virus scanner holding the file for a moment on Windows — left the cursor pointing
        // at messages already on disk. `compactNow` swallows that failure and the turn
        // carries on, so `send()`'s own tail write then appended every one of them a second
        // time: the request duplicated, tool_call ids answered twice, and a `system` message
        // landing in the middle of the conversation. Measured by an auditor injecting one
        // throw: 15 lines holding the turn twice.
        //
        // Worse, it was not confined to the failure. The NEXT swap's flush read the same
        // stale cursor, so even the self-healing path re-wrote the whole pre-swap history.
        // A file documented as an append-only audit trail is worth exactly what its worst
        // path leaves in it.
        this.persistedCount = this.transcript.messages().length
      }
      store.appendCompactionSwap(this.id, { summary, droppedMessages }, next.messages())
    }

    this.transcript = next
    this.persistedCount = next.messages().length
    // The swap rewrote the prefix: nothing the server cached still matches, and the next
    // request pays a full prefill.
    this.promptCacheCold = true
    // fillRatio must wait for a real measurement against the NEW transcript -- the stale
    // pre-swap prompt-token count would otherwise immediately look "still over threshold"
    // against the just-shrunk transcript and re-trigger a pointless compaction of the
    // transcript this very call just produced.
    this.latestPromptTokens = null
    this.opts.onCompaction?.({
      state: 'applied',
      droppedMessages,
      detail: {
        beforeTokens: oldApproxTokens,
        afterTokens: next.approxTokens(),
        summary,
        keptMessages: tail.length,
      },
    })
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
    // The automatic trigger is the most common compaction of all and it never set this,
    // which left the widest version of the same gap: its request displaces the server's
    // cache exactly like any other, and if the generation is aborted or fails, the next
    // step gets a warm-cache budget for a prompt that has to be prefilled from nothing.
    this.compactionDisplacedCache = true
    try {
      const result = await generateCompaction(
        this.opts.client,
        { messages, workspaceRoot: this.opts.workspaceRoot, budgetTokens: this.summaryBudget() },
        signal,
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
  private readonly checkpoints: CheckpointSet | null
  private readonly workLog: WorkLog | null
  /** Present for any long run; see `SessionOptions.longRun`. */
  private readonly decisions: DecisionQueue | null
  /** Whether unanswered requests currently park. Toggled by `setUnattended` when a run
   * starts and stops, so the same session can be driven both ways. */
  private unattendedActive: boolean
  /** The checkpoint the last turn ended on, so the next one can diff against it. */
  private lastCheckpoint: Checkpoint | null = null
  /** `writeCount` as it stood at the last snapshot, and when that was — the two halves of
   * "is there anything new to snapshot, and is it time". See `checkpointLongTurn`. */
  private writesAtLastCheckpoint = 0
  private writesAtLastVerify = 0
  /** Writes seen when the previous step began, so a run of consecutive editing steps can be
   * told from a step that moved on to something else. See `verifyMidTurn`. */
  private writeCountAtStepStart = 0
  /** What the last mid-turn check said, so an unchanged answer is reported as unchanged
   * rather than repeated in full. 'ok' or a clipped failure fingerprint. */
  private lastVerifyFingerprint: string | null = null
  /** Set the first time a check is measured slow; from then on it is time-gated again. */
  private verifySlow = false
  private lastVerifyAtMs = 0
  /** Fill marks already announced, so each is said once per session and never again. */
  private readonly fillMarksSeen = new Set<number>()
  private lastCheckpointAtMs = 0
  /** Where the current turn began, for the work log's own diff. See `recordTurn`. */
  private turnStartCheckpoint: Checkpoint | null = null
  /** Where this SESSION began — the one point "put it back" means. Set once, on the first
   * turn, and never moved. See `restoreFile`. */
  private sessionBaseline: Checkpoint | null = null
  /** Whether a summary generation went out since `beforeStep` last looked. Its prefill is
   * what evicts the server's cache, so it is owed a cold budget whether or not the swap it
   * was for ever landed. See `beforeStep`. */
  private compactionDisplacedCache = false
  /** 1-based, counted by this session rather than read off the transcript: a compaction
   * swap changes the message count and must not renumber the log. */
  private turnNumber = 0
  /** Filled by the event tap during a turn, read and cleared when it ends. */
  private turnCommands: { name: string; args: string; content: string; ok: boolean }[] = []
  /**
   * `onToolCall` carries the arguments and `onToolResult` does not, so the last call's
   * arguments are held here to be paired with its result.
   *
   * A single slot per tool NAME is exact for as long as no second call of the same name is
   * announced before the first one's result. That used to be guaranteed by one tool running
   * per step; it is now guaranteed by the loop running a step's calls strictly in sequence —
   * announce, run, answer, next — which is asserted in `loop.test.ts` rather than left as a
   * property nobody checks. A concurrent version of that loop would silently hand one write's
   * path to another write's result, and with it the folder `verify` runs in.
   */
  private readonly lastToolArgs = new Map<string, string>()
  /** Cumulative across the session; see `turnFootprint`. */
  private writeCount = 0
  /** Folders written to in the CURRENT turn, cleared at the start of each one. Verify
   * runs where the change landed, not everywhere. */
  private writtenMounts = new Set<string>()
  /**
   * Whether the next request's prompt is one llama.cpp has NOT already processed.
   *
   * True at construction (a resumed session's transcript has never been sent by this process)
   * and again after every compaction swap (the swap rewrites the prefix, so the server's
   * longest-common-prefix cache match is worthless). Cleared by the first completed step,
   * which is the proof the prompt is now warm.
   *
   * It exists because of a measured failure: a session compacted successfully and its very
   * next step died on the 90 s step timeout — a budget sized for GENERATION against a warm
   * cache, spent entirely on prefill before a token was produced.
   */
  private promptCacheCold = true
  /** Transcript size when `latestPromptTokens` was recorded; see `compactIfOverWindow`. */
  private charsAtPromptCount = 0
  private commandCount = 0

  /** The transcript's current weight in characters, message content plus reasoning. */
  private transcriptChars(): number {
    return this.transcript.messages().reduce(
      (n, m) => n + (m.content?.length ?? 0) + (m.reasoning_content?.length ?? 0), 0)
  }

  /**
   * The port the agent and the tools consult, wrapped for an unattended run.
   *
   * Built per turn rather than cached because it closes over the session id and the queue,
   * and because `queueingPort` is pure construction — a few closures — so there is nothing
   * to save by holding one.
   */
  private interactionPort(): InteractionPort | undefined {
    if (!this.decisions || !this.unattendedActive) return this.opts.interaction
    return queueingPort(this.opts.interaction, {
      queue: this.decisions,
      sessionId: this.id,
      ...(this.opts.unattended?.approvalTimeoutMs !== undefined
        ? { approvalTimeoutMs: this.opts.unattended.approvalTimeoutMs } : {}),
    })
  }

  private buildAgent(signal?: AbortSignal): Agent {
    const context: ToolContext = {
      workspace: this.workspace,
      todos: this.opts.toolset.todos,
      // The toolset owns it, so it survives a session switch: closing a page the user is
      // looking at because they clicked Resume would be its own small betrayal.
      browser: this.opts.toolset.browser,
      reads: this.opts.toolset.reads,
    }
    // Built once per Session, so the circuit breaker inside it counts failures across the
    // whole session rather than resetting every turn.
    if (this.formatRunner) context.format = this.formatRunner
    // The connection string, not a connection: the helper opens one on first use, so a
    // workspace whose server is asleep still starts a session and only pays when asked.
    if (this.opts.database) context.database = this.opts.database
    // The LIST, not the catalogue text: `use_skill` resolves a name to a folder and reads
    // the body from disk itself.
    if (this.opts.skills && this.opts.skills.skills.length > 0) context.skills = this.opts.skills
    // The queueing wrapper, when this is an unattended run. Both the tool context (which
    // `ask_user` reads) and the agent's own gate get the SAME port: a question that parks in
    // one place and blocks in the other would stall the run on whichever path came first.
    const port = this.interactionPort()
    if (port) context.interaction = port

    const agentOpts: AgentOptions = {
      client: this.opts.client,
      registry: this.opts.toolset.registry,
      context,
      transcript: this.transcript,
      loopDetector: this.loopDetector,
    }
    if (this.memoryText !== undefined) agentOpts.memory = this.memoryText
    if (this.notesText !== undefined) agentOpts.notes = this.notesText
    if (this.skillsText !== undefined) agentOpts.skills = this.skillsText
    // One step may append at most the tail allowance. The two constants are the same
    // number on purpose: a batched step is atomic to the tail selector (one assistant
    // message and its N replies cannot be split without invalidating the transcript), so
    // as long as a step fits the tail budget, compaction can always work AROUND it — and
    // the moment one may exceed it, a step can bury the whole window and no compaction
    // can dig it out. Watched happen at 131,072: twelve batched reads, HTTP 400.
    if (this.opts.compaction !== undefined) {
      agentOpts.stepResultBudgetChars = Math.floor(this.opts.compaction.contextLength * TAIL_SHARE * 4)
    }
    if (this.repoMapText !== undefined) agentOpts.repoMap = this.repoMapText
    if (this.schemaText !== undefined) agentOpts.databaseSchema = this.schemaText
    if (this.opts.engine) {
      // mode intentionally omitted here -- see the constructor's invariant note. Agent
      // resolves opts.permissions.mode instead, which is always meta.mode by now.
      agentOpts.permissions = this.opts.engine
    } else {
      agentOpts.mode = this.meta.mode
    }
    if (port) agentOpts.interaction = port
    if (this.hookRunner) agentOpts.hooks = this.hookRunner
    // Always composed, even when no host events were supplied: Session must keep tapping
    // onStepDone for contextUsage()/fillRatio() on every turn, host renderer or not (a
    // one-shot CLI call, or a test, may never pass `events` at all).
    agentOpts.events = this.composeEvents(this.opts.events)
    if (this.opts.maxSteps !== undefined) agentOpts.maxSteps = this.opts.maxSteps
    // A turn that fills the window now makes room and carries on, instead of running until
    // the server refuses the request.
    //
    // The pre-turn check is the same one, and it was the ONLY one: a turn long enough to
    // fill the context by itself could not compact, because compaction replaces the
    // transcript object and a running Agent held a reference to the old one. The exception
    // path caught the refusal afterwards and restarted the whole turn -- one wasted prefill,
    // one wasted request, and only ever once.
    //
    // The cold budget is owed whenever a summary GENERATION ran, not only when the swap
    // landed — and those are different events.
    //
    // The first version compared object identity and gave the next step a cold budget only
    // if the transcript had been replaced, reasoning that a postponed or failed compaction
    // changed nothing. It changed nothing about the transcript and everything about the
    // server. `summaryBudget()` is capped at SUMMARY_MAX_INPUT_TOKENS, so on the large
    // session where mid-turn compaction actually fires, `fitForSummary` always drops the
    // middle — the request that goes out has a DIFFERENT prefix from the conversation, and
    // prefilling it evicts what the cache held. A compaction that then failed left the next
    // step re-prefilling the whole conversation against the 90 s warm-cache deadline, which
    // it cannot make: at the 2.54 ms/token this file's own PREFILL_MS_PER_TOKEN records,
    // 125k tokens is over five minutes. The step would time out, and the turn would end
    // reporting a timeout, having been broken by the thing sent to rescue it.
    agentOpts.beforeStep = async (step): Promise<StepPreamble | undefined> => {
      await this.checkpointLongTurn(step)
      await this.verifyMidTurn(signal)
      this.noteContextFill()
      const before = this.transcript
      await this.compactIfOverWindow(signal)
      const swapped = this.transcript !== before
      // CONSUMED here, not cleared on the way in. The first version zeroed the flag three
      // lines above this read, so the only writes it could ever observe were the ones made
      // by the `compactIfOverWindow` on the line between — which is to say, only compactions
      // that happen inside this hook. A `/compact`, a pre-turn compaction, and the automatic
      // 80% trigger all set it and all had it wiped before anything looked, so the case the
      // flag exists for was still reachable through every path except the one it covered.
      const displaced = this.compactionDisplacedCache
      this.compactionDisplacedCache = false
      if (!swapped && !displaced) return undefined
      return { transcript: this.transcript, timeoutMs: this.coldStartTimeout() }
    }
    // The first step of a turn whose prompt prefix the server has not seen must be allowed
    // to PREFILL before it generates. See `promptCacheCold`.
    if (this.promptCacheCold) agentOpts.firstStepTimeoutMs = this.coldStartTimeout()
    if (signal) agentOpts.signal = signal

    return new Agent(agentOpts)
  }
}
