import type { ApprovalDecision, TodoItem } from '@core/interaction'
import type { CompactionState, StoppedBecause, TranscriptEntry } from '@core/host/protocol'
import type { AgentMode } from '@core/permissions/engine'

/**
 * The chat panel's pure transcript reducer (Plan 4 Task 5): every protocol event that
 * touches the transcript is turned into a `ChatAction`, folded through `reduceChat` into a
 * new `ChatState` -- no DOM, no timers, no `Date.now()`/`Math.random()`, so the whole
 * delta-accumulate / step-reset / interrupt behavior is unit-testable without a client, a
 * transport, or Preact at all. `chat.tsx` owns the impure half: subscribing to
 * `ProtocolClient` events, calling `dispatch`, and rendering `state.items` in order.
 *
 * REASONING (rewritten in the UI rework -- the original behavior is why the user could not
 * see what the model was thinking, and why "thinking…" animations hung forever):
 * - A `thinking` item accumulates the reasoning TEXT, not just a character count. The text
 *   is the point; a token estimate is not an answer to "what is it doing right now".
 * - The item is CLOSED, never removed. `done: true` is set by whatever ends the reasoning
 *   for that step -- the first `text.delta`, an `assistant.text`, a `tool.call`, or, as a
 *   backstop, `step.done` / `turn.done` / `send-failed`. The original code removed the
 *   item on `text.delta` alone, so a tool-calling step (which never emits `text.delta`)
 *   left a live, pulsing "thinking…" row in the transcript forever.
 * - `endedAtMs` is filled from the closing action's optional `atMs`. The reducer still
 *   never reads a clock itself (see above); callers that want a "thought for 12s" line
 *   pass the timestamp in, callers that don't simply get `null` and no duration.
 *
 * One behavior still mirrors `core/src/cli/render.ts`'s streaming REPL renderer:
 * `assistant.text` (the non-streaming, whole-string event that always follows a step) is
 * IGNORED when that step's content already streamed via `text.delta` -- appending it too
 * would duplicate the same prose, matching `render.ts`'s `textStreamed` check in
 * `onAssistantText`.
 */

export type ChatItem =
  /** `harness` marks a user-ROLE message the harness wrote — a plan focus note, a mid-turn
   * verify result, a contract preamble. It reads as an instruction to the model, which is
   * why it has that role, and it is emphatically not one of the person's own messages. Only
   * a replayed session can produce one: live, the composer is the only thing that dispatches
   * `user-message`. */
  | { kind: 'user'; id: number; text: string; harness?: boolean }
  | { kind: 'assistant'; id: number; text: string; interrupted: boolean }
  /** The model's reasoning for one step: the full text, plus whether it is still being
   * produced. `done` drives BOTH the live animation and the header wording, so a closed
   * item can never animate. */
  | {
    kind: 'thinking'
    id: number
    step: number
    text: string
    done: boolean
    startedAtMs: number
    /** Set from the closing action's `atMs` when the caller supplied one; `null` means
     * "closed, duration unknown" -- never "still running" (that is `done: false`). */
    endedAtMs: number | null
  }
  /** `result.content` is the FULL, untruncated tool result string (Task 7's diffs panel
   * needs the whole rendered diff, not the one-line `preview` this row itself displays --
   * see diffs.tsx's `toDiffEntry`). Keeping both on the same item is one source of truth
   * for "which result came back for which call" instead of a second, independent
   * call/result correlation living in diffs.tsx. */
  | {
    kind: 'tool'
    id: number
    name: string
    args: string
    /**
     * The call is still being GENERATED — `args` is a partial JSON document, not yet valid.
     *
     * A large edit is written into the argument a token at a time, and that is most of the
     * step. Until the call streamed, the window learned of it only when it arrived whole, so
     * the chat stopped for the whole of the longest stretch in a normal turn. Cleared by the
     * `tool.call` that completes it, which is also what replaces `args` with the real one.
     */
    writing?: true
    /** Which call in the step this is, while it is being written. Parallel calls interleave
     * in one stream and are told apart only by this. Dropped once the call completes. */
    callIndex?: number
    /** When the call was announced, from the action's optional `atMs`. Used to order the
     * Terminal tab, which interleaves the agent's commands with the user's own. `0` when
     * the caller had no clock (a test). */
    startedAtMs: number
    /** Live output while the tool RUNS (run_command's stdout/stderr so far), tail-capped —
     * display only. Dropped when the result arrives: the result is the complete record. */
    live?: string
    result?: {
      ok: boolean
      preview: string
      /** Exactly what the model was given. */
      content: string
      /** What to SHOW: the untruncated result when the tool clipped `content` for the
       * model's context, otherwise the same string. See core's `ToolResult.display`. */
      display: string
    }
  }
  /** A `send`/`abort` RPC call itself came back an error reply (e.g. "a turn is already
   * running", "no active session") -- rendered as a one-line note rather than silently
   * dropped, which is what a naive `.catch(() => {})` would otherwise do. */
  | { kind: 'error'; id: number; message: string }
  /** What an `approval.request` card COLLAPSES INTO once answered -- the plan's own
   * phrase for it -- so the transcript keeps a permanent one-line record after the live
   * card (rendered separately, above the input; see `approvals.tsx`) disappears. */
  | { kind: 'approval-record'; id: number; tool: string; summary: string; decision: ApprovalDecision }
  | { kind: 'question-record'; id: number; question: string; answer: string }
  /** One run of the project's own verify command. Shown even when it passes: a check that
   * silently added thirty seconds to a writing turn would read as the app hanging. */
  | {
      kind: 'verify-record'; id: number; command: string; ok: boolean; detail: string
      /** Which folder's check this was; absent in a single-folder workspace. */
      folder?: string
    }
  /** Why a turn ended, when it did NOT end by the model deciding it was finished.
   * Appended for every `stoppedBecause` other than `'done'`, because the alternative --
   * what this app used to do -- is that the agent simply goes quiet mid-task and the only
   * honest description of the UI's behaviour is "it stopped for some reason". */
  | { kind: 'stopped'; id: number; reason: Exclude<StoppedBecause, 'done'> }
  /**
   * A compaction that landed, where it landed.
   *
   * The most consequential thing that happens to a session — from here on the model works
   * from this briefing rather than from the conversation above it — and it used to pass as
   * five seconds of status text. If the briefing lost something, this is where you find out,
   * rather than three turns later from odd behaviour.
   */
  | {
    kind: 'compaction-record'
    id: number
    /**
     * Every compaction ends in one of these, and every one of them is SHOWN.
     *
     * The three that are not `applied` used to be silent: a `/compact` that could not help
     * cleared the box and printed nothing at all, which reads as the app ignoring you. An
     * operation that occupies the model for minutes and then changes nothing has to say so.
     */
    state: 'running' | 'ready' | 'applied' | 'skipped' | 'failed'
    /** Distinguishes "too short to be worth summarising" from "tried and could not help". */
    reason?: 'nothing-to-gain'
    beforeTokens?: number
    afterTokens?: number
    droppedMessages?: number
    keptMessages?: number
    summary?: string
    /**
     * How far the summariser has got, while `state` is `'running'`.
     *
     * Carried on the ITEM rather than beside it in `ChatState` so the live number reaches the
     * screen without giving every memoised transcript row a prop that changes four times a
     * second. Only this row's identity changes, so only this row re-renders — the same reason
     * the streamed text lives on its own item.
     */
    progress?: StepProgress
  }

/** The turn-paused card `approvals.tsx` renders above the input while the sidecar awaits
 * a reply -- at most one at a time, matching the protocol: `SessionHost` awaits one
 * `requestApproval`/`askUser` call to resolve before the turn's next step can run, so a
 * second `approval.request`/`question.request` can never arrive while one is already
 * pending. */
export interface PendingApproval {
  requestId: string
  tool: string
  summary: string
  detail: string
  suggestedRules: string[]
}

