import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import {
  Agent, DEFAULT_STEP_TIMEOUT_MS, MAX_COLD_START_MS, PREFILL_MS_PER_TOKEN,
  type AgentEvents, type AgentOptions, type StepInfo, type StepPreamble, type TurnResult,
} from '../agent/loop.js'
import { buildSystemPrompt } from '../agent/prompt.js'
import { ROLES, ROLE_NAMES, runSubAgent, type SubAgentOutcome } from '../agent/subagent.js'
import type { Checkpoint } from '../checkpoints/store.js'
import { CheckpointSet } from '../checkpoints/set.js'
import { soleUnit, type SnapshotUnit } from '../checkpoints/units.js'
import { commandsFrom, WorkLog } from './worklog.js'
import { recordToolOutcome } from '../host/replay.js'
import { DecisionQueue, PARKED_ANSWER, queueingPort } from './decisions.js'
import { ReadMemory } from '../tools/read-memory.js'
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
import type { ChatMessage, StreamProgress } from '../llama/types.js'
import {
  BROWSER_TOOL, MCP_TOOL_PREFIX, type AgentMode, type PermissionEngine,
} from '../permissions/engine.js'
import type { Toolset } from '../tools/default-set.js'
import type { ToolContext } from '../tools/types.js'
import { attachmentUserText } from './attachment-text.js'
import { REVERT_FILE_PREFIX, ROLLBACK_PREFIX } from './checkpoint-notices.js'
import { Transcript, transcriptChars } from '../transcript/transcript.js'
import { Workspace } from '../workspace.js'
import {
  COMPACTION_ACK_TEXT, COMPACTION_BRIEFING_PREFIX, approxTokensOf, collapseSupersededReads,
  continuationInventory, generateCompaction, selectCompactionTail, touchedPaths,
  OVERFLOW_RETRY_NOTE,
} from './compaction.js'
import {
  DIFF_REVIEW_MIN_CHARS, acceptanceFailureMessage, checkAcceptance, clipTodoText,
  decomposeTodos, distillContract,
  expandDraft, improveDraft, looksLikeTask, renderCheckedState, renderContract, suggestReply,
  resolveReportedCriteria, withUnreportedCriteria, UNREPORTED_REASON,
  buildReviewBrief, reviewVerdict, REVIEW_SYSTEM,
} from './contract.js'
import {
  buildQuestion, contestedBeyondContract, foldAnswerWithModel, readThroughLenses,
  type Understanding,
} from './understanding.js'
import {
  premiseFailureMessage, statePremises, verifyPremises, type Premise,
} from './premises.js'
import {
  reviewFailureMessage, type AcceptanceReport, type DraftSuggestions, type TaskContract,
  type ReviewIssue, saysFinished,
} from './contract.js'
import { SessionStore, type CompactionMarker, type SessionMeta } from './store.js'

/** Task 9: background auto-compaction. Omitting this entirely from `SessionOptions`
 * turns the feature off completely -- no trigger check ever runs, no background
 * generation is ever started, however full the context gets. */
export interface CompactionOptions {
  /** The model's context window, in tokens -- the denominator `fillRatio` divides by. */
  contextLength: number
  /** Fraction of `contextLength` that trips the background trigger. Default 0.8. */
  triggerRatio?: number
  /**
   * ABSOLUTE token count that trips the background trigger, whichever of the two fires
   * first. The ratio scales with the window, and at 262k that means compacting near 210k
   * — several multiples past where every published long-context measurement (including
   * the Qwen family) shows accuracy already collapsed. This is the knob the context-rot
   * probe (`spike/context-rot-probe.mjs`) exists to calibrate: measure the knee, set this
   * to it via settings.json `"compaction": { "triggerTokens": N }`. Absent = ratio only,
   * yesterday's behaviour.
   */
  triggerTokens?: number
  /** How many of the old transcript's trailing messages a swap keeps verbatim (subject
   * to the clean-boundary walk -- see `selectCompactionTail`). Default 6. */
  keepRecent?: number
}

/**
 * The absolute trigger a session falls back on when nothing configured one.
 *
 * Measured, not chosen for roundness: llama.cpp's prompt-state stash refuses this model's
 * slot state past ~157k tokens (state runs ~0.052 MiB/token against a default 8192 MiB
 * --cache-ram), and past that cliff EVERY side request — the distiller, the acceptance
 * gate, the diff review — evicts the prefix and costs a full multi-minute re-prefill.
 * 140k keeps a session on the working side of it with room for mid-turn growth.
 *
 * It lives here rather than only in the host's settings loader because `setContextLength`
 * needs it: a session built while the server was still loading has no compaction options
 * to inherit from, and leaving it to the 0.8 ratio alone means first compacting near 210k
 * on a 262k window — ~53k tokens past the cliff this number exists to stay under.
 */
export const DEFAULT_TRIGGER_TOKENS = 140_000

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

/**
 * The stages of a turn that are not the model answering you.
 *
 * Named as a closed set rather than free text because these names are addressed elsewhere:
 * the window labels them, and `/gates` turns them off by name. A string would let the two
 * ends drift apart silently, which is the failure this project keeps rediscovering.
 *
 * The order is execution order, which is also the order they are worth explaining in.
 */
export type StageName =
  /** Distilling the request into a contract, before anything runs. */
  | 'contract'
  /** What must already be true of the code — checked at the first write. */
  | 'premises'
  /** Reading the request through three lenses to find the disagreement worth asking about. */
  | 'understanding'
  /** The project's own verify command: build, tests, whatever the workspace configured. */
  | 'build'
  /** Auditing the finished work against the contract's criteria. */
  | 'acceptance'
  /** A reviewer with a fresh context reading the diff and the code around it. */
  | 'review'