export interface PendingQuestion {
  requestId: string
  question: string
  options: string[]
  /** Several options may be picked together; the card renders toggles and one Answer
   * button instead of send-on-click. The reply is still one string. */
  multiSelect?: boolean
}

export interface StepTiming {
  step: number
  /** How long the step may go SILENT before the core abandons it — not a budget for the
   * whole step. See `Agent.stepClock` in the core. */
  timeoutMs: number
  /** The larger budget for the wait before this step's FIRST token: `timeoutMs` plus the
   * core's prefill allowance for what the last step appended. The countdown must use this
   * until something streams — counted against `timeoutMs` alone it reached zero and sat at
   * "0s to timeout" for half a minute while a step prefilling two ~20k-token search results
   * was perfectly healthy. Absent only for an older core that does not send it. */
  firstTokenTimeoutMs?: number
  /** Whether the step is in a silent-prefill stretch — from `step.start` (or a forced
   * continuation, which re-prefills the carried-back reasoning) until the first delta.
   * This, not an anchor comparison, decides which budget the countdown counts against. */
  waitingFirstToken: boolean
  /** `items.length` at the moment the current model CALL began (the step's start, moved
   * forward by a forced continuation). Everything past this mark is that call's own
   * stream — and on a server-death retry it is exactly what the re-sent call supersedes,
   * closed or not: a thinking block closed by a streamed tool-call name is still the dead
   * attempt's. Optional: a restored transcript builds no mark, and replay never retries. */
  itemsAtCallStart?: number
  /**
   * When the step began. Set once, on `step.start`, and never moved.
   *
   * This is the anchor for "how long has this step been running", which is the readout that
   * turns a long silence into "it is working" rather than "it hung".
   */
  startedAtMs: number
  /**
   * The last moment anything streamed — the anchor for the SILENCE countdown, moved forward
   * by `step.alive`.
   *
   * It is a separate field from `startedAtMs` because the two answer different questions, and
   * for one commit they shared one field: `step.alive` moved `startedAtMs`, so the elapsed
   * readout showed the time since the last animation frame instead of the time since the step
   * began. `now` reticks every 250 ms while frames arrive at ~60/s, so it rendered `0.0s` —
   * and, when a frame landed after the tick, a negative duration — for the whole of every
   * streaming step. Four separate audit lenses found it independently.
   */
  aliveAtMs: number
  /** How far this step's request has got — see `StepProgress`. Absent until the server
   * reports something, and absent for a core too old to send it. */
  progress?: StepProgress
}

/**
 * A running generation's own account of where it is.
 *
 * One phase at a time, and which one is the information: `prompt` means the server is still
 * READING (nothing streams during this, and on a long conversation it is the longest wait in
 * a turn), `generated` means tokens are coming out. A progress event replaces this wholesale
 * rather than merging into it, so the moment generation starts the prefill numbers stop being
 * shown — a stale "12.4k / 18.1k" beside a live token count would read as two live phases.
 */
export interface StepProgress {
  prompt?: { processed: number; total: number; cache: number }
  generated?: { tokens: number; perSecond?: number }
}

export interface LastStepStats {
  step: number
  seconds: number
  tokensPerSecond: number | undefined
  /** The server's own count of this step's prompt tokens -- Task 8's status bar divides
   * this by `SessionInfo.contextLength` for the `42.3k/131.1k (32%)` context-fill line. */
  promptTokens: number | undefined
  /** Speculative-decoding draft-acceptance rate for this step, when the server reports
   * one -- Task 8's status bar's "MTP %". */
  draftAcceptance: number | undefined
  /** The prompt count is the transcript's own estimate, not the server's measurement --
   * true for a resumed session, and for a just-applied compaction swap, until the next
   * step lands. The status bar says so rather than presenting an estimate as a reading. */
  estimated?: boolean
  /**
   * What the readout should actually divide, and where compaction will fire.
   *
   * `promptTokens` above is the raw measurement for the moment the request was built. The
   * core corrects it — everything appended since, plus the tool schemas on an estimate —
   * before deciding whether to compact, and for a long time the bar did not, so the two
   * disagreed and only one of them was on screen. These carry the core's own figures.
   * Absent for a core too old to send them; the raw count is still there to fall back on.
   */
  contextUsed: number | undefined
  compactAt: number | undefined
}

/**
 * What `init`/`sessions.new`/`sessions.resume` established about the CURRENT session --
 * Task 8's status bar (mode badge, session title) and context-fill line (`contextLength`)
 * both read this. Set by whoever calls one of those three RPCs (there is no protocol
 * EVENT for "a session became active" -- init is a request/reply, not a broadcast), via
 * `session-ready`/`session-switched` below.
 */
export interface SessionInfo {
  sessionId: string
  mode: AgentMode
  contextLength: number | null
  title: string
}

/**
 * A stored session being READ while another one keeps working.
 *
 * Browsing used to cost you the running turn, because selecting a session and becoming it
 * were one action. They are two: this is the one you are looking at, `session` is the one the
 * composer talks to, and the running turn's events keep folding into `items` the whole time —
 * so coming back shows everything that happened while you were away.
 */
export interface ViewedSession {
  sessionId: string
  title: string
  items: ChatItem[]
}

export interface ChatState {
  items: ChatItem[]
  turnRunning: boolean
  currentStep: StepTiming | null
  /** The text of a message the host reported as never delivered (turn.done with
   * delivered:false — Esc during contract distillation). The composer drains it back
   * into the input box and dispatches `draft-restored`; null the rest of the time. */
  restoreDraft: string | null
  lastStepDone: LastStepStats | null
  /** Null means the view IS the live session. */
  viewing: ViewedSession | null
  /** Monotonic counter backing every `ChatItem.id` -- deterministic and reducer-owned
   * (not a module-level global) so two independent `reduceChat` call chains in the same
   * test file never collide on ids. */
  nextId: number
  pendingApproval: PendingApproval | null
  pendingQuestion: PendingQuestion | null
  /** The most recent `todos` event's items, verbatim -- there is no history here, only
   * "the current list", matching `TodoStore`'s own set()-replaces-wholesale semantics on
   * the core side. */
  todos: TodoItem[]
  /**
   * How many requests are parked, waiting for the user.
   *
   * A count and not the list: the entries themselves are read on demand when the card is
   * opened, because a night's worth would otherwise sit in the reducer and re-render on
   * every streamed token — the same reason the transcript memoises its rows.
   */
  pendingDecisions: number
  /**
   * The unattended run in progress, if any. `null` when a person is driving.
   *
   * `lastRun` outlives it deliberately: the reason a run stopped is the first thing wanted
   * afterwards, and it must not vanish the instant the run does.
   */
  run: {
    turn: number
    /** What the run was asked to do — the one line that distinguishes "it is working" from
     * "it is working on the wrong thing". Known only client-side at start time, so it is
     * carried here rather than in any event. */
    task: string
    /** Wall clock at `run-started`, for the banner's elapsed readout. */
    startedAtMs: number
    /** The budgets it was started with, absent for an unbounded run. Shown beside the turn
     * count because "turn 7" and "turn 7 of 20" are different amounts of information. */
    maxTurns?: number
    maxHours?: number
  } | null
  lastRun: { turns: number; stoppedBecause: string; detail: string } | null
  session: SessionInfo | null
  /**
   * Configuration problems the engine reported for this session — an unparseable
   * settings file, a rule that failed to compile, a context length it could not probe.
   *
   * These were reaching the app on two channels and being consumed on NEITHER: nothing
   * subscribed `settings.problem`, and `App.tsx` discarded every field of `init`'s result
   * except the four it forwarded. So a settings file with one bad line silently dropped
   * the user's deny rules with no banner, no notice and no mark anywhere — in autopilot
   * that rule may have been the only thing standing between the agent and the command.
   */
  problems: string[]
  /** The most recent `compaction` event, plus a monotonic `seq` -- Task 8's status bar
   * renders this as a subtle, self-clearing flash ('compacting…', 'compacted: N messages
   * summarised', 'postponed'). Never cleared BY the reducer itself (there is no action
   * for "hide the flash now"; that is a timer, an impure concern status.tsx owns) -- `seq`
   * is what lets that timer's effect notice a SECOND event carrying the same `state`
   * string (e.g. two `'postponed'`s in a row) as a fresh occurrence worth re-flashing. */
  lastCompaction: { state: CompactionState; droppedMessages: number | undefined; seq: number } | null
}