export interface StageInfo {
  stage: StageName
  state: 'started' | 'progress' | 'done'
  /** What it is on right now: the lens being read, the command being run, the file the
   * reviewer opened. The difference between "working" and "reading session.ts". */
  detail?: string
  /** Position inside the stage, where the stage knows one — lens 2 of 3, round 1 of 2. */
  at?: { index: number; total: number }
  /** `done` only: how long the stage took, and one line on what came of it. A stage that
   * cost ninety seconds and changed nothing is worth knowing about. */
  ms?: number
  outcome?: string
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
  /** Fired once per acceptance-gate check on a contract-bearing turn, so a front end can
   * show that the seconds it costs bought something — the same visibility rule onVerify
   * follows. `unmet > 0` means a fix round follows. `kind: 'review'` is the fresh-context
   * diff review, where `unmet` counts the issues it raised. */
  onAcceptance?(info: { met: number; unmet: number; round: number; kind: 'criteria' | 'review' }): void
  /**
   * Which stage of the turn is running right now, and what it is doing inside it.
   *
   * The gates were built to report their RESULTS — `onVerify` says a check ran and what it
   * said, `onAcceptance` says how many criteria were met. None of them reported that they
   * had STARTED, and the gap between those two facts is where the whole complaint lives: a
   * turn can spend several minutes between the last visible token and the first gate result,
   * during which the window says "working" and nothing else. On the reviewer it is worse
   * than nothing — its sub-agent is deliberately built with no-op events, so its six reading
   * steps are invisible by construction, and the last tool row still on screen is whatever
   * the MAIN agent was doing, which reads as a step that has hung.
   *
   * Emitted in pairs. `started` may be followed by any number of `progress` (a lens, a
   * criterion, a file the reviewer opened) and is always followed by exactly one `done`,
   * including when the stage was aborted or skipped — a stage that starts and never ends is
   * a spinner nobody can clear.
   */
  onStage?(info: StageInfo): void
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
  /**
   * The compaction settings that do NOT depend on the window, kept separately so they can
   * survive a session that was built before the server could state one.
   *
   * `compaction` above cannot be constructed at all until `contextLength` is known, so a
   * session opened while the model is still loading has none — and `setContextLength`, the
   * call that switches compaction on once the server answers, has nothing to merge the
   * user's `"compaction": { "triggerTokens": N }` back out of. Pass it here and it is
   * applied whenever the window finally arrives.
   */
  compactionDefaults?: Omit<CompactionOptions, 'contextLength'>
  onCompaction?(info: CompactionEvent): void
  /**
   * How far the compaction generation has got, while it runs.
   *
   * Wiring this is also what switches the compaction request to the streaming path — see
   * `generateCompaction`. A front end that shows nothing (the CLI, every headless test)
   * leaves it unset and keeps the cheaper non-streaming call.
   */
  onCompactionProgress?(progress: StreamProgress): void
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
 * Room kept clear in the window for a summary request's OUTPUT: the ~4.5k tokens the
 * generation may produce (compaction.ts's RETRY_MAX_TOKENS) plus a margin for the chat
 * template's own scaffolding and the briefing, neither of which is in any per-message
 * estimate.
 *
 * Output only. The request's other fixed cost — the session's tool array — is subtracted
 * separately in `summaryBudget`, because it is measured (TOOL_SCHEMA_TOKENS) rather than
 * guessed and because folding it in here hid it: this reserve was 8,000 while the request
 * needed ~9.5k beyond the transcript, and the shortfall landed precisely on the retry.
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
 * Ceiling on the kept-verbatim tail in TOKENS, independent of the window.
 *
 * `TAIL_SHARE` was measured against a 131k window, where a fifth is ~26k. The share scales
 * with the window but the reason for a tail does not: it exists so the model keeps its
 * immediate working set across a swap, and a working set is a couple of files and the last
 * exchange at any window size — not a fifth of 262k. Watched live at 262k: one turn whose
 * two search results totalled ~40k tokens sat entirely inside the 52k share, the middle
 * fell under `MIN_COMPACTABLE_TOKENS`, and `/compact` answered "nothing to compact yet" to
 * a 55k conversation — the exact situation compaction exists for, unreachable on exactly
 * the windows where compaction matters most. 24k keeps the measured 131k behaviour almost
 * unchanged and stops the tail growing with the window.
 *
 * Also the budget when no window size is known at all (`forceCompact` with compaction
 * never configured): unbounded was the previous behaviour there, and it had the same hole.
 */
const TAIL_TOKEN_CAP = 24_000

/**
 * The tail allowance for a given window: the share, capped absolutely.
 *
 * One function on purpose, used by the tail selector, the nothing-to-gain gate AND the
 * per-step result budget. The step budget and the tail budget being the same number is a
 * load-bearing invariant (see the comment beside `stepResultBudgetChars`): a step that fits
 * the tail can always be compacted AROUND; the cap shrinking the tail while the step budget
 * still allowed a share-sized batch quietly re-opened the gap at big windows.
 */
function tailBudgetTokens(contextLength: number | undefined): number {
  return contextLength === undefined
    ? TAIL_TOKEN_CAP
    : Math.min(Math.floor(contextLength * TAIL_SHARE), TAIL_TOKEN_CAP)
}

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

/** Writes since the plan was last touched before an upkeep note fires. Three is a real
 * stretch of work, not a single edit — the note must stay rare enough to be read. */
const UPKEEP_WRITES = 3

/** The plan, numbered the way `todo_write` numbers it, so the indices the model is asked to
 * send back are the ones sitting in front of it. Information in the prefix is the one channel
 * this model is measured to follow; an instruction to "keep the plan current" is not. */
function renderPlanLines(todos: readonly TodoItem[]): string {
  return todos
    .map((t, i) => `  ${i + 1}. [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' '}] ${t.text}`)
    .join('\n')
}

/** Past this, a check cannot run per write without dominating the turn it protects. */
const SLOW_VERIFY_SECONDS = 8

/**
 * How many times the acceptance gate may hand unmet contract criteria back before letting
 * the turn end anyway. Two: the first round closes forgotten work, the second closes what
 * the first round's work missed — and a model that has not met a criterion after two
 * directed attempts is not going to meet it by being asked a third time; the transcript
 * honestly says what is still open.
 */
const MAX_ACCEPTANCE_ROUNDS = 2

/**
 * What the fresh-context reviewer may call, named once.
 *
 * Named explicitly rather than left to plan mode's default, which is the registry's WHOLE
 * read-only set -- that set includes `database` and `use_skill`, and the reviewer's context
 * deliberately carries neither, so both would answer with a confident false statement about
 * the workspace that it would then reason from. Shared with `reviewVerdict` so the verdict
 * call sends the same array the reading turn did and stays a warm append.
 */
const REVIEWER_TOOLS = ['read_file', 'search_code', 'list_dir', 'find_files', 'symbol_outline'] as const

/** How far the independent reader may look before it must deliver a verdict. Enough to open
 * the files the diff touched and follow one thread out of them; past that it is re-reading
 * the repository at the end of every task, and each step is a generation. */
/**
 * Room the reviewer's own prompt needs beside the conversation, in tokens.
 *
 * Its brief is the diff plus the contract, and it then reads files for up to
 * `REVIEW_MAX_STEPS` steps. 24k is generous on purpose: over-reserving costs one skipped
 * review on a session that was nearly full anyway, and under-reserving costs the
 * 841-second re-prefill the guard in `freshReview` exists to avoid.
 */
/** Said in the transcript rather than skipped in silence -- the no-silent-truncation rule
 * applies to gates too. Bracketed so `replay.ts` shows it as the harness talking. */
const REVIEW_SKIPPED_NOTE =
  '[The independent diff review was skipped: this conversation is close enough to the ' +
  'context window that reading it a second time would cost minutes of re-processing. The ' +
  'contract check above still ran.]'

const REVIEW_PROMPT_ROOM = 24_000

const REVIEW_MAX_STEPS = 6

/**
 * The escalated retry's sampling: temperature up from the frozen 0.6, everything else
 * unchanged. High enough that a genuinely different approach is reachable, low enough to
 * stay far from the gibberish zone — and well above `assertSafeSampling`'s floor, which
 * guards the OTHER direction (the measured thinking runaway lives at low temperatures).
 */
const ESCALATION_SAMPLING = { temperature: 0.85, top_p: 0.95, top_k: 20, min_p: 0 }

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
// RE-MEASURED 2026-08-22 (`spike/tool-block-tokens.mts`), against the server's own
// tokenizer rather than by arithmetic. The array serialises to 17,798 chars, which chars/4
// scores as 4,450 — but the template renders it and the tokenizer charges **4,783**:
//
//   /apply-template + /tokenize : with tools 4,794 tok, without 11  -> 4,783
//   /v1/chat prompt_tokens      : with tools 4,794,     without 11  -> 4,783
//
// The two routes agree exactly, and a third (prompt_progress differencing) agreed during the
// audit that found this. chars/4 is a rule for prose; it under-reads JSON schema like it
// under-reads numbered source. Measure this constant, never derive it — a fill estimate that
// reads low is how an over-long prompt got through in the first place.
const TOOL_SCHEMA_TOKENS = 4_783

/** What the retry says instead of repeating the user's message, which is already in the
 * compacted tail. */
// Declared in compaction.ts, not here: `replay.ts` needs it to recognise this as a harness
// message rather than something the person typed, and session.ts already imports replay.ts —
// so the constant lives in the module they can both reach without a cycle.

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

/**
 * First user message, whitespace-collapsed and capped, used as the session's title.
 *
 * `attachmentUserText` first, because the message it is handed may be an attachment blob:
 * the file bodies are part of what the model sees, so they are part of the stored user
 * message, and titling from that gave "The user attached these files: --- a.ts --- 1 export
 * functio" for a session whose person typed "fix the off-by-one in a()". A title is one of
 * the two things a session is found by later.
 */
function titleFrom(text: string): string {
  const own = attachmentUserText(text) ?? text
  const collapsed = own.replace(/\s+/g, ' ').trim()
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
  /**
   * Whether `latestPromptTokens` came from the server REFUSING the prompt, rather than from a
   * completed request's usage.
   *
   * A refusal is the one measurement that cannot be re-taken: the request it came from will
   * not be re-sent, and every other reading is an estimate over the same transcript. The
   * nothing-to-gain branch of `compactNow` nulls the field so the trigger does not fire again
   * on a transcript it just declined to compact — correct for an ordinary reading, and wrong
   * for this one, which is the only proof the prompt does not fit at all.
   */
  private promptTokensFromRefusal = false
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
      // Superseded read bodies are dropped at RESUME as well as at swaps: the reason the
      // collapse is scoped to cache-rebuilding moments is that a mid-session rewrite would
      // invalidate the server's prefix cache — and at construction the cache is cold by
      // definition (`promptCacheCold` starts true), so this moment is free. On a fat
      // resumed session the stale read bodies were ~30% of the first prefill, paid in
      // full before the first token and again in rot for the rest of the session.
      const collapsed = collapseSupersededReads([...transcript.messages()])
      if (collapsed.some((m, i) => m !== transcript.messages()[i])) {
        // Message COUNT is unchanged (collapse replaces bodies, never removes rows), so
        // the persistence cursor below stays correct; the disk record keeps every byte.
        const rebuilt = new Transcript()
        for (const m of collapsed) rebuilt.append(m)
        this.transcript = rebuilt
      } else {
        this.transcript = transcript
      }
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
   * A successful `run_command` of the project's own verify command counts as the check.
   *
   * Watched live: the model habitually self-checks — every write cycle ended with it
   * running exactly the configured command, after which the write-boundary check ran the
   * SAME command over the SAME bytes and the end-of-turn pass could add a third. The model
   * saw the output; the question is answered. Recording it here lets `verifyMidTurn` (which
   * skips when no write followed the last check) and `verifyAndFix`'s already-green skip
   * treat the model's run as the boundary run.
   *
   * Success only, and only in a single-folder workspace: a failing run must leave the
   * fingerprint alone so the end-of-turn fix rounds still fire, and with per-folder
   * commands one root-level run does not answer for the other folders. The comparison is
   * `commandMatches`' own normalization (trim, collapse whitespace, lowercase), and a call
   * that names a `cwd` is running the command somewhere the configured check does not.
   */
  private noteModelRanVerify(name: string, argsJson: string | undefined): void {
    const command = this.opts.verify?.command
    if (name !== 'run_command' || command === undefined) return
    if (this.opts.verifyFolders !== undefined && Object.keys(this.opts.verifyFolders).length > 0) return
    let args: { command?: unknown; cwd?: unknown }
    try {
      args = JSON.parse(argsJson ?? '{}') as { command?: unknown; cwd?: unknown }
    } catch {
      return
    }
    if (typeof args.command !== 'string') return
    if (typeof args.cwd === 'string' && args.cwd !== '' && args.cwd !== '.') return
    const norm = (c: string): string => c.trim().replace(/\s+/g, ' ').toLowerCase()
    if (norm(args.command) !== norm(command)) return
    this.writesAtLastVerify = this.writeCount
    // The model ran the project's own check itself, and `run_command` carries no folder — so
    // every folder's slot is cleared rather than one guessed at. Being wrong here costs one
    // re-run of a check, which is the direction this has always erred in.
    this.lastVerifyFingerprint.clear()
    this.lastVerifyFingerprint.set('', 'ok')
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
  /**
   * Opens a stage, and hands back the one function that closes it.
   *
   * Shaped this way so the close cannot be forgotten on the paths that matter. Every gate
   * here has several exits — aborted, skipped for want of a contract, short-circuited
   * because nothing was written — and those are precisely the exits where a
   * fire-and-forget `started` would leave a spinner running forever. A closure that the
   * compiler makes you hold is harder to drop than a second call you have to remember.
   *
   * The clock starts here rather than at the first model call: the question the window has
   * to answer is "how long have I been waiting", and the person is already waiting.
   */
  private beginStage(stage: StageName, detail?: string): (outcome?: string) => void {
    const startedAt = Date.now()
    this.opts.onStage?.({ stage, state: 'started', ...(detail !== undefined ? { detail } : {}) })
    let closed = false
    return (outcome?: string) => {
      // Idempotent because several of these gates end twice on paper: a fixer round that
      // re-enters the build, an acceptance pass that returns early from inside a loop. A
      // second `done` would blank a stage that has legitimately restarted.
      if (closed) return
      closed = true
      this.opts.onStage?.({
        stage, state: 'done', ms: Date.now() - startedAt,
        ...(outcome !== undefined ? { outcome } : {}),
      })
    }
  }

  /** A step inside an already-open stage. Silent when nothing is listening. */
  private stageProgress(stage: StageName, detail: string, at?: { index: number; total: number }): void {
    this.opts.onStage?.({
      stage, state: 'progress', detail, ...(at !== undefined ? { at } : {}),
    })
  }

  private async verifyAndFix(
    result: TurnResult, writesThisTurn: number, signal?: AbortSignal,
  ): Promise<TurnResult> {
    if (result.stoppedBecause !== 'done') return result
    // Manual gates stop the whole post-turn chain here — build, acceptance and review — and
    // SAY so rather than going quiet, because a check that silently stopped happening is
    // indistinguishable from a check that silently passes. One line per turn, on the same
    // channel the gates themselves report on.
    if (this.gateMode === 'manual' && writesThisTurn > 0) {
      const endStage = this.beginStage('build', 'gates are set to manual')
      endStage('not run — ask for /check or /review when you are ready')
      return result
    }
    // A turn that wrote nothing cannot have broken the build — but it CAN be the turn
    // that claims the task finished. Found by the first giant unattended probe: turn 1
    // did all the work, turn 3 claimed the task fully finished with zero writes, and
    // the writes guard silently skipped the contract gate on exactly the turn whose
    // claim it exists to audit. The gate carries its own saysFinished/satisfied guards.
    //
    // "Wrote nothing" is about THIS turn; the build gate is about the workspace. A previous
    // turn that wrote and was then aborted leaves writes nobody has checked, and this
    // shortcut used to carry them straight past the build gate — so the second half of the
    // test is "and there is nothing outstanding", not just "and I wrote nothing".
    if (writesThisTurn === 0 && this.writeCount === this.writesAtLastVerify) {
      return await this.acceptanceGate(result, signal)
    }

    // Nothing has been written since the mid-turn check last ran, and it passed. Running the
    // same command again over the same bytes would ask a question that has already been
    // answered — and now that the mid-turn check fires at every write boundary, that is the
    // ORDINARY case rather than a rare coincidence: a turn with one edit would otherwise
    // build twice. A failing last check still falls through, because the fix rounds below
    // are the part that acts on it.
    //
    // Skips the BUILD, not the CONTRACT: found live, on the very first turn where the
    // model self-ran the check — the dedup returned here and the acceptance gate below
    // never ran at all. A green build answers "does it compile", never "is the task met".
    if (this.writesAtLastVerify === this.writeCount &&
        [...this.lastVerifyFingerprint.values()].every((f) => f === 'ok') &&
        this.lastVerifyFingerprint.size > 0) {
      return await this.acceptanceGate(result, signal)
    }

    // Work that does not change code has no build to break, and running one is not merely
    // wasted: reported from the running app — "составь email" spent a `dotnet build` on a
    // task with no source in it. The distiller answers `changesCode` as its own forced
    // question, and only an explicit `false` skips: an absent or malformed answer leaves it
    // undefined and the build runs, because a check silenced by omission is invisible.
    //
    // The CONTRACT gate still runs. "Did I do what you asked" is as true of an email as of a
    // refactor; it is the build that has nothing to say about one.
    if (this.meta.contract?.changesCode === false) {
      return await this.acceptanceGate(result, signal)
    }

    // Only the folders this turn actually wrote to, each with its own command. Running every
    // folder's suite after a one-line edit in one of them turns a thirty-second turn into
    // three minutes, and the folders that were not touched cannot have been broken.
    const jobs = this.verifyJobs()

    let current = result
    for (const job of jobs) {
      current = await this.verifyOne(job, current, signal)
      // A folder still failing after its rounds is the end state; carrying on to the next
      // one would bury the failure the model was just handed.
      if (current.stoppedBecause !== 'done') return current
    }
    // The contract gate runs AFTER the build gate: green code that misses a criterion is
    // a different failure from red code, and handing the model both at once buries one.
    return await this.acceptanceGate(current, signal)
  }

  /**
   * The other half of "done": the build passing says the code works, this says the TASK is
   * met. Same fixer mechanics as `verifyOne`; the check itself is a forced structured
   * generation over the live transcript (contract.ts), so it costs one generation and only
   * on turns that wrote something under a distilled contract — the exact turns where the
   * measured failure ("finished with conviction, criteria plainly unmet") lives.
   */
  private async acceptanceGate(
    result: TurnResult, signal?: AbortSignal,
  ): Promise<TurnResult> {
    const contract = this.meta.contract
    // A SATISFIED contract has retired: the follow-up turns after a finished task must
    // not keep paying an audit (and a cache displacement) for criteria already met.
    if (contract === undefined || contract.satisfied === true) return result
    if (result.stoppedBecause !== 'done') return result
    // The audit runs when the task looks OVER, not on every intermediate done-turn of a long
    // one: each check displaces the server cache (minutes of re-prefill on a fat session),
    // and an intermediate turn's work is audited anyway by whichever later turn ends it.
    //
    // Two signals, and the second one is why this is no longer a phrase match alone. Reading
    // the closing prose is guesswork over free text, and it kept losing: three live runs in a
    // row finished the work properly and ended "All 7 steps complete. Here's the summary:"
    // and "Here's a summary of everything that was done:" — so the audit and the diff review
    // both sat out the exact turns they exist for, silently, on a task that was done.
    //
    // A finished PLAN is the mechanical version of the same claim, and the plan is now
    // reliably maintained (measured: seven of seven updates on a real task), so a plan with
    // items and none of them open says the model thinks it is finished without anyone having
    // to parse a sentence. Either signal opens the gate; the phrase match stays for the tasks
    // small enough never to have grown a plan.
    const todos = this.opts.toolset.todos?.list() ?? []
    const planFinished = todos.length > 0 && todos.every((t) => t.status === 'completed')
    if (!planFinished && !saysFinished(result.finalText)) return result
    let current = result
    // Three outcomes, not two. "Clean" and "unmet" want opposite things from the diff review
    // below, and "the audit could not run" wants what CLEAN wants rather than what unmet
    // does: the review is an independent gate, and a gate that inherits another gate's
    // transport failure is not independent. Collapsing the third case into either of the
    // other two is what made a null audit silently cancel the review (measured: two runs
    // with byte-identical traffic, `[contract, acceptance, review]` against
    // `[contract, acceptance]`, both ending `done`).
    let outcome: 'clean' | 'unmet' | 'could-not-run' = 'unmet'
    const writesAtGateStart = this.writeCount
    const criteria = contract.criteria?.length ?? 0
    const endStage = this.beginStage(
      'acceptance',
      criteria === 0 ? 'auditing the work' : `auditing ${criteria} criteri${criteria === 1 ? 'on' : 'a'}`,
    )
    try {
    for (let round = 1; round <= MAX_ACCEPTANCE_ROUNDS; round++) {
      if (signal?.aborted) return current
      this.stageProgress('acceptance', `round ${round}`, { index: round, total: MAX_ACCEPTANCE_ROUNDS })
      // No cache flag any more, and that is the point of the rewrite: the check used to send
      // a one-tool `tools` array, which renders at the FRONT of the prompt and dropped the
      // server's prefix match to zero. It now sends the session's own array unchanged and
      // forces its shape with a sampler constraint, so this request is an ordinary append —
      // measured at 549 tokens of re-prefill against 1,228 for a normal step, with the
      // conversation still 100% cached afterwards (docs/SPIKE-KAT-CODER.md §3).
      // Claiming displacement here would hand the NEXT step a cold-start timeout for a
      // prefill that does not happen, which is minutes of grace a wedged server does not
      // deserve.
      const raw = await checkAcceptance(
        this.opts.client, this.transcript.messages(), contract, signal, this.stepSchemas(),
      )
      // A check that could not run must not block the turn; the build gate already ran.
      if (raw === null) {
        // ATTEMPTED AND FAILED is not the same as "nothing was unmet", and until now the two
        // were the same value. `lastUnmetCount` starts at 0 and is only ever written on the
        // success path below, so a transport error, a truncated generation or an unparseable
        // answer left it reading 0 — and the unattended runner ends a run 'done' on exactly
        // that number. A task whose audit never ran once could report itself finished.
        this.lastUnmetCount = null
        // BREAK, not return. Returning here walked out past the post-fixer verify below and
        // past `freshReview` — so one gate failing to get an answer switched off a second,
        // unrelated gate, and the turn still ended `done`.
        outcome = 'could-not-run'
        break
      }
      // A criterion the audit did not MENTION is a gap in the audit, not an affirmation —
      // and every reader below (the note, the plan, the failure message, the `unmet.length
      // === 0` test on the next line but one) treated the two as the same thing. See
      // `withUnreportedCriteria`.
      const report = withUnreportedCriteria(contract.criteria, raw)
      this.lastUnmetCount = report.unmet.length
      // The audit's verdict becomes part of the contract itself: every later swap promotes
      // "where the task actually STANDS" into message 0, not only what done would mean.
      contract.checkedState = renderCheckedState(contract, report)
      this.opts.store?.saveMeta(this.meta)
      // The checkboxes the audit just earned: scaffolded items are criteria verbatim,
      // so what the audit affirmed the plan shows as done without asking the model.
      this.syncTodosWithAudit(contract, report)
      this.opts.onAcceptance?.({ met: report.met, unmet: report.unmet.length, round, kind: 'criteria' })
      if (report.unmet.length === 0) { outcome = 'clean'; break }
      const fixed = await this.runHarnessTurn(acceptanceFailureMessage(report), signal)
      current = { ...fixed, steps: current.steps + fixed.steps }
      if (current.stoppedBecause !== 'done') return current
    }
    // A fixer that wrote may have left the build red — the end-of-turn verify already
    // reported green BEFORE the fixer existed, and 'done' over a broken build is the
    // exact lie this whole gate exists to prevent.
    if (this.writeCount !== writesAtGateStart) {
      for (const job of this.verifyJobs()) {
        current = await this.verifyOne(job, current, signal)
        if (current.stoppedBecause !== 'done') return current
      }
    }
    } finally {
      // In a `finally` because the loop above returns from four places — aborted, met,
      // could-not-run, out of rounds — and this stage must close on every one of them. The
      // outcome word is read after the loop rather than passed in, which is the point: it
      // is the same variable the caller branches on, so the window cannot be told one thing
      // while the code does another.
      endStage(outcome === 'clean'
        ? 'every criterion met'
        : outcome === 'unmet' ? 'handed work back' : 'could not run')
    }
    // Not on a turn the audit just handed back for more work. The reviewer costs up to
    // REVIEW_MAX_STEPS reads plus REVIEW_MAX_TOKENS of generation (~286s at the measured 42
    // tok/s) and sets `promptCacheCold`, so the NEXT turn re-prefills from scratch — 196k
    // tokens is another ~470s at the 417-454 tok/s this server actually prefills at. Paying
    // that to review a change the model is about to rewrite anyway is the worst turn to
    // spend it on. `freshReview`'s own doc already said "after the contract gate is
    // satisfied"; this is that sentence, enforced.
    //
    // 'could-not-run' runs it. See the tri-state note above: the review is not the audit's
    // dependant.
    if (outcome !== 'unmet') current = await this.freshReview(contract, current, signal)
    // `=== 0` and not merely falsy: `null` means the audit could not run, and a contract
    // must never retire on an audit that did not happen.
    if (outcome === 'clean' && current.stoppedBecause === 'done' && this.lastUnmetCount === 0) {
      contract.satisfied = true
      this.opts.store?.saveMeta(this.meta)
      // The plan retires WITH the task — watched live: a finished task left a 6/6 card
      // on screen with no way to dismiss it, over a plan the model had no reason to
      // touch again. The store empties (plan.json included) so the card disappears and
      // the next task seeds a fresh plan instead of refusing to clobber a dead one.
      const todoStore = this.opts.toolset.todos
      if (todoStore !== undefined && todoStore.list().length > 0) {
        todoStore.set([])
        this.opts.interaction?.todosChanged?.(todoStore.list())
      }
    }
    return current
  }

  /**
   * The independent read: the same model reviews this turn's DIFF in a context that never
   * saw the work being made — no transcript, no reasoning, no belief. Runs once, after the
   * contract gate is satisfied, only when the turn produced enough diff for an independent
   * reader to see something the in-context check cannot (`DIFF_REVIEW_MIN_CHARS`). One fix
   * round on findings, no re-review: the transcript then honestly carries both the
   * reviewer's claims and what the fixer did about them.
   *
   * The request's prompt shares nothing with the conversation, so it displaces the
   * server's cache — flagged exactly the way a compaction generation is, and worth the
   * same price for the same reason: it happens at a turn boundary, once.
   */
  private async freshReview(
    contract: NonNullable<SessionMeta['contract']>,
    result: TurnResult,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    if (signal?.aborted || result.stoppedBecause !== 'done') return result
    // Read HERE, not carried in: a fixer turn inside the acceptance gate can compact, and
    // `applyCompactionSwap` remaps the field while a value captured before the gate keeps
    // pointing into the pre-swap transcript. `slice(190)` of a 9-message transcript is
    // empty, so the diff measured 0 characters and `freshReview` returned before the
    // reviewer was ever built and before any review event was emitted — on exactly the
    // largest turns, the ones a compaction happens on. The comment at the capture site names
    // this hazard for the OUTER turn; it applies just as much to the fixer's.
    const diff = this.turnDiffText(this.turnStartIndex)
    if (diff.length < DIFF_REVIEW_MIN_CHARS) return result
    // Not when there is no room for both. The reviewer's prompt shares nothing with the
    // conversation, so the server holds two prefixes at once -- and it does, for free, until
    // the conversation is nearly the whole window. Measured, one foreign prompt against a
    // warm conversation:
    //
    //    92,183 tokens -> cached 92,179    123,103 -> cached 123,099    160,023 -> 160,019
    //   193,343 tokens -> cached 0         EVICTED, 841 s to rebuild
    //
    // So this gate is free for almost every session and costs FOURTEEN MINUTES on one that has
    // crept up on the window -- and the compaction trigger is 0.8, which leaves a live band
    // between it and the cliff whenever compaction postpones. A numeric guard, not a
    // judgement: when the conversation plus a reviewer-sized brief does not fit, the
    // independent read is skipped and SAID to be skipped, and the acceptance gate still ran.
    // Opened before the room check, not after: "the review was skipped because the context
    // is nearly full" is the single most useful thing this stage ever says, and it was
    // written only into the transcript, where nothing renders it until the session is
    // reloaded. Now it is also a `done` with a reason on it.
    const endStage = this.beginStage('review', `reading the diff (${Math.round(diff.length / 1000)}k characters)`)

    const window = this.opts.compaction?.contextLength
    const used = this.usedTokens(false)
    if (window !== undefined && used !== null && used + REVIEW_PROMPT_ROOM > window) {
      this.transcript.append({
        role: 'user',
        content: REVIEW_SKIPPED_NOTE,
      })
      endStage('skipped — not enough context left to review in')
      return result
    }
    this.compactionDisplacedCache = true
    this.promptCacheCold = true
    const issues = await this.runReviewer(contract, diff, signal)
    endStage(issues === null
      ? 'stopped before it reached a verdict'
      : issues.length === 0 ? 'no findings' : `${issues.length} finding${issues.length === 1 ? '' : 's'}`)
    if (issues !== null) {
      this.lastUnmetCount = Math.max(this.lastUnmetCount ?? 0, issues.length)
      this.opts.onAcceptance?.({ met: 0, unmet: issues.length, round: 1, kind: 'review' })
    }
    if (issues === null || issues.length === 0) return result
    const writesBeforeFix = this.writeCount
    const fixed = await this.runHarnessTurn(reviewFailureMessage(issues), signal)
    let current: TurnResult = { ...fixed, steps: result.steps + fixed.steps }
    // Same honesty rule as the acceptance fixers: writes after the last verify must not
    // end a turn unverified.
    if (this.writeCount !== writesBeforeFix && current.stoppedBecause === 'done') {
      for (const job of this.verifyJobs()) {
        current = await this.verifyOne(job, current, signal)
        if (current.stoppedBecause !== 'done') break
      }
    }
    return current
  }

  /**
   * The independent reader, with its eyes open.
   *
   * It used to receive the contract and the diff and nothing else, which let it catch an
   * off-by-one and made a whole class of defect invisible: a diff shows what MOVED and hides
   * what it depends on, so "this calls the wrong helper" or "this breaks a caller" cannot be
   * seen from inside one. Now it can open files — a bounded read-only turn first, then the
   * forced verdict over whatever it looked at.
   *
   * `mode: 'plan'` is doing real work here rather than being a label: the Agent constructor
   * narrows the tool list to the registry's own `readOnlyNames()` regardless of what is
   * passed, so a reviewer physically cannot edit the change it is reviewing.
   *
   * Its transcript is FRESH. That is the whole value of the second opinion and the reason it
   * is worth a cold prefill: the writing context believes its own work, and no amount of
   * prompting talks it out of that — it is what holding a plan in context IS.
   */
  /**
   * One reviewer tool call, in the words a person would use for it.
   *
   * The raw call is `search_code {"pattern":"applyCompactionSwap","max_results":40}`, which
   * is fine in a tool row and wrong in a one-line status. What matters while waiting is
   * WHICH FILE or WHICH TERM, so that is all this keeps — and it keeps it short, because a
   * status line that wraps pushes the composer around while you are trying to type in it.
   */
  private static reviewerDetail(name: string, argsJson: string): string {
    let args: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(argsJson)
      if (typeof parsed === 'object' && parsed !== null) args = parsed as Record<string, unknown>
    } catch {
      // A half-streamed call. The tool name alone is still worth saying.
    }
    const of = (key: string): string | undefined =>
      typeof args[key] === 'string' ? (args[key] as string) : undefined
    const clip = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}...` : s)

    const path = of('path') ?? of('file')
    if (name === 'read_file' && path !== undefined) return `reading ${clip(path)}`
    if (name === 'search_code') {
      const pattern = of('pattern')
      return pattern === undefined ? 'searching' : `searching for ${clip(pattern)}`
    }
    if (name === 'find_files') {
      const glob = of('glob')
      return glob === undefined ? 'looking for files' : `looking for ${clip(glob)}`
    }
    if (name === 'list_dir' && path !== undefined) return `listing ${clip(path)}`
    if (name === 'symbol_outline' && path !== undefined) return `outlining ${clip(path)}`
    return name
  }

  private async runReviewer(
    contract: NonNullable<SessionMeta['contract']>,
    diff: string,
    signal?: AbortSignal,
  ): Promise<ReviewIssue[] | null> {
    // The role arrives in the BRIEF rather than as a system prompt of its own: the Agent
    // builds message 0 itself, and that message is where the workspace rules and the
    // prompt-injection guard live. A reviewer that opens files needs those exactly as much
    // as the writer did.
    const brief = `${REVIEW_SYSTEM}\n\n${buildReviewBrief(contract, diff, contract.request)}`
    const transcript = new Transcript()
    /** Counted here rather than read off the Agent: `onToolCall` fires per CALL and a step
     * may batch several, so the step number is not derivable from the callback alone. It is
     * clamped at the ceiling because the count is an upper bound on the step, not the step. */
    const reviewSteps = { count: 0 }
    const agentOpts: AgentOptions = {
      client: this.opts.client,
      registry: this.opts.toolset.registry,
      context: {
        workspace: this.workspace,
        // Its OWN read memory, not the writer's. That memory exists so a tool can answer "you
        // already read this, unchanged" instead of repeating a file — which is right within
        // one worker and wrong across two: the reviewer has read nothing, and being told it
        // has by a memory of somebody else's reading is the fresh context leaking away
        // through the one door left open. It is the whole reason this reader exists.
        reads: new ReadMemory(),
      },
      transcript,
      mode: 'plan',
      // Named explicitly rather than left to plan mode's default, which is the registry's
      // WHOLE read-only set. That set includes `database` and `use_skill`, and the context
      // above deliberately carries neither — so both were offered to the reviewer and both
      // answer with a confident false statement about the workspace ("no database is
      // configured") that it then reasons from. Plan mode still narrows whatever is passed,
      // so this can only ever be a subset.
      allowedTools: [...REVIEWER_TOOLS],
      // Enough to open the touched files and follow one thread out of them; past that it is
      // re-reading the repository on every finished task, and the verdict is a generation
      // away either side of it.
      maxSteps: REVIEW_MAX_STEPS,
      // A delta callback, and it has to be here for a reason that is not about rendering.
      // Streaming is opt-in on one of these being present, and the step clock measures
      // SILENCE by re-arming on every delta — so an Agent with none of them gets its
      // first-token budget applied to the entire request instead. The reviewer was the only
      // Agent built without one: on a large diff its own reading turn would die on a
      // deadline meant to catch a hung server. Watched once as a probe that ran past ten
      // minutes and had to be killed.
      //
      // `onToolCall` was added for a second reason, and it is the reason this whole stage
      // was invisible: these six steps are the longest silence in a turn, and the ONLY
      // signal a person had was the main agent's last tool row still sitting on screen —
      // which reads as a step that has hung, on precisely the turns where nothing is wrong.
      // Reporting each file the reviewer opens turns four silent minutes into four minutes
      // of watching somebody read.
      events: {
        onTextDelta: () => {},
        onToolCall: (name, args) => {
          this.stageProgress('review', Session.reviewerDetail(name, args), {
            index: Math.min(reviewSteps.count += 1, REVIEW_MAX_STEPS), total: REVIEW_MAX_STEPS,
          })
        },
      },
      ...(signal ? { signal } : {}),
    }
    // The same ceiling the main agent gets, and for the same reason its comment gives: one
    // step may batch several reads, and `MAX_CHARS` per read is 60,000 — four of them is a
    // window's worth of tokens appended atomically on top of an already-large brief. The
    // reviewer was the ONLY Agent built without this, and it is the one whose context is
    // most nearly full to begin with. Past the limit the next request 400s, `runTurn`
    // throws, the catch below swallows it, `reviewVerdict` then throws over the same
    // transcript and returns null — and `freshReview` reports nothing, having fired no
    // event. "Reviewed, found nothing" and "the review could not run" were the same thing
    // in the transcript, the verify strip and the log, on exactly the largest turns.
    if (this.opts.compaction !== undefined) {
      agentOpts.stepResultBudgetChars = tailBudgetTokens(this.opts.compaction.contextLength) * 4
    }
    try {
      const reader = new Agent(agentOpts)
      await reader.runTurn(brief)
    } catch {
      // A reader that fell over still leaves a transcript worth asking for a verdict over —
      // and if it does not, the verdict call returns null and the turn is unreviewed, which
      // is exactly where it stood before any of this existed.
    }
    if (signal?.aborted) return null
    // The reviewer's OWN tool list, so the verdict is an append onto the prefix its reading
    // turn just warmed rather than a fresh one. Same list `agentOpts.allowedTools` names
    // above -- read from the registry so the two cannot drift.
    return await reviewVerdict(
      this.opts.client, transcript.messages(), signal,
      this.opts.toolset.registry.schemas([...REVIEWER_TOOLS]),
    )
  }

  /**
   * Every diff this turn's WRITES produced, in order.
   *
   * Two sources, both from the turn's slice of the transcript: edit-family tool RESULTS
   * that begin with the diff header (`startsWith`, never `includes` — a read_file result
   * can EMBED a change-notice diff for edits this turn did not make, and reviewing those
   * judged someone else's changes), and `write_file` CALL arguments — a created file's
   * result line carries no diff at all, and a turn of pure creation is the biggest change
   * a review can look at.
   */
  private turnDiffText(turnStartIndex: number): string {
    const parts: string[] = []
    for (const m of this.transcript.messages().slice(turnStartIndex)) {
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.startsWith('--- ')) {
        parts.push(m.content)
        continue
      }
      for (const call of m.tool_calls ?? []) {
        if (call.function.name !== 'write_file') continue
        try {
          const args = JSON.parse(call.function.arguments) as { path?: unknown; content?: unknown }
          if (typeof args.path === 'string' && typeof args.content === 'string') {
            // Generous, and ANNOUNCED when it clips: silently truncated input is the one
            // failure nobody can trace afterwards. The window affords whole files.
            const body = args.content.length > 24_000
              ? `${args.content.slice(0, 24_000)}\n[... file clipped for review]`
              : args.content
            parts.push(`+++ ${args.path} (created this turn)\n${body}`)
          }
        } catch { /* malformed arguments never reached the workspace either */ }
      }
    }
    return parts.join('\n\n')
  }

  /**
   * The premise check: what the model believes about the code, settled against the code.
   *
   * Returns the veto text when something it was relying on is not in the files, and
   * `undefined` in every other case — including when it could not run, which must never cost
   * the turn. Runs once per task: the point is to be told before the first write, and a model
   * told twice starts arguing with the check instead of reading.
   */
  private async premiseGate(
    contract: NonNullable<SessionMeta['contract']>, signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (contract.premisesChecked === true) return undefined
    // Nothing to settle against the files when the work is not about the files. The premise
    // check asks what the model believes about the CODE and verifies it there; for an email
    // or an explanation it has no subject.
    if (contract.changesCode === false) return undefined
    // Marked before the generation, like the understanding check and for the same reason: an
    // attempt that is aborted or throws has still been spent, and re-firing it on the next
    // write would pay for it again.
    contract.premisesChecked = true
    this.opts.store?.saveMeta(this.meta)
    // No cache flag: this now sends the session's own tool array and constrains the answer
    // with a sampler schema, so it is an append onto the warm prompt rather than a new
    // prefix. See the acceptance gate above.

    // Opened only HERE, after every early return above. A gate that announces itself and
    // then discovers it had nothing to do is a flicker on screen for a stage that never ran.
    const endStage = this.beginStage('premises', 'checking what the plan assumes about the code')

    let premises: Premise[] | null
    try {
      premises = await statePremises(
        this.opts.client, this.transcript.messages(), signal, this.stepSchemas(),
      )
    } catch {
      endStage('could not run')
      return undefined
    }
    if (premises === null || signal?.aborted) {
      endStage('stopped')
      return undefined
    }
    const check = verifyPremises(premises, this.workspace)
    if (check.unverified.length === 0) {
      endStage(`${premises.length} assumption${premises.length === 1 ? '' : 's'} hold`)
      return undefined
    }
    endStage(`${check.unverified.length} of ${premises.length} do not hold — the write is vetoed`)
    return premiseFailureMessage(check)
  }

  /**
   * The understanding check, at the last moment it is still free.
   *
   * Fires once per task, on the FIRST write. Everything before a write is reading — cheap,
   * reversible, and the reason to wait: asked on send, the questions are uninformed and half
   * of them are answered by code the model had not opened yet. Asked here, the readings are
   * grounded in what it actually found, so a question is specific and usually answerable in
   * one word.
   *
   * The write it lands on does not run. Its result carries the user's answers instead, which
   * is the only way they can reach the model from inside a step: appending to the transcript
   * here would separate an assistant tool-call message from its replies and invalidate it.
   * One re-issued call is the whole cost, against a misunderstanding that would otherwise be
   * found after the work was built on it.
   *
   * Silent in every case where it has nothing to say — no contract, already run, the readings
   * agreed, or the readings could not be taken at all. Silence is the common outcome and the
   * correct one.
   */
  private async understandingGate(
    tool: string, port: InteractionPort, signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!WRITE_TOOLS.has(tool)) return undefined
    const contract = this.meta.contract
    if (contract === undefined || contract.satisfied === true) return undefined

    // The premise check first, and both of these run at the same moment for the same reason:
    // it is the last one that is free. They answer different questions in a deliberate order,
    // though — what the model believes about the CODE is settled against the files before
    // anybody is asked what they meant, because a premise failure often changes what the
    // right question even is.
    const premiseVeto = await this.premiseGate(contract, signal)
    if (premiseVeto !== undefined) return premiseVeto

    if (contract.understood === true) return undefined
    const request = contract.request
    if (request === undefined || request.trim() === '') return undefined

    // Marked BEFORE the generations, not after: a check that is aborted or throws halfway
    // must not re-fire on the next write and ask the same three readings again. One attempt
    // per task is the promise, and a failed attempt has been spent.
    contract.understood = true
    this.opts.store?.saveMeta(this.meta)

    // No cache flag, for the same reason as the two gates above: the readings ride the
    // session's own unchanged tool array now, so all three are appends onto the warm prompt.

    const endStage = this.beginStage('understanding', 'reading the request three ways')

    let understanding: Understanding | null
    try {
      understanding = await readThroughLenses(
        this.opts.client, this.transcript.messages(), request, signal, this.stepSchemas(),
        (lens, index, total) => this.stageProgress(
          'understanding',
          lens === 'grouping' ? 'comparing the readings' : `the ${lens} reading`,
          { index, total },
        ),
      )
    } catch {
      endStage('could not run')
      return undefined
    }
    if (understanding === null || signal?.aborted) {
      endStage('stopped')
      return undefined
    }
    // Closed here rather than at the end of the method: what follows is a question put to a
    // PERSON, and leaving the stage open through it would report the model as busy for
    // however long the person takes to answer.
    endStage('read')

    // Do not ask what the contract already answers. The lenses compare readings with each
    // OTHER and never with the contract, so a reading the contract already states reaches the
    // card as a question whose answer is written down two fields away -- measured live: three
    // offered readings, all three already criteria, a person interrupted, and the contract
    // came back byte-identical. `known` is the same mapping the fold below would have asked
    // for after the answer, so this MOVES a generation rather than adding one.
    const filtered = await contestedBeyondContract(
      this.opts.client, understanding, contract.criteria, signal,
    )
    understanding = filtered.understanding
    if (signal?.aborted) return undefined

    const question = buildQuestion(understanding)
    // Nothing left that the contract does not already require: no question to ask, and the
    // turn carries on rather than stopping a person for a formality.
    if (question === null) return undefined

    let answer: string
    try {
      answer = await port.askUser(question)
    } catch {
      // Nobody answered — an unattended run with a full queue, or the window going away.
      // The turn carries on with the reading the model already had, which is exactly where
      // it stood before this check existed.
      return undefined
    }

    // THREE THINGS THAT ARE NOT AN ANSWER, and every one of them used to be folded into the
    // contract as though a person had chosen it.
    //
    //  - the turn was cancelled while the card was open. Stop is not a decision about scope,
    //    and `askUser` resolves rather than throwing on that path, so the catch above never
    //    sees it.
    //  - nobody was there. A queueing port answers with `PARKED_ANSWER`, which is prose about
    //    the queue; split on ';' it matched no option and both halves were written in as
    //    done-criteria, so an overnight run acquired "Nobody is available to answer right
    //    now" as a condition of finishing.
    //  - an empty answer, which no path should produce and every path should survive.
    //
    // In all three the honest state is the one this check started in: the model keeps the
    // reading it already had, and the contract is untouched.
    if (signal?.aborted || answer.trim() === '' || answer === PARKED_ANSWER) return undefined

    // The model decides what says the same thing, with the string comparison as the
    // fallback -- measured in the running app, the string comparison alone matched none of
    // three ticks against any of eight criteria. See `foldAnswerWithModel`.
    const { criteria, notPicked, nextCriteria } = await foldAnswerWithModel(
      this.opts.client, understanding, answer, contract.criteria, signal, filtered.known,
    )
    if (criteria.length === 0 && notPicked.length === understanding.contested.length) {
      // Nothing matched and nothing was typed that we could keep — an answer we cannot read.
      // Reporting every option as "they did not pick this" would be a confident summary of
      // something we did not understand.
      return undefined
    }
    // `nextCriteria`, not a concatenation: the options are readings of the same request the
    // contract came from, so a tick usually restates a criterion that is already there.
    // Appending gave one live task ten criteria where seven said everything — and each
    // duplicate is audited separately, planned separately, and carried into message 0 at
    // every compaction. See `foldAnswer`.
    contract.criteria = nextCriteria.slice(0, 12)
    // The audit's record of where the task stands is about the OLD criteria; leaving it
    // would promote "1,2,3 met" into message 0 over a contract that has grown since.
    delete contract.checkedState
    this.opts.store?.saveMeta(this.meta)
    // NOT an acceptance event. This used to fire `onAcceptance({ met: criteria.length,
    // unmet: 0, kind: 'criteria' })` — which the window and the work log both read as "the
    // contract check ran and passed", asserted here before a single line has been written,
    // let alone audited. `met` was not even a count of met criteria; it was the number of
    // criteria the user had just ADDED. The contract growing is a different event from the
    // contract being checked, and the only honest thing to say here is nothing.

    const wanted = criteria.length > 0
      ? `They want these, and they are now part of what "done" means:\n${criteria.map((c) => `- ${c}`).join('\n')}\n`
      : 'They did not want any of them.\n'
    // Stated once, here, and deliberately NOT written into the contract as constraints: not
    // ticking a box is a shrug, not a prohibition, and a contract that carries it as one
    // ends up ordering the model away from the work. See `foldAnswer`.
    const refused = notPicked.length > 0
      ? `\nThey did not pick these, so do not go out of your way to add them:\n${notPicked.map((c) => `- ${c}`).join('\n')}\n`
      : ''
    return 'Not run: before this change the user was asked what they actually meant, ' +
      `because your own readings of the request disagreed.\n\n${wanted}${refused}\n` +
      'Re-issue the change with that settled. Nothing was written.'
  }

  /** The verify commands that apply to what this turn wrote, in mount order. */
  /**
   * `everywhere` is for the gate somebody ASKED for.
   *
   * The automatic path checks only folders this session wrote to, which is the whole reason
   * it is affordable — a four-folder workspace does not run four builds because one file
   * changed. That filter is wrong the moment the check is explicit: "I have finished, run
   * the tests" can follow work done in a previous session, or by hand in another editor,
   * and answering it with "no verify command is configured" would be false.
   */
  private verifyJobs(everywhere = false): { spec: VerifySpec; root: string; folder: string }[] {
    const jobs: { spec: VerifySpec; root: string; folder: string }[] = []
    for (const mount of this.workspace.mounts) {
      if (!everywhere && !this.writtenMounts.has(mount.name)) continue
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
    // The command, not the word "build". Waiting on `dotnet build ./src/Engine` and waiting
    // on `npm test` feel like the same silence and are not the same wait, and the person
    // watching is the one who wrote the command into the settings file.
    const endStage = this.beginStage('build', `${job.spec.command} in ${job.folder}`)
    let verdict = 'stopped'
    try {
    for (let attempt = 1; attempt <= MAX_VERIFY_ROUNDS; attempt++) {
      if (signal?.aborted) return current
      this.stageProgress('build', attempt === 1 ? 'running' : `running again (attempt ${attempt})`,
        { index: attempt, total: MAX_VERIFY_ROUNDS })
      // This check covers everything written up to now, so record that — the end-of-turn
      // verify used to leave the counter where the mid-turn one had put it, which made
      // "are there writes nobody has checked" answer yes forever once a mid-turn check was
      // skipped. Re-captured each round because the fixer turn below writes too.
      this.writesAtLastVerify = this.writeCount
      const outcome = await runVerify(job.spec, job.root, signal)
      verdict = outcome.problem !== undefined
        ? `could not run — ${outcome.problem}` : outcome.ok ? 'passed' : 'failed'
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
      const fixed = await this.runHarnessTurn(`${where}${verifyFailureMessage(job.spec, outcome)}`, signal)
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

    // ESCALATION, once, after the in-place rounds are spent: same-approach repair has now
    // failed repeatedly, and a third identical ask converges on the same patch. The retry
    // changes TWO things the rounds could not — the framing (stop repairing the previous
    // attempt, choose a different approach) and the sampling (temperature up, so a
    // different approach is actually reachable off the identical cached prefix; sampling
    // curves are steepest in the first extra draws). One escalated turn, then one honest
    // final check; a workspace still red after that ends the turn red, said plainly.
    if (signal?.aborted) return current
    this.writesAtLastVerify = this.writeCount
    const still = await runVerify(job.spec, job.root, signal)
    this.opts.onVerify?.({
      command: job.spec.command, ok: still.ok, attempt: MAX_VERIFY_ROUNDS + 1,
      ...(this.workspace.multi ? { folder: job.folder } : {}),
      ...(still.exitCode !== null ? { exitCode: still.exitCode } : {}),
      ...(still.problem !== undefined ? { problem: still.problem } : {}),
    })
    if (still.ok || still.problem !== undefined) return current
    const escalated = this.buildAgent(signal, ESCALATION_SAMPLING)
    const where = this.workspace.multi ? `In the "${job.folder}" folder: ` : ''
    const retried = await escalated.runTurn(
      `${where}[${MAX_VERIFY_ROUNDS} repair attempts left the check failing. STOP repairing ` +
      'the previous attempt — re-read the failing code from the file, pick a DIFFERENT ' +
      // `]\n\n`, not `]\n`. `replay.ts` recognises "a bracketed note prefixed to a message"
      // by a BLANK line after the bracket — that separator is the whole test, because
      // `[HttpGet] is missing on the controller` is an ordinary thing to type. One newline
      // failed it, so this escalation replayed as something the person had written.
      `approach, and implement that instead.]\n\n${verifyFailureMessage(job.spec, still)}`,
    )
    current = { ...retried, steps: current.steps + retried.steps }
    if (current.stoppedBecause !== 'done' || signal?.aborted) return current
    const final = await runVerify(job.spec, job.root, signal)
    verdict = final.ok ? 'passed after the escalation' : 'still failing'
    this.opts.onVerify?.({
      command: job.spec.command, ok: final.ok, attempt: MAX_VERIFY_ROUNDS + 2,
      ...(this.workspace.multi ? { folder: job.folder } : {}),
      ...(final.exitCode !== null ? { exitCode: final.exitCode } : {}),
      ...(final.problem !== undefined ? { problem: final.problem } : {}),
    })
    return current
    } finally {
      // `finally`, because this method returns from nine places — passed, unrunnable,
      // aborted, out of rounds, a fixer turn that did not finish. `verdict` is written
      // wherever a check actually produced a result, so what the window is told is the last
      // thing the command really said rather than a guess made at one exit.
      endStage(verdict)
    }
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
   * How many contract criteria (or review findings) the last gate left standing, or `null`
   * when a gate was ATTEMPTED and could not run at all.
   *
   * The distinction is the whole point: the unattended runner reads this to decide whether a
   * turn that says "done" may end the run, and a gate that failed to answer is not evidence
   * of anything. `0` still means what it always meant — either no audit was owed, or one ran
   * and found nothing.
   */
  lastAcceptanceUnmet(): number | null {
    return this.lastUnmetCount
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
    //
    // ...and all of that is true only when the prefix is COLD, which is the case that
    // reasoning was measured in. It no longer describes the common one. This request now
    // carries the session's own tool block (see `buildCompactionRequest`), so when the
    // server is still holding the prompt the turn just used, sending the WHOLE transcript is
    // a pure append — the only new tokens are the briefing instruction — while capping it at
    // 40k makes `fitForSummary` drop the middle, and dropping the middle is a mutation: the
    // prompt diverges at the cut and ~40k tokens are re-read for nothing. Capping is the
    // slower option exactly when compaction normally fires, which is straight after a turn.
    //
    // So the cap is kept for the case it was measured on, and only that case: a cold prefix,
    // where a window-sized request really is five minutes of silence. `promptCacheCold` is
    // the session's own answer to that question and is already maintained for the step
    // clock. Being wrong here is bounded either way — wrong-warm costs one capped summary,
    // wrong-cold costs one slow one — and it decides nothing about correctness, only speed.
    //
    // The tool block comes off the top, separately from the output reserve. The warm branch
    // fills the budget with TRANSCRIPT, and `buildCompactionRequest` then adds the session's
    // 21-tool array to it — 4,783 tokens the budget never knew about. Measured end to end:
    // `contextLength: 20000` with a warm cache reported a budget of 12,000, and the request
    // built from a transcript filled to it came back at **15,879 real tokens** on the live
    // server, leaving 4,121 of window. That covers compaction's MAX_TOKENS (3,000) but not
    // its RETRY_MAX_TOKENS (4,500) — and the retry is the thing that exists for exactly the
    // truncation this would cause. The overrun is window-independent, so no larger context
    // fixes it: tools plus briefing are a fixed cost and have to be named as one.
    const room = contextLength - SUMMARY_OUTPUT_RESERVE - TOOL_SCHEMA_TOKENS
    const cap = this.promptCacheCold ? SUMMARY_MAX_INPUT_TOKENS : room
    return Math.max(0, Math.min(room, cap))
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
   * The tail a swap would keep, computed the one way both askers must share.
   *
   * The budget is the window share capped absolutely (`TAIL_TOKEN_CAP` explains why), and it
   * lives here so the gate (`compactableTokens`) and the swap (`applyCompactionSwap`) can
   * never disagree about what stays — the gate declining a swap that would in fact have
   * freed half the window is exactly what a drifted second copy produced.
   */
  private compactionTailNow(): ReturnType<typeof selectCompactionTail> {
    const keepRecent = this.opts.compaction?.keepRecent ?? 6
    const { tail, droppedMessages } = selectCompactionTail(
      this.transcript.messages(), keepRecent, tailBudgetTokens(this.opts.compaction?.contextLength),
    )
    // Superseded read bodies are dropped HERE, inside the one shared helper, so the
    // nothing-to-gain gate and the swap see the same collapsed sizes.
    return { tail: collapseSupersededReads([...tail]), droppedMessages }
  }

  /**
   * How much a compaction could actually free: everything that will not survive the swap
   * verbatim.
   *
   * That is the summarised MIDDLE plus what clipping the kept tail's oversized messages
   * frees — so it is computed as "all of it minus the tail as it would actually be kept",
   * with the clipping applied. The first version counted only the middle, and a session
   * whose bulk sat in two huge tool results INSIDE the tail read as "nothing to gain" at
   * 55k tokens: the gate refused precisely the compaction that would have freed the most.
   */
  private compactableTokens(): number {
    const messages = this.transcript.messages()
    const { tail } = this.compactionTailNow()
    const floor = messages.length > 0 && messages[0]!.role === 'system' ? 1 : 0
    // `approxTokensOf`, not a local formula: it counts `tool_calls` arguments, and a
    // write-heavy stretch is whole files in `arguments` with `content: null`. A local
    // content-only count here once read such a stretch as "nothing to compact" while the
    // no-progress guard (Transcript.approxTokens) counted it fully — the gate and the
    // guard disagreeing about the same bytes.
    const total = messages.slice(floor).reduce((sum, m) => sum + approxTokensOf(m), 0)
    const kept = tail.reduce((sum, m) => sum + approxTokensOf(m), 0)
    return Math.max(0, total - kept)
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
        `${REVERT_FILE_PREFIX}${path} to how it was before this session started` +
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
        `${ROLLBACK_PREFIX}${result.restored.id} by the user. ` +
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

  /**
   * Whether the end-of-turn gates run by themselves, or only when asked.
   *
   * `'manual'` stops the three that fire AFTER the work: the build, the acceptance audit
   * and the diff review. The three before it — contract, premises, understanding — stay on,
   * and that asymmetry is the point rather than an oversight. The pre-turn gates shape what
   * gets written and cost one generation each; the post-turn gates check what was written
   * and cost, between them, up to three full agent turns, four command runs and a cold
   * prefill on the NEXT turn. It is the second group that turns "change these three lines"
   * into a five-minute wait, and the second group whose answer keeps until you are done.
   *
   * Held on the session rather than in a settings file: it is a judgement about the piece
   * of work in front of you, not about the project. A new session starts automatic again,
   * which is the safer default to forget.
   */
  get gateMode(): 'auto' | 'manual' {
    return this.meta.gateMode ?? 'auto'
  }

  set gateMode(mode: 'auto' | 'manual') {
    this.meta.gateMode = mode
    this.opts.store?.saveMeta(this.meta)
  }

  /**
   * Runs the post-turn gates now, on the work as it stands.
   *
   * The other half of `gateMode: 'manual'`, and the reason turning them off is not the same
   * as throwing them away: "I have finished, now check it" is a thing you say once, at the
   * end, instead of paying for it after every edit along the way.
   *
   * `which` is deliberately not "all": the build and the review answer different questions
   * and cost differently, and being made to run a four-minute review to find out whether the
   * tests pass is exactly the coupling this exists to break.
   */
  async runGate(
    which: 'build' | 'review', signal?: AbortSignal,
  ): Promise<{ turn: TurnResult; outcome: string; reported: boolean }> {
    // The outcome is CAPTURED rather than returned by each branch, because the branches
    // already report it — every exit closes its stage with a sentence, and a second copy
    // assembled at the return would be a second thing to keep true. Watched live: `/review`
    // on a session with no contract opened and closed its stage inside a second, so the only
    // account of what happened flashed past in a status line and the person was left with
    // silence. A gate somebody ASKED for has to answer.
    let outcome = 'done'
    // Whether the gate put a ROW in the transcript. The caller needs this to decide whether
    // to say anything itself, and it cannot be inferred from the turn: a build that passes
    // runs no fixer, so it returns zero steps and empty text — which the first version read
    // as "nothing happened" and announced "/check: passed" as an error note, under the
    // green verify row that had just said the same thing. Reported, not guessed.
    let reported = false
    const outerVerify = this.opts.onVerify
    const outerAccept = this.opts.onAcceptance
    this.opts.onVerify = (info) => { reported = true; outerVerify?.(info) }
    this.opts.onAcceptance = (info) => { reported = true; outerAccept?.(info) }

    const outer = this.opts.onStage
    this.opts.onStage = (info) => {
      if (info.state === 'done' && info.outcome !== undefined) outcome = info.outcome
      outer?.(info)
    }
    try {
      return { turn: await this.runGateInner(which, signal), outcome, reported }
    } finally {
      if (outerVerify === undefined) delete this.opts.onVerify
      else this.opts.onVerify = outerVerify
      if (outerAccept === undefined) delete this.opts.onAcceptance
      else this.opts.onAcceptance = outerAccept
      // Deleted rather than assigned back: `exactOptionalPropertyTypes` treats an explicit
      // `undefined` as a different thing from an absent key, and this option is optional.
      if (outer === undefined) delete this.opts.onStage
      else this.opts.onStage = outer
    }
  }

  private async runGateInner(which: 'build' | 'review', signal?: AbortSignal): Promise<TurnResult> {
    // A synthetic "done" turn: the gates all key off `stoppedBecause === 'done'`, which is
    // their way of saying "the model believes it has finished" — and being asked by hand is
    // a stronger version of the same claim.
    const asked: TurnResult = { steps: 0, finalText: '', stoppedBecause: 'done' }

    if (which === 'build') {
      let current = asked
      const jobs = this.verifyJobs(true)
      if (jobs.length === 0) {
        const endStage = this.beginStage('build', 'looking for a check to run')
        endStage('no verify command is configured for this workspace')
        return current
      }
      for (const job of jobs) current = await this.verifyOne(job, current, signal)
      return current
    }

    const contract = this.meta.contract
    if (contract === undefined) {
      const endStage = this.beginStage('review', 'looking for a change to review')
      endStage('no contract on this session — there is nothing to review it against')
      return asked
    }
    // `satisfied` would make `freshReview` skip its own guard chain; cleared so an explicit
    // ask always runs. The flag means "the gates decided this is finished", and the person
    // asking again is overriding exactly that.
    contract.satisfied = false
    return await this.freshReview(contract, asked, signal)
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
    return {
      // Both figures corrected the way `maybeCompact` corrects them, and that is the whole
      // point of routing them through here: for a long time the status bar divided a RAW
      // count by the window while the compaction gate divided a corrected one, so the bar
      // could read comfortably while the gate was about to fire. Two numbers for one
      // question, and the one on screen was the wrong one.
      //
      // A measured count is ground truth for the moment it was taken and blind to
      // everything appended since — a batched step's tool results above all. An estimate
      // over the transcript misses the tool schemas, which are sent with every request.
      promptTokens: this.usedTokens(true),
      approxTokens: this.usedTokens(false) ?? this.approxTokens() + TOOL_SCHEMA_TOKENS,
    }
  }

  /**
   * How full the window actually is, by the same arithmetic the compaction gate uses.
   *
   * `measuredOnly` picks which of the two answers is wanted: the server's count brought up
   * to date (null before the first step), or the transcript estimate. Extracted so the gate
   * and the readout cannot drift apart again — they had, and the drift was invisible because
   * each looked right on its own.
   */
  private usedTokens(measuredOnly: boolean): number | null {
    if (this.latestPromptTokens === null) {
      return measuredOnly ? null : this.approxTokens() + TOOL_SCHEMA_TOKENS
    }
    const appendedSince = Math.max(0, this.transcriptChars() - this.charsAtPromptCount)
    return this.latestPromptTokens + Math.ceil(appendedSince / 4)
  }

  /**
   * The token count at which this session will compact, so the readout can colour by
   * distance to the thing that is actually about to happen.
   *
   * Without it the bar's only warning is at 80% of the window, while the default absolute
   * trigger fires at 140k — 53% of this machine's 262k. The bar read half full and calm and
   * then the conversation compacted underneath it, which is precisely the surprise the
   * readout exists to prevent. Null when nothing will trigger.
   */
  compactAt(): number | null {
    const cfg = this.opts.compaction
    if (!cfg) return null
    const byRatio = (cfg.triggerRatio ?? 0.8) * cfg.contextLength
    return cfg.triggerTokens === undefined ? byRatio : Math.min(byRatio, cfg.triggerTokens)
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
   *
   * That half also has to carry the settings that are NOT derived from the window. Merging
   * only `contextLength` into nothing produced a config with no `triggerTokens` at all, so
   * the session switched on here ran on the 0.8 ratio alone — first compacting near 210k on
   * a 262k window, past the stash cliff `DEFAULT_TRIGGER_TOKENS` documents, and dropping any
   * `"compaction": { "triggerTokens": N }` the user had set. Options that already exist are
   * merged over, exactly as before; only the built-from-nothing case gained a floor.
   */
  setContextLength(contextLength: number): void {
    if (!Number.isFinite(contextLength) || contextLength <= 0) return
    const base: Omit<CompactionOptions, 'contextLength'> = this.opts.compaction ??
      this.opts.compactionDefaults ?? { triggerTokens: DEFAULT_TRIGGER_TOKENS }
    this.opts.compaction = { ...base, contextLength }
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
        this.promptTokensFromRefusal = false
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
        this.noteModelRanVerify(name, this.lastToolArgs.get(name))
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
  async send(
    text: string, signal?: AbortSignal, sendOpts?: {
      /** Whether this text is a user-authored task worth distilling a contract from.
       * Callers that KNOW (the host sees the raw typed text before attachments inflate
       * it; the unattended runner knows a nudge from the task) say so; absent falls back
       * to the text heuristic. */
      distill?: boolean
    },
  ): Promise<TurnResult> {
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
      // The task contract, distilled before a task-shaped request runs — see contract.ts
      // for the whole design. AFTER buildAgent, so a fresh session already has its system
      // message (the distiller reads the transcript, and the note must never land above
      // message 0); appended to the tail, which never disturbs the prompt cache; promoted
      // into the system prompt at every compaction swap.
      //
      // EVERY task-shaped message re-distills and REPLACES: a session outlives its first
      // task, and a second big request judged against the first request's criteria is a
      // gate enforcing yesterday's goal. Short follow-ups ("and fix the indent too") are not
      // task-shaped, so a running task's contract survives them. A failed or refused
      // distillation costs nothing: the task runs exactly as every task ran before
      // contracts existed.
      // Only when the CALLER says this is a user-authored task (the host filters out
      // attachment-inflated texts, the unattended runner marks its own nudges): every
      // continuation nudge is ≥80 chars of multi-sentence prose, and the heuristic alone
      // re-distilled — and REPLACED — the real contract from a nudge, once per turn, all
      // night. Undefined means "decide from the text", which is what the CLI and tests get.
      // For the undelivered-abort rollback below: a contract distilled for a message that
      // then never reached the transcript describes work the model was never asked for,
      // and left in place it would gate every later turn against a phantom task.
      const contractBefore = this.meta.contract
      // For the same rollback: a plan seeded for a message that never reached the
      // transcript describes work that was never asked for.
      const todosBefore = this.opts.toolset.todos?.list()
      let turnText = userText
      if ((sendOpts?.distill ?? looksLikeTask(text)) && looksLikeTask(text)) {
        // The very first thing a long message pays for, and it happens BEFORE the model
        // says a word — so on a task-shaped request the window's first ten to sixty
        // seconds used to be blank. Naming it is most of the fix.
        const endDistill = this.beginStage('contract', 'working out what you asked for')
        const contract = await distillContract(
          this.opts.client, this.transcript.messages(), userText, signal, this.stepSchemas(),
        )
        endDistill(contract === null
          ? 'no contract — the turn runs without one'
          : `${contract.criteria?.length ?? 0} criteri${(contract.criteria?.length ?? 0) === 1 ? 'on' : 'a'}`)
        if (contract !== null) {
          // The user's own words ride along with the distillation of them: the understanding
          // check reads the request, never the summary, because a summary is where the
          // misreading would already have happened.
          contract.request = userText
          this.meta.contract = contract
          this.opts.store?.saveMeta(this.meta)
          // The plan appears WITH the contract, every time — not when the model feels
          // like calling todo_write (measured: it almost never does unprompted).
          await this.seedTodos(contract, signal)
          // Folded INTO the user message, not appended beside it: two adjacent user
          // messages deviate from the chat template (the setMode note records the same
          // rule), and the note explicitly describes "the request that follows".
          turnText = `[${renderContract(contract)}]\n\n${userText}`
        }
      }
      // Captured AFTER buildAgent() (which may append the system prompt on a fresh
      // transcript) and BEFORE runTurn(), so a length comparison after the call tells us,
      // directly, whether the user message actually reached the transcript.
      const beforeCount = this.transcript.messages().length
      this.turnStartIndex = beforeCount
      // `writeCount` is cumulative across the session (the unattended idle check needs it
      // that way), so "did THIS turn change anything" is a difference, not a value.
      const writesBefore = this.writeCount
      // Cleared only when everything written so far HAS been verified. A turn that wrote and
      // was then aborted never reaches `verifyAndFix` (it returns early on
      // `stoppedBecause !== 'done'`), so an unconditional clear here dropped the folder on
      // the floor: measured, turn 1 wrote and aborted, turn 2 wrote nothing and said "all
      // done", and the project's check never ran over the file turn 1 left behind while the
      // contract retired satisfied. `writesAtLastVerify` is the discipline `writeCount`
      // already uses for exactly this; the folder set now follows it.
      if (this.writeCount === this.writesAtLastVerify) this.writtenMounts.clear()
      let result: TurnResult
      try {
        result = await agent.runTurn(turnText)
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
        this.promptTokensFromRefusal = true
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
      // `this.turnStartIndex`, not `beforeCount`: a mid-turn compaction swap replaces the
      // transcript object and remaps the field to the new object's coordinates, while the
      // captured local would silently index past the end of a ten-message transcript.
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
      const undelivered = result.stoppedBecause === 'aborted' &&
        this.transcript.messages().length === beforeCount
      if (undelivered && note !== undefined) {
        this.pendingModeNote = note
      }
      if (undelivered) {
        // The message never reached the transcript, so everything derived from it rolls
        // back with it: the contract (or the next turns are gated on a phantom task) and
        // the title claim below (or an empty session is named after words the model never
        // saw — watched live: Esc during distillation left "Stopped by you… continues
        // from here" over a transcript holding only the system message, and an F5 later
        // the row was gone while the title still quoted it). The result carries
        // `delivered: false` so the front end can un-render its optimistic row and give
        // the text back to the composer instead of promising a continuation.
        if (this.meta.contract !== contractBefore) {
          if (contractBefore === undefined) delete this.meta.contract
          else this.meta.contract = contractBefore
          this.opts.store?.saveMeta(this.meta)
        }
        // The seeded plan rides the same rollback: left in place it would gate later
        // turns (plan focus, upkeep) against a task the model was never given.
        const todoStore = this.opts.toolset.todos
        if (todoStore !== undefined && todosBefore !== undefined &&
            todoStore.list() !== todosBefore) {
          todoStore.set([...todosBefore])
          this.opts.interaction?.todosChanged?.(todoStore.list())
        }
        result = { ...result, delivered: false }
      }

      if (!this.titled && !undelivered) {
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
          if (this.lastVerifyFingerprint.get(job.folder ?? '') !== 'ok') {
            this.lastVerifyFingerprint.set(job.folder ?? '', 'ok')
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
        if (fingerprint === this.lastVerifyFingerprint.get(job.folder ?? '')) {
          this.transcript.append({
            role: 'user',
            content: `[${where}${job.spec.command}: still failing, same errors as before.]`,
          })
          return
        }
        this.lastVerifyFingerprint.set(job.folder ?? '', fingerprint)
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

  /**
   * Narrows the frame to the plan item in progress, by APPEND and only on change.
   *
   * On a long multi-item turn the plan sits in one `todo_write` result far up the
   * transcript; small models do measurably better when the current item is IN FRONT of
   * them rather than forty steps behind. The harness does the pointing — the one lesson
   * this project has measured over and over is that asking the model to keep referring
   * back does nothing, while putting the information in front of it works.
   *
   * Injected only when the in-progress item CHANGED since the last injection (the exact
   * dedup rule the verify success note follows): a note repeated every step is noise the
   * model learns to skim past, and skimming is the failure this exists to prevent.
   */
  private injectPlanFocus(): void {
    // Only while an ACTIVE contract task runs: the todo store is per workspace and
    // outlives tasks, and a new small request re-pointed at the previous task's stale
    // plan read as an instruction to resume it.
    if (this.meta.contract === undefined || this.meta.contract.satisfied === true) return
    const todos = this.opts.toolset.todos?.list() ?? []
    if (todos.length < 2) return // a one-item plan IS its own focus
    const current = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending')
    if (current === undefined) return
    const open = todos.filter((t) => t.status !== 'completed').length
    // Keyed on the ITEM alone: keying on the open-count too re-announced an unchanged
    // item every time any other item completed.
    const key = current.text
    if (key === this.lastPlanFocus) return
    this.lastPlanFocus = key
    const position = todos.indexOf(current) + 1
    this.transcript.append({
      role: 'user',
      content:
        `[Plan focus — step ${position} of ${todos.length}: ${current.text}` +
        (current.done_when !== undefined ? ` (done when: ${current.done_when})` : '') +
        `. Open: ${open}. Finish this one before the next, and when it is done say so with ` +
        `\`todo_write\` \`complete: [${position}]\` — that is the whole call.]`,
    })
  }

  /**
   * The plan appears WITH the contract — piece one of the todo discipline. The model
   * works measurably better with a plan in front of it, and calling todo_write on its
   * own is exactly the kind of ask that measured 0/703 from the system prompt — so the
   * harness writes the first draft itself. For a small task the criteria ARE the plan
   * (checkable by construction, zero extra requests); a big one — many criteria, or
   * agreed seams between files — earns one forced decomposition call whose schema
   * requires a done_when per step. An existing plan with open items is NEVER clobbered:
   * a follow-up task inside one session continues the plan the model is holding.
   */
  private async seedTodos(contract: TaskContract, signal?: AbortSignal): Promise<void> {
    const store = this.opts.toolset.todos
    if (store === undefined) return
    if (store.list().some((t) => t.status !== 'completed')) return
    if (!Array.isArray(contract.criteria) || contract.criteria.length === 0) return
    const big = contract.criteria.length >= 4 || contract.interfaces !== undefined
    if (big) {
      const planned = await decomposeTodos(
        this.opts.client, this.transcript.messages(), contract, signal, this.stepSchemas(),
      )
      if (planned !== null) {
        store.set(planned)
        this.opts.interaction?.todosChanged?.(store.list())
        this.syncUpkeepMarkers()
        return
      }
    }
    store.set(contract.criteria.map((c) => ({ text: clipTodoText(c), status: 'pending' as const })))
    this.opts.interaction?.todosChanged?.(store.list())
    this.syncUpkeepMarkers()
  }

  /**
   * Runs a HARNESS-issued turn (an acceptance fixer, a review fixer, a premise re-read) with
   * the same context-overflow recovery `send` gives the user's own turn.
   *
   * Those four call sites were bare awaits. The window survives a throw from them —
   * `send-failed` renders — but an unattended run does not: it classifies any throw it does
   * not recognise as a transport failure and re-sends into the same over-full transcript,
   * with `latestPromptTokens` never corrected, so three genuine overflows were reported as
   * `server-unreachable` against a server that was answering perfectly. It also skips
   * `recordTurn`, the meta save and the tail flush on the way out.
   *
   * The recovery is the same shape as the main path's: believe the server's own number,
   * compact on it, and continue rather than re-sending a message the transcript already has.
   */
  private async runHarnessTurn(text: string, signal?: AbortSignal): Promise<TurnResult> {
    try {
      return await this.buildAgent(signal).runTurn(text)
    } catch (e) {
      const measured = contextOverflowTokens(e)
      if (measured === null) throw e
      this.latestPromptTokens = measured
      this.promptTokensFromRefusal = true
      await this.compactNow(signal)
      // The retry is wrapped, exactly as `send`'s is. It was not, so when compaction could
      // not make room the second refusal escaped as a raw `HTTP 400` — the same failure
      // `send` goes out of its way to name. Measured with the real 400 body on both turns:
      // `onCompaction {"state":"postponed","reason":"nothing-to-gain"}` and then
      // `SEND THREW: LlamaRequestError | llama.cpp request failed: HTTP 400`, with nothing
      // persisted. The code's own comment calls this path normally unreachable; a session
      // recorded before the per-step budget existed can still resume into it.
      try {
        return await this.buildAgent(signal).runTurn(OVERFLOW_RETRY_NOTE)
      } catch (retryError) {
        const still = contextOverflowTokens(retryError)
        if (still === null) throw retryError
        throw new Error(
          `the conversation's most recent messages alone are ${still} tokens against a ` +
          `${this.opts.compaction?.contextLength ?? 'smaller'}-token window, so compaction cannot make room. ` +
          'Start a new session; this tail cannot be replayed.',
        )
      }
    }
  }

  /**
   * Piece three, harness half: the audit already decided which criteria hold, and a
   * scaffolded item IS a criterion verbatim — so its checkbox is the audit's to tick,
   * not the model's to remember. Decomposed and model-written items are untouched:
   * their texts match no criterion.
   *
   * The report is resolved to criterion POSITIONS by the same matcher `renderCheckedState`
   * uses, so the contract note the model reads and the Plan card the user reads can never
   * tell different stories about the same audit.
   */
  private syncTodosWithAudit(contract: TaskContract, report: AcceptanceReport): void {
    const store = this.opts.toolset.todos
    if (store === undefined) return
    const criteria = Array.isArray(contract.criteria) ? contract.criteria : []
    const { unmetByIndex, unmatched } = resolveReportedCriteria(criteria, report)
    // A reported gap that names no criterion we can place could belong to any of them, so
    // there is nothing here that can be ticked honestly. Ticking the others anyway is how
    // the card came to show every step done while the fix round was still running.
    if (unmatched.length > 0) return
    const met = new Set(
      criteria.filter((_c, i) => !unmetByIndex.has(i)).map((c) => clipTodoText(c)),
    )
    // Un-ticking happens only on a gap the audit ASSERTED, never on one it merely failed to
    // mention. `withUnreportedCriteria` fills the silence by appending the criterion verbatim
    // — which is what makes the gate hold the task open, correctly — but verbatim means it
    // MATCHES, so it lands in `unmetByIndex` indistinguishable from a real finding, and the
    // step the user watched complete flipped back to pending because one paraphrase in the
    // report could not be placed. "Not audited this round" is not evidence that the work came
    // undone; the gate still refuses to close, which is where that doubt belongs.
    const unmet = new Set(
      criteria
        .filter((_c, i) => unmetByIndex.get(i) !== undefined && unmetByIndex.get(i) !== UNREPORTED_REASON)
        .map((c) => clipTodoText(c)),
    )
    if (met.size === 0 && unmet.size === 0) return
    let changed = false
    const next = store.list().map((t) => {
      // Both directions, because the audit can change its mind and `checkedState` already
      // does: it is recomputed whole every round, while a ticked box used to be permanent.
      // Round 2 downgrading a criterion left the user reading a 4/4 Plan card beside a note
      // saying criterion 2 is UNMET — and worse, `planFinished` then reads that card as
      // complete forever, so every later turn in the session opens an audit whether or not
      // anything claimed to be done. Only scaffolded items are touched either way: a
      // decomposed or model-written item's text matches no criterion.
      if (unmet.has(t.text) && t.status === 'completed') {
        changed = true
        return { ...t, status: 'pending' as const }
      }
      if (t.status === 'completed' || !met.has(t.text)) return { ...t }
      changed = true
      return { ...t, status: 'completed' as const }
    })
    if (!changed) return
    store.set(next)
    this.opts.interaction?.todosChanged?.(store.list())
  }

  /**
   * Piece three, injection half: a stretch of writes with the plan untouched gets one
   * explicit order to bring it up to date. Watching the store VERSION, not content — the
   * model re-affirming the same list still counts as having tended it — and re-arming
   * only after either another such stretch or a real update, so this can never become
   * the every-step nag the model learns to skim.
   */
  private injectPlanUpkeep(): void {
    const store = this.opts.toolset.todos
    if (store === undefined) return
    if (this.meta.contract === undefined || this.meta.contract.satisfied === true) return
    if (store.list().filter((t) => t.status !== 'completed').length < 2) return
    if (store.version !== this.lastTodoVersion) {
      this.syncUpkeepMarkers()
      return
    }
    const writes = this.writeCount - this.writesAtLastUpkeep
    if (writes < UPKEEP_WRITES) return
    this.writesAtLastUpkeep = this.writeCount
    this.transcript.append({
      role: 'user',
      content:
        `[Plan upkeep: ${writes} files written since the plan was last updated.\n` +
        `${renderPlanLines(store.list())}\n` +
        'Bring it up to date now — `todo_write` with `complete: [n]` for the steps that are ' +
        'finished, `start: n` for the one you are on, `add` for anything this work ' +
        'uncovered. Send only what changed; do not re-send the list. ' +
        'The plan is what survives compaction; a stale plan is lost work.]',
    })
  }

  /** Re-arm both upkeep watermarks to "now": after seeding, and after any todo_write. */
  private syncUpkeepMarkers(): void {
    this.lastTodoVersion = this.opts.toolset.todos?.version ?? 0
    this.writesAtLastUpkeep = this.writeCount
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
  /**
   * The composer's suggestion chips: the DRAFT, run through the improver with the same
   * transcript context a send would carry, so a continuation draft is understood against
   * the session. A preview and nothing more: the session's own contract, meta and
   * transcript are untouched, because the draft may never be sent. Null when the model
   * declines or suggests nothing — the caller keeps its quiet lint chips, never an error.
   */
  async previewSuggestions(text: string, signal?: AbortSignal): Promise<DraftSuggestions | null> {
    return improveDraft(this.opts.client, this.previewContext(), text, signal, this.stepSchemas())
  }

  /** The composer's expand preview: a rough command grown into a detailed brief from the
   * same context a send would carry (message 0's repo map and notes included). A preview
   * and nothing more, exactly like `previewSuggestions` above. */
  async previewExpansion(text: string, signal?: AbortSignal): Promise<string | null> {
    return expandDraft(this.opts.client, this.previewContext(), text, signal, this.stepSchemas())
  }

  /**
   * One reply the person might send, for the composer's ghost text.
   *
   * Same context as an expansion and for the same reason — a suggestion made without the
   * conversation would be a guess dressed as a reading. Null whenever the model declines,
   * which the composer treats as "no suggestion" rather than as a failure: there is nothing
   * to recover from and nothing worth interrupting anybody about.
   */
  async suggestNextReply(signal?: AbortSignal): Promise<string | null> {
    return suggestReply(this.opts.client, this.previewContext(), signal, this.stepSchemas())
  }

  /**
   * What a preview request is allowed to know. A FRESH session's transcript is seeded by
   * the Agent at the first send — so a preview fired before any turn saw no system
   * message at all: no repo map, no notes, no folder list. Watched live: the expander,
   * asked in an untouched workspace, confidently briefed against `src/App.tsx` — a file
   * that exists nowhere in the mounts, invented from training priors the instant the
   * context stopped saying otherwise. Built per call and NOT appended to the transcript:
   * a preview must leave the session exactly as it found it.
   */
  private previewContext(): ChatMessage[] {
    const messages = [...this.transcript.messages()]
    if (messages.length > 0 && messages[0]!.role === 'system') return messages
    return [{
      role: 'system',
      content: buildSystemPrompt({
        workspaceRoot: this.workspace.root,
        mode: this.meta.mode,
        external: this.externalSurfaces(),
        ...(this.memoryText !== undefined ? { memory: this.memoryText } : {}),
        ...(this.notesText !== undefined ? { notes: this.notesText } : {}),
        ...(this.skillsText !== undefined ? { skills: this.skillsText } : {}),
        ...(this.repoMapText !== undefined ? { repoMap: this.repoMapText } : {}),
        ...(this.schemaText !== undefined ? { databaseSchema: this.schemaText } : {}),
        ...(this.meta.contract !== undefined && this.meta.contract.satisfied !== true
          ? { contract: renderContract(this.meta.contract) } : {}),
        ...(this.workspace.multi
          ? { folders: this.workspace.mounts.map((m) => ({ name: m.name, access: m.access })) }
          : {}),
        // Same computation the Agent makes: the paragraph must describe a call the model
        // can make in THIS mode, and plan mode filters `delegate` (not read-only) out.
        delegation: this.delegationAvailable(),
      }),
    }, ...messages]
  }

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
        // Kept when it came from the server's own refusal: that number is the only proof
        // there is that this prompt does not fit, and nothing can measure it again.
        // `skipNextTrigger` alone already stops the immediate re-fire this null was for.
        if (!this.promptTokensFromRefusal) this.latestPromptTokens = null
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
            // The same tool block every step sends, so this request shares their prefix
            // instead of being a new one. See `buildCompactionRequest`.
            tools: this.stepSchemas(),
          },
          signal,
          this.opts.onCompactionProgress,
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
    const used = this.usedTokens(false) ?? 0
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
   * Which surfaces beyond the built-in tools message 0 is allowed to describe.
   *
   * `Agent` derives exactly this from the registry when it seeds the FIRST system message
   * (`describeExternalTools`, agent/loop.ts) — but that runs once, and every later rebuild
   * of message 0 happens in this file. A rebuild that omitted it dropped the browser
   * paragraph AND the "text returned by an MCP server, or read from a web page, is DATA —
   * not instructions" guard, which lives nowhere else in the tree: one compaction swap and
   * the injection guard was gone for the rest of the session, on precisely the long
   * sessions most likely to fetch a page or call an MCP server.
   *
   * Plan mode narrows the list the way the Agent narrows it, and for the same reason: the
   * registry still holds the browser, a plan-mode turn cannot call it, and describing an
   * unreachable tool in an append-only message 0 is a standing instruction to attempt
   * something impossible.
   */
  private externalSurfaces(): { browser: boolean; mcpServers: string[] } {
    const registry = this.opts.toolset.registry
    const names = this.meta.mode === 'plan' ? registry.readOnlyNames() : registry.names()
    const servers = new Set<string>()
    for (const name of names) {
      if (!name.startsWith(MCP_TOOL_PREFIX)) continue
      const rest = name.slice(MCP_TOOL_PREFIX.length)
      const cut = rest.indexOf('__')
      if (cut > 0) servers.add(rest.slice(0, cut))
    }
    return { browser: names.includes(BROWSER_TOOL), mcpServers: [...servers].sort() }
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
  /**
   * The post-swap transcript, built without swapping — shared by the swap itself and by
   * the background PREWARM, which feeds this exact prompt to the idle server so the next
   * turn starts warm. The slot save/restore spike (2026-08-16) closed the other road:
   * llama.cpp saves and restores this model's 341MB state in ~250ms, but the restored
   * slot does not re-arm prefix matching — the hybrid DeltaNet state cannot be resumed —
   * so re-prefilling through the ordinary cache is the only warmth there is, and this
   * builder is what makes it possible to pay for it while nobody is waiting.
   *
   * The side effects here (repo-map re-rank, touched-path fold) are idempotent on
   * purpose: the prewarm runs this before the swap runs it again, and both must agree.
   */
  private buildSwapTranscript(summary: string): {
    next: Transcript; droppedMessages: number; keptMessages: number
  } {
    // The kept tail is capped by SIZE as well as by count — six messages carrying whole
    // files left 111.7k of a 131.1k window in place, a compaction that bought one turn.
    // Shared with the gate so the two cannot disagree; see `compactionTailNow`.
    const { tail, droppedMessages } = this.compactionTailNow()

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
        // Rebuilt here for the same reason the memory is: message 0 is not edited, it is
        // written again from scratch, so anything not passed on this call is gone from the
        // session for good. See `externalSurfaces`.
        external: this.externalSurfaces(),
        ...(this.memoryText !== undefined ? { memory: this.memoryText } : {}),
        ...(this.notesText !== undefined ? { notes: this.notesText } : {}),
        ...(this.skillsText !== undefined ? { skills: this.skillsText } : {}),
        ...(this.repoMapText !== undefined ? { repoMap: this.repoMapText } : {}),
        ...(this.schemaText !== undefined ? { databaseSchema: this.schemaText } : {}),
        // The contract's promotion — the tail note that announced it is usually in the
        // summarised middle by now, and this is what makes losing it impossible. A
        // satisfied contract is history, not standing orders, and stays out.
        ...(this.meta.contract !== undefined && this.meta.contract.satisfied !== true
          ? { contract: renderContract(this.meta.contract) } : {}),
        ...(this.workspace.multi
          ? { folders: this.workspace.mounts.map((m) => ({ name: m.name, access: m.access })) }
          : {}),
        // Same computation the Agent makes: the paragraph must describe a call the model
        // can make in THIS mode, and plan mode filters `delegate` (not read-only) out.
        delegation: this.delegationAvailable(),
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
    return { next, droppedMessages, keptMessages: tail.length }
  }

  private applyCompactionSwap(summary: string): boolean {
    // Everything the model was shown is gone with the transcript it was shown in. Keeping
    // the read memory across a swap would make "unchanged since you read it" true and
    // useless — the text it refers to no longer exists in the context — and would make a
    // diff a fragment of something the model can no longer see. This one line is the
    // correctness condition for the whole cheap-repeat-read idea.
    this.opts.toolset.reads?.clear()

    const { next, droppedMessages, keptMessages } = this.buildSwapTranscript(summary)

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
      this.promptTokensFromRefusal = false
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
    // The fill warnings arm again, because the thing they warn about has just happened and
    // will happen again. They were a once-per-SESSION set, and the doc for them said so
    // deliberately — but the nudge is "the window is filling, write down anything that must
    // survive", which is advice about an imminent event, not a fact about the session. After
    // the first compaction every later cycle was silent, so on a long run the one warning
    // that matters was the one nobody was there for. Per-CYCLE keeps the anti-nag intent
    // (still at most one per mark, per cycle) and drops the part that made it useless.
    this.fillMarksSeen.clear()
    // The swap rewrote the prefix: nothing the server cached still matches, and the next
    // request pays a full prefill.
    this.promptCacheCold = true
    // fillRatio must wait for a real measurement against the NEW transcript -- the stale
    // pre-swap prompt-token count would otherwise immediately look "still over threshold"
    // against the just-shrunk transcript and re-trigger a pointless compaction of the
    // transcript this very call just produced.
    this.latestPromptTokens = null
    // A swap makes a different prompt, so a refusal of the OLD one says nothing about it.
    this.promptTokensFromRefusal = false
    // The swap dropped whatever plan-focus note was in the middle; the next boundary
    // re-points the frame against the fresh transcript.
    this.lastPlanFocus = null
    // The turn's messages now live in the kept tail of a much shorter object. The first
    // KEPT message is the honest start: everything from there on is recent work.
    //
    // Derived, not the literal 3 this used to be, because the preamble is not always three
    // messages: the ack is skipped when the tail already opens on an assistant message,
    // which is the ordinary shape of a mid-turn boundary (see `buildSwapTranscript`). In
    // that case the first kept message sits at index 2, and clamping to 3 dropped it — so
    // when it carried the turn's `write_file` calls, the created-file bodies (the only
    // source `turnDiffText` has for a new file) were silently missing from the diff review.
    const tailStart = next.messages().length - keptMessages
    this.turnStartIndex = Math.min(this.turnStartIndex, tailStart)
    this.opts.onCompaction?.({
      state: 'applied',
      droppedMessages,
      detail: {
        beforeTokens: oldApproxTokens,
        afterTokens: next.approxTokens(),
        summary,
        keptMessages,
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
    // Whichever fires first: the window share, or the absolute rot threshold the probe
    // calibrated. `fillRatio` is server-truth-based; the absolute check reads the same
    // truth back in tokens.
    const overTokens = cfg.triggerTokens !== undefined && ratio !== null &&
      ratio * cfg.contextLength >= cfg.triggerTokens
    if (ratio === null || (ratio < triggerRatio && !overTokens)) return

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
        {
          messages,
          workspaceRoot: this.opts.workspaceRoot,
          budgetTokens: this.summaryBudget(),
          tools: this.stepSchemas(),
        },
        signal,
        this.opts.onCompactionProgress,
      )
      this.pendingSummary = result.summary
      // PREWARM, while the slot is idle and the summary waits for its swap: feed the
      // post-swap prompt to the server as a one-token request, so the next turn's first
      // step re-prefills nothing instead of the measured ~43k/98s that once killed a
      // session on its step timeout. Inside the in-flight window on purpose — a send()
      // arriving now aborts this exactly like it aborts the summary generation. A failed
      // or aborted prewarm costs nothing: the ready summary swaps in either way, merely
      // cold, which is yesterday's status quo.
      try {
        const { next } = this.buildSwapTranscript(result.summary)
        await this.opts.client.chat({
          messages: [...next.messages()],
          // The SAME tool list the real steps send: the rendered tool schemas are part of
          // the prompt, so a prewarm without them warms a prompt no step will ever send.
          tools: this.stepSchemas(),
          maxTokens: 1, disableThinking: true, signal,
        })
        // The server cache now holds the post-swap prefix — the next step is warm.
        this.compactionDisplacedCache = false
        this.promptCacheCold = false
      } catch { /* warmth is a bonus, never a requirement */ }
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

  /*
   * THE LOOP DETECTOR IS OFF, by the owner's decision, and this is where it was switched on.
   *
   * What it was for is still real: a model that re-runs the same failing command once per
   * turn for an hour looks reasonable inside each turn, and nothing else bounds a night.
   * `LoopDetector` and its tests are untouched, and re-wiring it is this one line.
   *
   * Why it had to go, reported from use: it blocked re-reading a file that had genuinely
   * changed. The class doc says the signal is the RESULT, not the call, precisely so that
   * re-reading after an edit stays allowed — but `stableResult` compares only the first 400
   * characters (`RESULT_PREFIX`). An edit below that point, whether the model made it or the
   * owner made it in another editor, leaves the compared window identical, so a file that had
   * really changed read as "the same answer again" and the third read was refused. Anything
   * that returns a large result is affected the same way; `read_file` is simply where it
   * shows, because re-reading is the correct move after any change.
   *
   * The narrow fix, if this is ever revisited: compare a hash of the WHOLE result rather than
   * a prefix — the reason given for the prefix (cost) is a hash over a string already in
   * memory, which is not a real cost — or exempt the read family outright.
   */

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
  /**
   * The last verify outcome PER FOLDER, so a multi-folder workspace can dedup at all.
   *
   * One shared slot was enough while a workspace had one check. With two writable folders it
   * defeats itself: `api` green stores 'ok', `web` red stores its fingerprint, the next `api`
   * run overwrites it with 'ok' again — so `web`'s unchanged failure never matches, and its
   * full build log is re-appended at EVERY write boundary. In an append-only transcript that
   * is roughly 16k prompt tokens per refactor that nothing can reclaim, restating errors the
   * model has already read a dozen times. The value already carried `job.folder`; only the
   * storage did not.
   */
  private lastVerifyFingerprint = new Map<string, string>()
  /** Identity of the last plan-focus note injected, so the frame is re-pointed only when
   * the in-progress item actually changes. See `injectPlanFocus`. */
  private lastPlanFocus: string | null = null
  /** Upkeep watermarks — the todo-store version and the write count at the last moment
   * the plan was known fresh. See `injectPlanUpkeep`/`syncUpkeepMarkers`. */
  private lastTodoVersion = 0
  private writesAtLastUpkeep = 0
  /** Where THIS turn's messages start in the CURRENT transcript object — remapped at every
   * compaction swap, which is what a captured local index cannot do. */
  private turnStartIndex = 0
  /** How many contract criteria the last acceptance check left unmet, for the unattended
   * runner's honesty: a run must not end 'done' on a turn the gate knows failed. */
  /** `null` = a gate was attempted and could not run. See `lastAcceptanceUnmet`. */
  private lastUnmetCount: number | null = 0
  /** Set the first time a check is measured slow; from then on it is time-gated again. */
  private verifySlow = false
  private lastVerifyAtMs = 0
  /** Fill marks already announced, so each is said once per session and never again. */
  /** Cleared at every compaction swap — see `applyCompactionSwap`. Per CYCLE, not per
   * session: the warning is about an imminent compaction, and there is one every cycle. */
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
    // The shared counter, not a private copy. Tool-call ARGUMENTS are the reason this number
    // exists and the part every private copy forgot; keeping one implementation is what stops
    // the next one from forgetting them again. See `messageChars`.
    return transcriptChars(this.transcript.messages())
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

  /**
   * Exactly the tool schemas the next step will send — including plan mode's narrowing.
   *
   * The comment two lines above the prewarm's `tools:` states the invariant correctly and
   * the code did not hold it: `buildAgent` never passes `allowedTools`, so `Agent` narrows
   * plan mode to the registry's `readOnlyNames()` itself and sends 11 schemas, while the
   * prewarm sent all 21. That difference (~8.1k chars, ~2k tokens) sits INSIDE the system
   * block at the very front of the prompt, so the prewarmed prefix matched nothing from
   * token 0 and the full re-prefill was paid twice — once wasted on the prewarm, once on
   * the user's clock. Roughly 55 s of GPU per plan-mode compaction, for a warm-up that
   * could not warm anything.
   *
   * Mirrors `Agent`'s own rule rather than restating it: the mode this reads is the one
   * `buildAgent` resolves, and `Agent` derives the list from the tools' own `readOnly`
   * declarations, so neither side has a hand-kept list to drift.
   */
  private stepSchemas(): import('../llama/types.js').ToolSchema[] {
    const registry = this.opts.toolset.registry
    return this.meta.mode === 'plan'
      ? registry.schemas(registry.readOnlyNames())
      : registry.schemas()
  }

  /**
   * Runs one narrow job in a worker with its own conversation — see `agent/subagent.ts`.
   *
   * Lives here because the session owns the client, the registry and the window size, and
   * because a worker must inherit the same step-result ceiling the main agent gets: one of
   * its steps can batch several reads at 60,000 characters each, and appending that on top
   * of a brief is how a request reaches the server's window limit and 400s.
   *
   * An unknown role is a message and not a throw. The tool validates against `ROLE_NAMES`
   * before it ever gets here, so reaching this line means something else called it — and a
   * caller that got the name wrong is better told than crashed.
   */
  /**
   * The worker's events, relabelled as the worker's.
   *
   * A worker was handed the caller's whole event set, so its reads and its writes arrived on
   * the same channels as the main model's and were indistinguishable from them on screen —
   * the owner's words: "you cannot tell where the sub-agent is acting and where the main
   * model is". Two different fixes, because the two kinds of event are wrong in two
   * different ways.
   *
   * ACTIONS are relabelled, not hidden. A worker reading eight files is the most useful
   * thing on screen during a delegation, and the only problem with those rows was the name
   * on them. They now carry the role, and the window indents them under the `delegate` call
   * that caused them.
   *
   * SPEECH is dropped. A worker's reasoning and its prose were streamed into the assistant
   * message the MAIN model is writing — not mislabelled but merged, so the two were one
   * paragraph with no seam. Nothing is lost by dropping it: a worker's conclusion is the
   * `delegate` tool's result, which lands in the transcript a moment later and is the thing
   * the main model actually reads.
   */
  private workerEvents(role: string, events: AgentEvents): AgentEvents {
    return {
      onToolCall: (name, args) => events.onToolCall?.(name, args, role),
      onToolResult: (name, result, callId) => events.onToolResult?.(name, result, callId, role),
      onToolOutput: (name, text) => events.onToolOutput?.(name, text),
      // Present and deliberately empty: `Agent` opts into streaming on one of the delta
      // callbacks existing, and the step clock re-arms on them — an Agent with none gets its
      // first-token budget applied to the whole request. The reviewer's own events carry the
      // same comment and the same no-op for the same reason.
      onTextDelta: () => {},
    }
  }

  private async runWorker(
    role: string, task: string, context: ToolContext, events: AgentEvents, signal?: AbortSignal,
  ): Promise<SubAgentOutcome> {
    const found = ROLES.find((r) => r.name === role)
    if (found === undefined) {
      return {
        role, text: '', steps: 0, ms: 0,
        problem: `no such worker: ${role}. Available: ${ROLE_NAMES.join(', ')}`,
      }
    }
    return await runSubAgent(
      {
        client: this.opts.client,
        registry: this.opts.toolset.registry,
        context,
        events: this.workerEvents(role, events),
        // Without this a worker in any mode but plan is refused outright, which is the
        // point: the capability and its gate arrive together or not at all.
        ...(this.opts.engine ? { permissions: this.opts.engine } : {}),
        ...(this.opts.compaction !== undefined
          ? { stepResultBudgetChars: tailBudgetTokens(this.opts.compaction.contextLength) * 4 }
          : {}),
      },
      found,
      task,
      signal,
    )
  }

  /** Whether the model in this session's mode is actually offered `delegate`. */
  private delegationAvailable(): boolean {
    if (this.meta.mode === 'plan') return false
    return this.opts.toolset.registry.schemas().some((t) => t.function.name === 'delegate')
  }

  private buildAgent(signal?: AbortSignal, sampling?: import('../llama/types.js').Sampling): Agent {
    const context: ToolContext = {
      workspace: this.workspace,
      todos: this.opts.toolset.todos,
      // The toolset owns it, so it survives a session switch: closing a page the user is
      // looking at because they clicked Resume would be its own small betrayal.
      browser: this.opts.toolset.browser,
      webRenderer: this.opts.toolset.webRenderer,
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
    // A bound function, not the client and the registry: a tool holding those could
    // build any agent it liked, and this one can only ask for a role that exists.
    // The context and the events are the CALLER's own, so a worker sees the same
    // workspace, the same browser, the same database and the same approval port — and so
    // its writes are counted by the same hooks. A worker whose writes went uncounted
    // would leave `writesThisTurn` at zero on a turn that changed the workspace, and the
    // build gate's shortcut would skip the check on exactly that turn.
    context.delegate = (role, task, sig) =>
      this.runWorker(role, task, context, this.composeEvents(this.opts.events), sig)

    const agentOpts: AgentOptions = {
      client: this.opts.client,
      registry: this.opts.toolset.registry,
      context,
      transcript: this.transcript,
      // No `loopDetector` — see the note where it used to be constructed. Omitting it is how
      // the Agent turns the check off: `AgentOptions.loopDetector` is optional and absent
      // means the code never runs, rather than running with a limit nothing can reach.
    }
    // Only with somewhere to ask. Without a port the check could read the request three ways
    // and have nobody to put the disagreement to, which is a generation spent on nothing.
    if (port) agentOpts.onBeforeTool = (name) => this.understandingGate(name, port, signal)
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
      agentOpts.stepResultBudgetChars = tailBudgetTokens(this.opts.compaction.contextLength) * 4
    }
    if (sampling !== undefined) agentOpts.sampling = sampling
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
      this.injectPlanFocus()
      this.injectPlanUpkeep()
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