/** How much of a running command's output the live pane keeps. A viewport, not a record:
 * enough to read what a build is doing right now, small enough that a firehose `dir /s`
 * cannot bloat the state on every frame. */
const LIVE_OUTPUT_TAIL_CHARS = 16_000

export function initialChatState(): ChatState {
  return {
    items: [], turnRunning: false, currentStep: null, restoreDraft: null, lastStepDone: null, viewing: null, nextId: 1,
    pendingApproval: null, pendingQuestion: null, todos: [], session: null, lastCompaction: null,
    problems: [], pendingDecisions: 0, run: null, lastRun: null,
  }
}

export type ChatAction =
  | { type: 'user-message'; text: string; harness?: true }
  | { type: 'decisions.changed'; pending: number }
  /** Dispatched by the composer the moment `run.start` is called: the task and budgets are
   * known only there, and the first `run.turn` event may be a whole turn away. */
  | { type: 'run-started'; task: string; atMs: number; maxTurns?: number; maxHours?: number }
  | { type: 'run.turn'; turn: number }
  | { type: 'run.ended'; turns: number; stoppedBecause: string; detail: string }
  /** The ended-run card was read and dismissed. */
  | { type: 'run-dismissed' }
  /** The optimistic `turn-started` was refused by the host (the slot was taken). Undoes
   * exactly what the optimism did — without it, nothing ever clears `turnRunning`, since a
   * run's turns emit no `turn.done`, and the composer wedges on Stop forever. */
  | { type: 'send-rolled-back' }
  | { type: 'turn-started' }
  | { type: 'step.start'; step: number; timeoutMs: number; startedAtMs: number; firstTokenTimeoutMs?: number }
  /** A forced continuation began inside the step: silence is prefill again, against a fresh
   * first-token budget. */
  | { type: 'step.continuation'; firstTokenTimeoutMs?: number; atMs: number }
  /** The server died mid-call and the same request is being re-sent: the dead attempt's
   * partial cards are superseded and must go, or the retry streams onto them. */
  | { type: 'step.retry'; atMs: number; firstTokenTimeoutMs?: number }
  /** Where a running generation has got to — the turn's step, or the background compaction.
   * Purely a readout: it moves no clock and closes no card. */
  | { type: 'generation.progress'; scope: 'step' | 'compaction'; progress: StepProgress }
  /** Something streamed, so the step is alive: restarts the silence countdown. Dispatched
   * once per animation frame by whichever buffer had content, mirroring the core's
   * `clock.touch()` on every delta. */
  | { type: 'step.alive'; atMs: number }
  | { type: 'thinking.delta'; text: string }
  /** `atMs` on this and the four actions below is the wall clock at which the caller saw
   * the event, used only to stamp `endedAtMs` on the reasoning item this action closes.
   * Optional throughout: a caller with no clock (a test) gets the same transcript, minus
   * the "thought for 12s" duration. */
  | { type: 'text.delta'; text: string; atMs?: number }
  | { type: 'assistant.text'; text: string; atMs?: number; interrupted?: boolean }
  /** A tool call arriving as it is written: `name` opens the card, `args` fragments fill it.
   * See the `tool` ChatItem's `writing`. */
  | { type: 'tool.call.delta'; index: number; name?: string; args?: string; atMs?: number }
  | { type: 'tool.call'; name: string; args: string; atMs?: number }
  | { type: 'tool.result'; name: string; ok: boolean; content: string; display?: string }
  | {
    type: 'step.done'; step: number; seconds: number; tokensPerSecond?: number
    promptTokens?: number; draftAcceptance?: number; atMs?: number
    /** The window fill and the compaction threshold, both by the core's own arithmetic —
     * `promptTokens` is the raw measurement for the moment the request was built and is
     * blind to everything appended since. See `StepDoneEvent`. */
    contextUsed?: number; compactAt?: number
  }
  | { type: 'turn.done'; stoppedBecause: StoppedBecause; atMs?: number; delivered?: false }
  | { type: 'draft-restored' }
  | { type: 'tool.output'; text: string }
  | { type: 'send-failed'; message: string; atMs?: number }
  /**
   * An error worth a transcript row that says NOTHING about the turn.
   *
   * `send-failed` is specifically "the optimistic send did not happen": it rolls the turn
   * state back. It was also being dispatched as a generic toast — a mode-switch failure, a
   * session file that would not read, a mistyped slash command — and fired mid-turn it
   * flipped Stop to Send while the host streamed on, dropped the real `turn.done` at the
   * `turnRunning` guard, and left thinking rows pulsing forever. An error NOTE appends the
   * row and touches nothing else.
   */
  | { type: 'error-note'; message: string }
  /** Dispatched after every successful `init`/`sessions.new`/`sessions.resume` call --
   * every one of those is either this app run's first session or a deliberate switch to a
   * different one, so this always resets the whole transcript/turn/pending-card/todos
   * state alongside the new session info: an old session's messages and pending cards
   * have no business surviving into a new one's view. */
  | {
    type: 'session-switched'; sessionId: string; mode: AgentMode; contextLength: number | null; title: string
    /** How full the context already is. A resumed session has no step in this process, so
     * without this the bar stayed blank until the first message — hiding a number the
     * host could compute from the transcript it just restored. */
    contextUsed?: { promptTokens: number | null; approxTokens: number }
    /** Where compaction fires, so a resumed session's bar is coloured against the thing that
     * is actually going to happen rather than against 80% of the window. */
    compactAt?: number
  }
  /** The conversation a resumed session already had, dispatched right after the
   * `session-switched` that cleared the view. Folded through this same reducer one entry at
   * a time (see the case), so history is assembled by the code that assembles the present. */
  | { type: 'transcript-restored'; entries: readonly TranscriptEntry[] }
  /** Look at a stored session without becoming it. The live session keeps running and keeps
   * accumulating into `items`. */
  | { type: 'viewing-started'; sessionId: string; title: string; entries: readonly TranscriptEntry[] }
  | { type: 'viewing-ended' }
  | { type: 'mode-changed'; mode: AgentMode }
  | {
    type: 'compaction'; state: CompactionState; droppedMessages?: number
    reason?: 'nothing-to-gain'
    detail?: { beforeTokens: number; afterTokens: number; summary: string; keptMessages: number }
  }
  /**
   * A compaction read back off disk, NOT one happening now.
   *
   * Separate from `compaction` on purpose: that action also sets `lastCompaction`, which the
   * status bar renders as a self-clearing flash. Restoring through it would announce
   * "compacted — N messages summarised" every time a compacted session was opened, about
   * something that happened days ago. A record in the transcript is history; a flash is news.
   */
  | { type: 'compaction-restored'; summary: string; droppedMessages?: number }
  | { type: 'approval.request'; requestId: string; tool: string; summary: string; detail: string; suggestedRules: string[] }
  /** Fired locally by `approvals.tsx` the instant the user clicks Allow/Deny -- BEFORE the
   * `approval.reply` RPC even resolves. This is what makes "pending -> answered" a
   * single-fire transition on the UI side too (not just server-side, where a stale
   * requestId is already refused): once this reducer has cleared `pendingApproval`, a
   * second click on a since-unmounted/disabled card has nothing left to dispatch against. */
  | { type: 'approval.answered'; decision: ApprovalDecision }
  | { type: 'question.request'; requestId: string; question: string; options: string[]; multiSelect?: boolean }
  | { type: 'question.answered'; answer: string }
  | { type: 'todos'; items: TodoItem[] }
  | {
      type: 'verify'; command: string; ok: boolean; attempt: number
      exitCode?: number; problem?: string
      /** Which folder's check this was; absent in a single-folder workspace. */
      folder?: string
    }
  /** One configuration problem, from the `settings.problem` event OR forwarded out of an
   * init/new/resume result. Both arrive for the same session -- the host emits the events
   * while building it, BEFORE the reply that carries the same strings -- so this action
   * deduplicates on exact text and the double delivery is harmless. */
  | { type: 'settings-problem'; text: string }
  | { type: 'problems-dismissed' }

/** First line only, capped -- the same "one-line result preview" the plan asks the tool
 * row to show; a multi-line tool result (a diff, a directory listing) would otherwise
 * blow the row's height out. */
function preview(content: string): string {
  const firstLine = content.split('\n')[0] ?? ''
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
}

/** The still-open reasoning item, if the LAST item in the transcript is one -- reasoning
 * deltas only ever accumulate onto the most recently opened step's own block, never an
 * older one further back in the transcript, and never one already closed. */
function openThinking(items: ChatItem[]): (ChatItem & { kind: 'thinking' }) | undefined {
  const last = items[items.length - 1]
  return last?.kind === 'thinking' && !last.done ? last : undefined
}

/**
 * Closes the open reasoning item, if there is one. This replaces the original code's
 * "remove the thinking row" -- the text stays in the transcript (the user asked to see it)
 * and only the live state ends, which is what stops the animation. A no-op when nothing is
 * open, so every action that could possibly end reasoning can call it unconditionally.
 */
/** Last match's index, or -1. Hand-written rather than `Array.prototype.findLastIndex`,
 * which this app's lib target does not carry (the same reason `.at()` is avoided here). */
function findLastIndex<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (match(items[i] as T)) return i
  }
  return -1
}

/**
 * The step with the previous request's progress dropped.
 *
 * A forced continuation and a server-death retry both start a NEW request, whose prefill
 * begins again from whatever the server still has cached. Carrying the readout forward would
 * show the dead attempt's token count while the live one has produced nothing — the same
 * class of lie as the spliced reasoning the retry case removes items for.
 */
function restarted(step: StepTiming): StepTiming {
  const { progress: _dropped, ...rest } = step
  return rest
}

function closeThinking(items: ChatItem[], atMs: number | undefined): ChatItem[] {
  const open = openThinking(items)
  if (!open) return items
  const closed: ChatItem = { ...open, done: true, endedAtMs: atMs ?? null }
  return [...items.slice(0, -1), closed]
}

function lastAssistantItem(items: ChatItem[]): (ChatItem & { kind: 'assistant' }) | undefined {
  const last = items[items.length - 1]
  return last?.kind === 'assistant' ? last : undefined
}

/**
 * The assistant item THIS generation streamed, if it streamed one -- the item `assistant.text`
 * has to compare itself against before appending.
 *
 * Not `items[items.length - 1]`. The core announces prose the moment the generation resolves
 * (loop.ts: "Prose that rides along with a tool call is still the model talking to the user"),
 * which is AFTER the `tool.call.delta` carrying a tool name has already opened a card for the
 * call that rode along with it. A step that wrote both therefore held `[assistant, tool]` by
 * the time the whole-string event landed, the last-item check saw the card instead of the
 * prose, and the same sentence was appended a second time BELOW the tool row -- rendered
 * twice live and exported twice, while the same conversation restored from disk rendered it
 * once.
 *
 * So the scan steps over cards still being WRITTEN, and stops at anything else. A writing card
 * is the only thing that can sit between prose and its own echo: `tool.call`, the approval
 * record and the result all arrive after this event. Everything else is a message boundary --
 * and on replay it is the boundary that matters, because a restored `tool-call` settles its
 * card immediately, so two assistant entries either side of a tool are two real messages and
 * both have to stay.
 */
function streamedAssistantItem(items: ChatItem[]): (ChatItem & { kind: 'assistant' }) | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.kind === 'tool' && item.writing === true) continue
    return item?.kind === 'assistant' ? item : undefined
  }
  return undefined
}

/**
 * The most recent tool item still awaiting its result, found by scanning BACKWARDS rather
 * than by looking only at the last item.
 *
 * The scan matters: the event order is `tool.call -> [approval.request ->
 * approval.answered] -> tool.result`, and answering an approval appends an
 * `approval-record` item. So by the time the result arrives, the tool call is no longer
 * last, and a last-item-only check silently dropped the result — leaving an approved edit
 * displaying as "still running" forever, with no diff. (Found by driving a real edit
 * through the approval flow; it had been wrong since the card was introduced.)
 *
 * Recency alone is still the right match: tools run strictly one at a time here, so there
 * is never more than one unresolved call, even when the same tool is called twice in a row.
 *
 * A card still being WRITTEN is skipped. It has no result for the same reason it has no
 * finished arguments — the model is still generating it — so it can never be the call a
 * result belongs to, and matching it would hand one call's result to another.
 */
/**
 * Closes any card still being WRITTEN, with the honest reason: nothing ever ran.
 *
 * A card opens when the model starts naming a tool and closes when the matching `tool.call`
 * arrives. Between those two, a turn can end — aborted, timed out, or truncated twice — and
 * then no `tool.call` is ever coming. The card would pulse for the rest of the session, and
 * the next call of the same name would complete it, taking its arguments and later its
 * result: one call's diff shown against another call's file.
 *
 * The core answers every abandoned call in the transcript with a `Not run:` line and now
 * announces them too, so this is the remaining case: the ones cut off before the step even
 * finished, which no event can describe because the step produced none.
 */
function closeWritingCalls(items: ChatItem[], reason: string = ABANDONED): ChatItem[] {
  if (!items.some((i) => i.kind === 'tool' && i.writing === true)) return items
  return items.map((item): ChatItem => {
    if (item.kind !== 'tool' || item.writing !== true) return item
    const { writing: _w, callIndex: _c, ...rest } = item
    return { ...rest, result: { ok: false, preview: 'never ran', content: reason, display: reason } }
  })
}

/**
 * What an abandoned card is closed with — and it starts with `Not run:` deliberately.
 *
 * That prefix is the codebase-wide contract for a call stopped before it executed, and three
 * separate readers test for it: `collectChanges` drops the row, `commandsFrom` refuses to
 * write it into the work log's "Ran" line, and the Terminal tab keeps it out of the console.
 * Written any other way, this text reads to all three as a call that ran and failed.
 *
 * The case that made it matter: a generation that truncates leaves its half-written card
 * behind, and the forced continuation opens a SECOND card for the same call. That one is
 * closed the moment the continuation starts, with `TRUNCATED_BEFORE_CALL` below — and, while
 * it was closed with plain prose, it went into the Changes tab as the newest write to that
 * path, holding a path and a `write_file` name, taking the real write's diff and its
 * "Put back" button with it. What is left for this text is the turn that simply ended on top
 * of an open card: aborted, timed out, or truncated twice.
 */
const ABANDONED =
  'Not run: the turn ended while this call was still being written, so it never ran.'

/**
 * The same closure, for the case the comment above describes — said accurately, because the
 * turn has NOT ended here: the generation ran out of room and a forced continuation is about
 * to take over.
 *
 * It carries the identical `Not run:` prefix, which is the load-bearing half: `collectChanges`
 * drops the row, `commandsFrom` keeps it out of the work log's "Ran" line, and the Terminal
 * tab keeps it out of the console. Only the sentence differs, so a reader is told which of the
 * two things happened rather than being told the turn ended when it is still running.
 */
const TRUNCATED_BEFORE_CALL =
  'Not run: the model ran out of room while this call was still being written, and the ' +
  'forced continuation re-issued it below, so this one never ran.'

export function pendingTool(items: ChatItem[]): (ChatItem & { kind: 'tool' }) | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.kind === 'tool' && item.result === undefined && item.writing !== true) return item
  }
  return undefined
}

/** The live action each stored entry stands in for. See the `transcript-restored` case. */
function restoreAction(entry: TranscriptEntry): ChatAction {
  switch (entry.kind) {
    case 'user':
      return { type: 'user-message', text: entry.text, ...(entry.harness ? { harness: true as const } : {}) }
    case 'reasoning': return { type: 'thinking.delta', text: entry.text }
    case 'tool-call': return { type: 'tool.call', name: entry.name, args: entry.args }
    case 'tool-result':
      return { type: 'tool.result', name: entry.name, ok: entry.ok, content: entry.content }
    case 'assistant': {
      // The core glues this literal marker onto an aborted reply's partial text (see
      // loop.ts appendInterrupted) — it is transcript DATA, not something the model
      // wrote. Live, the abort marks the open item `interrupted` and the marker is never
      // seen; on replay the flag was lost and the bracket text rendered as-is in the
      // middle of the conversation. Stripped back into the flag it stands for.
      const stripped = entry.text.replace(/\n?\[interrupted by the user before this reply finished\]$/, '')
      return stripped === entry.text
        ? { type: 'assistant.text', text: entry.text }
        : { type: 'assistant.text', text: stripped, interrupted: true }
    }
    case 'compaction':
      return {
        type: 'compaction-restored',
        summary: entry.summary,
        ...(entry.droppedMessages !== undefined ? { droppedMessages: entry.droppedMessages } : {}),
      }
  }
}

export function reduceChat(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'user-message': {
      const item: ChatItem = {
        kind: 'user', id: state.nextId, text: action.text,
        ...(action.harness ? { harness: true } : {}),
      }
      return { ...state, items: [...state.items, item], nextId: state.nextId + 1 }
    }

    case 'turn-started':
      // `lastStepDone` deliberately SURVIVES the turn boundary.
      //
      // Clearing it made the context bar, tok/s and MTP vanish the instant you pressed
      // Enter and reappear when the first step landed — a blink on every message, reported
      // from the running app. None of those readings stops being true because a new turn
      // began: they are the last measurement, and the last measurement is exactly what a
      // status bar is for. The first `step.done` of this turn overwrites them, merging
      // field by field, so nothing goes stale for longer than one step.
      //
      // This is the same lesson `step.done` already learned WITHIN a turn (see its own
      // comment about aborted steps wiping the count) applied ACROSS turns, where it was
      // simply never carried over.
      //
      // Writing cards are closed here as well as on `turn.done`, and that is the belt to its
      // braces: an unattended RUN takes turn after turn without a `turn.done` between them,
      // and a `send` the host refuses never produces one at all. A card left open by any of
      // those would pulse until the session ended, and the next call of the same name would
      // complete it — one call's arguments, then one call's result, against another call's
      // card. A new turn starting is proof the last one is over, whatever the last one did.
      return { ...state, items: closeWritingCalls(state.items), turnRunning: true, currentStep: null }

    case 'step.start':
      return {
        ...state,
        // A step does NOT open a reasoning block here: the block is created lazily by the
        // first `thinking.delta` that actually arrives, so a step that goes straight to a
        // tool call or an answer leaves no empty "Thought" card behind. That a step is
        // running at all is `currentStep`/`turnRunning`, which the composer renders.
        currentStep: {
          step: action.step,
          timeoutMs: action.timeoutMs,
          startedAtMs: action.startedAtMs,
          aliveAtMs: action.startedAtMs,
          waitingFirstToken: true,
          itemsAtCallStart: state.items.length,
          ...(action.firstTokenTimeoutMs !== undefined
            ? { firstTokenTimeoutMs: action.firstTokenTimeoutMs } : {}),
        },
      }

    case 'generation.progress': {
      if (action.scope === 'compaction') {
        // Onto the one running compaction row, if there is one. Searched from the end
        // because a long session holds every earlier compaction's finished row, and only the
        // last can be live: `compaction` moves a row out of `'running'` before the next one
        // can start. No running row means the summariser finished (or never started) between
        // the server's chunk and this reducer — nothing to update, and nothing wrong.
        const at = findLastIndex(state.items, (i) => i.kind === 'compaction-record' && i.state === 'running')
        if (at === -1) return state
        const items = [...state.items]
        items[at] = { ...(items[at] as Extract<ChatItem, { kind: 'compaction-record' }>), progress: action.progress }
        return { ...state, items }
      }
      // A step's progress with no step running is not an error worth reacting to — the
      // likeliest cause is the tail of a request whose step already ended — but it must not
      // conjure a `currentStep` out of nothing, which everything downstream reads as "a step
      // is running".
      if (state.currentStep === null) return state
      return { ...state, currentStep: { ...state.currentStep, progress: action.progress } }
    }

    case 'step.continuation':
      if (state.currentStep === null) return state
      return {
        ...state,
        // The truncated generation's half-written cards are closed HERE, where it is already
        // known they can never be completed: the core drops the partial `tool_calls` from the
        // message it carries back (loop.ts appendTruncated) and the continuation re-issues the
        // call from scratch, opening a second card for it.
        //
        // Left open until `turn.done`, that dead card was the one the continuation's single
        // `tool.call` completed — the match there walks OLDEST first, for the parallel-call
        // ordering it exists for — and `pendingTool` then attached the result to it too. One
        // edit rendered as a finished call with a diff ABOVE the reasoning that produced it,
        // plus a phantom row of the same tool name reading "never ran" below, and the live
        // call never resolved.
        items: closeWritingCalls(state.items, TRUNCATED_BEFORE_CALL),
        currentStep: {
          ...restarted(state.currentStep),
          // A fresh silent-prefill stretch starts NOW: the anchor moves so the countdown
          // measures this wait, and the budget is the continuation's own.
          aliveAtMs: action.atMs,
          waitingFirstToken: true,
          // The continuation is its own model call: a retry inside it supersedes only
          // what the continuation itself streamed, not the truncated segment before it.
          itemsAtCallStart: state.items.length,
          ...(action.firstTokenTimeoutMs !== undefined
            ? { firstTokenTimeoutMs: action.firstTokenTimeoutMs } : {}),
        },
      }

    case 'step.retry': {
      // REMOVED, not closed: the retry re-sends the identical request and re-streams the
      // same generation from the start, so a kept partial would show the same reasoning
      // twice — and a half-written tool card would take the retry's deltas at the same
      // callIndex and carry spliced JSON. Everything past the call-start mark is the dead
      // attempt's stream, INCLUDING a thinking block a streamed tool-call name already
      // closed. The on-disk transcript is untouched (the dead attempt was never appended);
      // this is purely the live view.
      const mark = state.currentStep?.itemsAtCallStart
      const items = mark !== undefined && mark <= state.items.length
        ? state.items.slice(0, mark)
        : state.items
      return {
        ...state,
        items,
        // The wait that follows is the relaunched server's cold prefill: re-arm the
        // first-token countdown exactly as a continuation does — and adopt the budget the
        // CORE re-armed with. Keeping the step's original flat budget was display-only but
        // not harmless: on a fat transcript the core allows minutes for the cold read while
        // the window counted down the old number and sat at "0s to timeout" throughout a
        // perfectly healthy prefill.
        ...(state.currentStep !== null
          ? {
            currentStep: {
              ...restarted(state.currentStep),
              aliveAtMs: action.atMs,
              waitingFirstToken: true,
              ...(action.firstTokenTimeoutMs !== undefined
                ? { firstTokenTimeoutMs: action.firstTokenTimeoutMs }
                : {}),
            },
          }
          : {}),
      }
    }

    case 'step.alive':
      // Only while a step is running. Between steps — a tool executing, an approval open —
      // `currentStep` is null and there is no countdown to restart.
      if (state.currentStep === null) return state
      // Something streamed, so the silent-prefill stretch (if any) is over: from here the
      // countdown measures gaps between tokens against the flat budget.
      return {
        ...state,
        currentStep: { ...state.currentStep, aliveAtMs: action.atMs, waitingFirstToken: false },
      }

    case 'thinking.delta': {
      const open = openThinking(state.items)
      if (open) {
        const updated: ChatItem = { ...open, text: open.text + action.text }
        return { ...state, items: [...state.items.slice(0, -1), updated] }
      }
      // First reasoning of this step: open its OWN block. Continuing the previous step's
      // block across a tool round-trip would merge two separate trains of thought into
      // one unreadable wall.
      const item: ChatItem = {
        kind: 'thinking',
        id: state.nextId,
        step: state.currentStep?.step ?? 0,
        text: action.text,
        done: false,
        startedAtMs: state.currentStep?.startedAtMs ?? 0,
        endedAtMs: null,
      }
      return { ...state, items: [...state.items, item], nextId: state.nextId + 1 }
    }

    /**
     * A conversation read back off disk.
     *
     * Each entry becomes the action the LIVE path would have dispatched, and is folded
     * through this same reducer — so a restored transcript is built by exactly the code
     * that builds a running one, and there is no second renderer for history to drift
     * from. It also means every rule already proved here (reasoning closes on a tool call,
     * a result attaches to the most recent unresolved call) holds for free.
     *
     * One thing the live path gets from elsewhere has to be supplied here: reasoning blocks
     * are separated by whatever ENDS them, and two consecutive thinking steps with nothing
     * between them would otherwise accumulate into one wall of text. The step number is the
     * boundary, so a change in it closes the open block.
     */
    case 'viewing-started':
      // Assembled by the SAME folding that assembles a resumed session, run against a
      // scratch state so the live session's items are not touched. A second renderer for
      // "history you are only looking at" would be a second thing to keep in step.
      return {
        ...state,
        viewing: {
          sessionId: action.sessionId,
          title: action.title,
          items: reduceChat(initialChatState(), {
            type: 'transcript-restored', entries: action.entries,
          }).items,
        },
      }

    case 'viewing-ended':
      return { ...state, viewing: null }

    case 'transcript-restored': {
      let next = state
      for (const entry of action.entries) {
        // One reasoning entry per step, so every one of them starts a new block: close
        // whatever was open (a no-op unless two thinking steps ran back to back, which
        // live only avoids because a tool call or an answer always came between), and set
        // the step so a restored block carries the same number a live one would.
        if (entry.kind === 'reasoning') {
          next = {
            ...next,
            items: closeThinking(next.items, undefined),
            currentStep: { step: entry.step, timeoutMs: 0, startedAtMs: 0, aliveAtMs: 0, waitingFirstToken: false },
          }
        }
        next = reduceChat(next, restoreAction(entry))
      }
      // Nothing here is running. Without this, a conversation whose last message was a
      // thought would come back with a pulsing "thinking…" row and the composer counting
      // up a step that finished yesterday.
      return { ...next, items: closeThinking(next.items, undefined), currentStep: null }
    }

    case 'text.delta': {
      const assistant = lastAssistantItem(state.items)
      if (assistant) {
        const updated: ChatItem = { ...assistant, text: assistant.text + action.text }
        return { ...state, items: [...state.items.slice(0, -1), updated] }
      }
      // First text.delta of this step: reasoning is over, so close its block (keeping the
      // text visible) and open a fresh assistant item to accumulate streamed content.
      const items = closeThinking(state.items, action.atMs)
      const item: ChatItem = { kind: 'assistant', id: state.nextId, text: action.text, interrupted: false }
      return { ...state, items: [...items, item], nextId: state.nextId + 1 }
    }

    case 'assistant.text': {
      // Mirrors render.ts's onAssistantText: if this step's content already streamed via
      // text.delta, the whole-string event duplicates it — ignored rather than appended
      // again. By TEXT equality, not by "any assistant item is last": a restored
      // transcript folds through this same case, and there two consecutive assistant
      // entries are two real messages (a truncated reply and its continuation, an
      // interrupted partial and the next answer) — the old any-last check silently
      // swallowed the second one every time an old chat was opened. And against the item
      // this generation streamed rather than against the last one in the list, which by now
      // is the card of the tool call the prose rode along with (see streamedAssistantItem).
      const streamed = streamedAssistantItem(state.items)
      if (streamed && streamed.text === action.text) return state
      const items = closeThinking(state.items, action.atMs)
      const item: ChatItem = {
        kind: 'assistant', id: state.nextId, text: action.text,
        interrupted: action.interrupted ?? false,
      }
      return { ...state, items: [...items, item], nextId: state.nextId + 1 }
    }

    case 'tool.call.delta': {
      // The name opens the card. It arrives on the call's first fragment, before a single
      // character of the argument — so the row appears at the moment the model commits to a
      // tool, not minutes later when it has finished describing what to do with it.
      if (action.name !== undefined) {
        const items = closeThinking(state.items, action.atMs)
        const item: ChatItem = {
          kind: 'tool', id: state.nextId, name: action.name, args: '',
          startedAtMs: action.atMs ?? 0, writing: true, callIndex: action.index,
        }
        return { ...state, items: [...items, item], nextId: state.nextId + 1 }
      }
      if (action.args === undefined || action.args === '') return state
      // Appended to the newest card still being written for THIS call. Matching on the index
      // rather than on position is what keeps parallel calls apart: they interleave in one
      // stream and are otherwise indistinguishable.
      let done = false
      const items = [...state.items].reverse().map((item): ChatItem => {
        if (done || item.kind !== 'tool' || item.writing !== true || item.callIndex !== action.index) return item
        done = true
        return { ...item, args: item.args + action.args }
      }).reverse()
      // A fragment with no card is a call whose opening fragment this window never saw.
      // Dropping it is right: half an argument under no name is not something to show.
      return done ? { ...state, items } : state
    }

    case 'tool.call': {
      // The other way a step's reasoning ends -- and the one the original code missed,
      // which is why every tool-calling step used to leave a live "thinking…" row behind.
      const items = closeThinking(state.items, action.atMs)
      // The authoritative call, completing the card that was being written for it. `args`
      // here is the assembled document the tool will actually run on; the streamed fragments
      // were only ever a view of it being produced, and may have been coalesced or dropped.
      // OLDEST first, unlike every other lookup here: `tool.call` fires once per call in the
      // order the calls were made, so two parallel calls to the same tool must complete
      // their cards in that same order or the two swap arguments.
      let completed = false
      const settled = items.map((item): ChatItem => {
        if (completed || item.kind !== 'tool' || item.writing !== true || item.name !== action.name) return item
        completed = true
        const { writing: _w, callIndex: _c, ...rest } = item
        return { ...rest, args: action.args }
      })
      if (completed) return { ...state, items: settled }

      // No card to complete: streaming is off, or this window was opened mid-step. The call
      // still happened, so it still gets a row.
      const item: ChatItem = {
        kind: 'tool', id: state.nextId, name: action.name, args: action.args,
        startedAtMs: action.atMs ?? 0,
      }
      return { ...state, items: [...items, item], nextId: state.nextId + 1 }
    }

    case 'verify': {
      const detail = action.problem !== undefined
        ? action.problem
        : action.ok
        ? 'passed'
        : `exited ${action.exitCode ?? '?'}${action.attempt > 1 ? ` (after ${action.attempt - 1} fix)` : ''}`
      const item: ChatItem = {
        kind: 'verify-record', id: state.nextId, command: action.command, ok: action.ok, detail,
        ...(action.folder !== undefined ? { folder: action.folder } : {}),
      }
      return { ...state, items: [...state.items, item], nextId: state.nextId + 1 }
    }

    case 'tool.result': {
      const pending = pendingTool(state.items)
      if (!pending) return state // a result with no matching pending call is a no-op, not a crash
      // `live` is dropped, deliberately: it was the view of the run in progress, and the
      // result below is the same bytes as their complete, authoritative record.
      const { live: _live, ...withoutLive } = pending
      const updated: ChatItem = {
        ...withoutLive,
        result: {
          ok: action.ok,
          preview: preview(action.content),
          content: action.content,
          display: action.display ?? action.content,
        },
      }
      return { ...state, items: state.items.map((i) => (i.id === pending.id ? updated : i)) }
    }

    case 'step.done':
      return {
        ...state,
        // Backstop: a step that emitted reasoning and then nothing else (no text, no tool
        // call -- e.g. it hit its timeout) still has to stop animating.
        items: closeThinking(state.items, action.atMs),
        currentStep: null,
        // Merged, not replaced. A step that was aborted or timed out reports no
        // promptTokens, and replacing wholesale then wiped the count an EARLIER step in
        // the same turn had already reported -- taking the whole context bar, tok/s and
        // MTP readout off the status bar for the entire idle period afterwards, which is
        // exactly when the user looks at them.
        lastStepDone: {
          step: action.step,
          seconds: action.seconds,
          tokensPerSecond: action.tokensPerSecond ?? state.lastStepDone?.tokensPerSecond,
          promptTokens: action.promptTokens ?? state.lastStepDone?.promptTokens,
          draftAcceptance: action.draftAcceptance ?? state.lastStepDone?.draftAcceptance,
          contextUsed: action.contextUsed ?? state.lastStepDone?.contextUsed,
          compactAt: action.compactAt ?? state.lastStepDone?.compactAt,
          // The flag travels with the number it describes: when a step reports no count of
          // its own (aborted, timed out) and the carried-over count was an estimate, it is
          // STILL an estimate — dropping the flag here presented a compaction's or a restore's
          // guess as a server reading. A real count arriving clears it by construction.
          ...(action.promptTokens === undefined && state.lastStepDone?.estimated === true
            ? { estimated: true } : {}),
        },
      }

    case 'turn.done': {
      // A turn.done for a turn THIS state never started. Switching sessions mid-turn
      // aborts the old one host-side, and its `turn.done` arrives after `session-switched`
      // has already reset everything -- which used to append "Stopped by you." as the
      // first and only row of a session the user had not typed a word into. Every
      // legitimate turn.done follows the `turn-started` the composer dispatches
      // synchronously before its `send` call, so `turnRunning` is the exact discriminator.
      if (!state.turnRunning) return state
      // A turn the host says was never delivered (Esc during contract distillation): the
      // user message is not in any transcript, so nothing may claim it happened. The
      // optimistic row is removed — not marked "stopped", which reads as "kept" — and its
      // text goes back to the composer through `restoreDraft`. Watched live: the old
      // banner promised "continues from here" over a message the model never received,
      // and the next "continue" would have continued from nothing.
      if (action.delivered === false) {
        const lastUser = state.items.map((i) => i.kind).lastIndexOf('user')
        const row = lastUser === -1 ? null : state.items[lastUser]!
        return {
          ...state,
          items: lastUser === -1 ? state.items : state.items.filter((_, i) => i !== lastUser),
          turnRunning: false, currentStep: null,
          restoreDraft: row !== null && 'text' in row ? (row as { text: string }).text : null,
          pendingApproval: null, pendingQuestion: null,
        }
      }
      // An aborted turn's partial assistant text (if any) is marked `interrupted` so the
      // UI can show the "[interrupted]" marker next to it. Reasoning is closed first:
      // interrupting mid-thought is exactly the case that used to leave a pulsing row.
      const closed = closeWritingCalls(closeThinking(state.items, action.atMs))
      const assistant = lastAssistantItem(closed)
      const marked = assistant && action.stoppedBecause === 'aborted'
        ? [...closed.slice(0, -1), { ...assistant, interrupted: true }]
        : closed
      const items = action.stoppedBecause === 'done'
        ? marked
        : [...marked, { kind: 'stopped' as const, id: state.nextId, reason: action.stoppedBecause }]
      const nextId = action.stoppedBecause === 'done' ? state.nextId : state.nextId + 1
      // Pending interaction cards die with the turn: the host's abort()/switch already
      // resolved them as denied on its side, so a card left visible here would be a ghost
      // whose "Allow" authorizes nothing (the polish review's Important 2) -- clearing
      // them on turn.done keeps the UI and the host telling the same story.
      return {
        ...state, items, nextId, turnRunning: false, currentStep: null,
        pendingApproval: null, pendingQuestion: null,
      }
    }

    case 'send-failed': {
      const items = closeWritingCalls(closeThinking(state.items, action.atMs))
      const item: ChatItem = { kind: 'error', id: state.nextId, message: action.message }
      return { ...state, items: [...items, item], turnRunning: false, currentStep: null, nextId: state.nextId + 1 }
    }

    case 'error-note': {
      // The row and nothing else — see the action's doc comment for why this must not
      // touch turnRunning/currentStep or close writing cards.
      const item: ChatItem = { kind: 'error', id: state.nextId, message: action.message }
      return { ...state, items: [...state.items, item], nextId: state.nextId + 1 }
    }

    case 'approval.request':
      return {
        ...state,
        pendingApproval: {
          requestId: action.requestId,
          tool: action.tool,
          summary: action.summary,
          detail: action.detail,
          suggestedRules: action.suggestedRules,
        },
      }

    case 'approval.answered': {
      // No pending card to answer is a no-op, not a crash -- e.g. a card whose
      // `pendingApproval` was already cleared (a stray second dispatch cannot fire twice).
      if (!state.pendingApproval) return state
      const item: ChatItem = {
        kind: 'approval-record',
        id: state.nextId,
        tool: state.pendingApproval.tool,
        summary: state.pendingApproval.summary,
        decision: action.decision,
      }
      return { ...state, items: [...state.items, item], pendingApproval: null, nextId: state.nextId + 1 }
    }

    case 'question.request':
      return {
        ...state,
        pendingQuestion: {
          requestId: action.requestId, question: action.question, options: action.options,
          ...(action.multiSelect === true ? { multiSelect: true } : {}),
        },
      }

    case 'question.answered': {
      if (!state.pendingQuestion) return state
      const item: ChatItem = {
        kind: 'question-record', id: state.nextId, question: state.pendingQuestion.question, answer: action.answer,
      }
      return { ...state, items: [...state.items, item], pendingQuestion: null, nextId: state.nextId + 1 }
    }

    case 'decisions.changed':
      return { ...state, pendingDecisions: action.pending }

    case 'run-started':
      // `lastRun` is cleared here AND on `run.turn`: here so the ended card of the previous
      // run does not sit beside the new one's banner, and there because a host-driven run
      // (one this window did not start) never dispatches this action at all.
      return {
        ...state,
        run: {
          turn: 0,
          task: action.task,
          startedAtMs: action.atMs,
          ...(action.maxTurns !== undefined ? { maxTurns: action.maxTurns } : {}),
          ...(action.maxHours !== undefined ? { maxHours: action.maxHours } : {}),
        },
        lastRun: null,
      }

    case 'run.turn':
      // The event carries only the turn number. Everything else — task, budgets, start
      // time — survives from `run-started` when this window started the run, and is honest
      // absence when it did not.
      return {
        ...state,
        run: state.run
          ? { ...state.run, turn: action.turn }
          : { turn: action.turn, task: '', startedAtMs: 0 },
        lastRun: null,
      }

    case 'run.ended':
      return {
        ...state,
        run: null,
        lastRun: { turns: action.turns, stoppedBecause: action.stoppedBecause, detail: action.detail },
        // The host denies every pending interaction when a run ends (`denyAllPending`), so a
        // card left from mid-run is answering a question that no longer exists: it sat on
        // screen saying "Paused, waiting for you" forever, and clicking Allow appended a
        // permanent "allowed" record for a tool that never ran.
        pendingApproval: null,
        pendingQuestion: null,
      }

    case 'run-dismissed':
      return { ...state, lastRun: null }

    case 'draft-restored':
      return { ...state, restoreDraft: null }

    case 'tool.output': {
      // Live console output attaches to the RUNNING call — the last tool item without a
      // result. Tail-capped: this is a viewport onto a stream, not the record of it (the
      // tool result carries the record, with its own honest clipping rules).
      const running = pendingTool(state.items)
      if (!running) return state
      const joined = (running.live ?? '') + action.text
      const live = joined.length > LIVE_OUTPUT_TAIL_CHARS
        ? `…${joined.slice(-LIVE_OUTPUT_TAIL_CHARS)}`
        : joined
      return {
        ...state,
        items: state.items.map((i) => (i.id === running.id ? { ...running, live } : i)),
      }
    }

    case 'send-rolled-back': {
      // Undo BOTH halves of the optimism: the flag and the message row. The refused send
      // is re-queued by the composer, so leaving the row in place rendered the same text
      // twice once the queue drained. The last user item is the optimistic one — a refusal
      // means a run holds the slot, and a run never appends user messages.
      const lastUser = state.items.map((i) => i.kind).lastIndexOf('user')
      return {
        ...state,
        turnRunning: false,
        currentStep: null,
        items: lastUser === -1 ? state.items : state.items.filter((_, i) => i !== lastUser),
      }
    }

    case 'todos':
      return { ...state, todos: action.items }

    case 'settings-problem': {
      const text = action.text.trim()
      // Capped: a settings file that fails to parse can produce one problem per rule, and
      // a strip that grows without bound is a strip nobody reads.
      if (text === '' || state.problems.includes(text) || state.problems.length >= 10) return state
      return { ...state, problems: [...state.problems, text] }
    }

    case 'problems-dismissed':
      return { ...state, problems: [] }

    case 'session-switched':
      // A full reset, deliberately: see this action's own doc comment for why an old
      // session's transcript/pending cards must not survive into a new one's view.
      //
      // `nextId` is the ONE thing carried across. Item ids are consumed outside this
      // reducer as identities, not as indices: `tree.tsx` remembers which tool items it
      // has already acted on in a set that is never cleared, so restarting at 1 made new
      // items collide with remembered old ones and roughly every second write silently
      // failed to refresh the file tree.
      return {
        ...initialChatState(),
        nextId: state.nextId,
        session: {
          sessionId: action.sessionId, mode: action.mode, contextLength: action.contextLength, title: action.title,
        },
        // Seeded from the transcript that was just restored, so the context bar has
        // something true to show before the first message rather than after it.
        lastStepDone: action.contextUsed === undefined ? null : {
          step: 0,
          seconds: 0,
          tokensPerSecond: undefined,
          promptTokens: action.contextUsed.promptTokens ?? action.contextUsed.approxTokens,
          draftAcceptance: undefined,
          estimated: action.contextUsed.promptTokens === null,
          // Already corrected by `Session.contextUsage()`, so the same number serves both.
          // `compactAt` rides the same reply, so a resumed session colours its bar against
          // the real threshold from the first paint rather than against 80% of the window —
          // on a default setup those are 140k and 210k, and the gap is exactly the stretch
          // where you reopen a long conversation and look at the bar to decide what to do.
          contextUsed: action.contextUsed.promptTokens ?? action.contextUsed.approxTokens,
          compactAt: action.compactAt,
        },
      }

    case 'mode-changed':
      return {
        ...state,
        session: state.session ? { ...state.session, mode: action.mode } : state.session,
      }

    case 'compaction-restored': {
      // No token sizes: they were live measurements of a moment that is over, and the file
      // records only the briefing and how many messages it replaced. The card shows what is
      // known rather than defaulting the rest to zero — which is precisely how a real
      // 214-message compaction once came back as "0 → 0 (0% freed)".
      const item: ChatItem = {
        kind: 'compaction-record',
        id: state.nextId,
        state: 'applied',
        summary: action.summary,
        ...(action.droppedMessages !== undefined ? { droppedMessages: action.droppedMessages } : {}),
      }
      return { ...state, items: [...state.items, item], nextId: state.nextId + 1 }
    }

    case 'compaction': {
      const next = {
        ...state,
        lastCompaction: {
          state: action.state, droppedMessages: action.droppedMessages, seq: (state.lastCompaction?.seq ?? 0) + 1,
        },
        // The context meter reads `lastStepDone.promptTokens`, and the next server-measured
        // count is a whole generation away: it rides the first `step.done` of the NEXT turn.
        // So the meter kept showing the pre-compaction number long after the row here said
        // "compacted" — reported from the running app as the bar only moving "some time into
        // the next message". The applied event carries the new transcript's own estimate, so
        // seed the meter from it the way `session-switched` seeds a restored session:
        // flagged as an estimate until a real measurement replaces it.
        ...(action.state === 'applied' && action.detail !== undefined ? {
          lastStepDone: {
            step: state.lastStepDone?.step ?? 0,
            seconds: state.lastStepDone?.seconds ?? 0,
            tokensPerSecond: state.lastStepDone?.tokensPerSecond,
            promptTokens: action.detail.afterTokens,
            draftAcceptance: state.lastStepDone?.draftAcceptance,
            estimated: true,
            contextUsed: action.detail.afterTokens,
            // The threshold does not change when a compaction lands, so it survives.
            compactAt: state.lastStepDone?.compactAt,
          },
        } : {}),
      }

      // ONE row per compaction, live from the moment it starts, updated in place to whatever
      // it turns out to be. In the transcript rather than the status bar, because it happens
      // at a point in the conversation and means nothing away from it — and because a status
      // line that outlives its event is what made this look stuck in the first place.
      if (action.state === 'started') {
        const item: ChatItem = { kind: 'compaction-record', id: state.nextId, state: 'running' }
        return { ...next, items: [...state.items, item], nextId: state.nextId + 1 }
      }
      // `ready` is the summary arriving, not the swap landing — and it used to update
      // nothing at all, which is the bug this line replaces. The swap happens inside the
      // NEXT send() (session.ts), so after a background compaction finishes, a user who
      // simply waits is looking at a row that says "compacting…" and a spinner that will
      // never stop. Reported as "it spins forever, I waited 30 minutes". It was not stuck:
      // it was finished and waiting for a message the row never asked for.
      const outcome: 'ready' | 'applied' | 'skipped' | 'failed' = action.state === 'ready'
        ? 'ready'
        : action.state === 'applied'
        ? 'applied'
        : action.state === 'postponed' ? 'skipped' : 'failed'
      let updated = false
      const items: ChatItem[] = [...state.items].reverse().map((item): ChatItem => {
        // `ready` closes a running row; `applied` then closes the ready one. Both are live
        // rows waiting for an outcome, so both are what a later event may land on.
        const live = item.kind === 'compaction-record' &&
          (item.state === 'running' || item.state === 'ready')
        if (updated || !live) return item
        updated = true
        // `progress` goes with the running state that owned it. Nothing renders it on a
        // closed row, so keeping it would be invisible rather than wrong — which is exactly
        // how a stale reading survives to be shown by some later change.
        const { progress: _finished, ...carried } = item
        return {
          ...carried,
          state: outcome,
          ...(action.droppedMessages !== undefined ? { droppedMessages: action.droppedMessages } : {}),
          ...(action.reason !== undefined ? { reason: action.reason } : {}),
          ...(action.detail ?? {}),
        }
      }).reverse()
      // No live row to close — a compaction whose 'started' this window never saw, because
      // it was opened mid-flight. The outcome is still worth a row of its own.
      if (!updated) {
        const item: ChatItem = {
          kind: 'compaction-record',
          id: state.nextId,
          state: outcome,
          ...(action.droppedMessages !== undefined ? { droppedMessages: action.droppedMessages } : {}),
          ...(action.reason !== undefined ? { reason: action.reason } : {}),
          ...(action.detail ?? {}),
        }
        return { ...next, items: [...state.items, item], nextId: state.nextId + 1 }
      }
      return { ...next, items }
    }

    default: {
      const _exhaustive: never = action
      return _exhaustive
    }
  }
}
