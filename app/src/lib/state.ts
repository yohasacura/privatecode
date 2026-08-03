import type { ApprovalDecision, TodoItem } from '@core/interaction'
import type { CompactionState, StoppedBecause } from '@core/host/protocol'
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
  | { kind: 'user'; id: number; text: string }
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
  | { kind: 'tool'; id: number; name: string; args: string; result?: { ok: boolean; preview: string; content: string } }
  /** A `send`/`abort` RPC call itself came back an error reply (e.g. "a turn is already
   * running", "no active session") -- rendered as a one-line note rather than silently
   * dropped, which is what a naive `.catch(() => {})` would otherwise do. */
  | { kind: 'error'; id: number; message: string }
  /** What an `approval.request` card COLLAPSES INTO once answered -- the plan's own
   * phrase for it -- so the transcript keeps a permanent one-line record after the live
   * card (rendered separately, above the input; see `approvals.tsx`) disappears. */
  | { kind: 'approval-record'; id: number; tool: string; summary: string; decision: ApprovalDecision }
  | { kind: 'question-record'; id: number; question: string; answer: string }

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
}

export interface StepTiming {
  step: number
  timeoutMs: number
  /** Set by the caller from `Date.now()` when dispatching `step.start` -- the reducer
   * itself never reads the clock (see this module's header comment), it only stores
   * whatever the caller supplies, so the countdown UI (which DOES need a real clock, in
   * `chat.tsx`) has a fixed point to count down from. */
  startedAtMs: number
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

export interface ChatState {
  items: ChatItem[]
  turnRunning: boolean
  currentStep: StepTiming | null
  lastStepDone: LastStepStats | null
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
  session: SessionInfo | null
  /** The most recent `compaction` event, plus a monotonic `seq` -- Task 8's status bar
   * renders this as a subtle, self-clearing flash ('compacting…', 'compacted: N messages
   * summarised', 'postponed'). Never cleared BY the reducer itself (there is no action
   * for "hide the flash now"; that is a timer, an impure concern status.tsx owns) -- `seq`
   * is what lets that timer's effect notice a SECOND event carrying the same `state`
   * string (e.g. two `'postponed'`s in a row) as a fresh occurrence worth re-flashing. */
  lastCompaction: { state: CompactionState; droppedMessages: number | undefined; seq: number } | null
}

export function initialChatState(): ChatState {
  return {
    items: [], turnRunning: false, currentStep: null, lastStepDone: null, nextId: 1,
    pendingApproval: null, pendingQuestion: null, todos: [], session: null, lastCompaction: null,
  }
}

export type ChatAction =
  | { type: 'user-message'; text: string }
  | { type: 'turn-started' }
  | { type: 'step.start'; step: number; timeoutMs: number; startedAtMs: number }
  | { type: 'thinking.delta'; text: string }
  /** `atMs` on this and the four actions below is the wall clock at which the caller saw
   * the event, used only to stamp `endedAtMs` on the reasoning item this action closes.
   * Optional throughout: a caller with no clock (a test) gets the same transcript, minus
   * the "thought for 12s" duration. */
  | { type: 'text.delta'; text: string; atMs?: number }
  | { type: 'assistant.text'; text: string; atMs?: number }
  | { type: 'tool.call'; name: string; args: string; atMs?: number }
  | { type: 'tool.result'; name: string; ok: boolean; content: string }
  | { type: 'step.done'; step: number; seconds: number; tokensPerSecond?: number; promptTokens?: number; draftAcceptance?: number; atMs?: number }
  | { type: 'turn.done'; stoppedBecause: StoppedBecause; atMs?: number }
  | { type: 'send-failed'; message: string; atMs?: number }
  /** Dispatched after every successful `init`/`sessions.new`/`sessions.resume` call --
   * every one of those is either this app run's first session or a deliberate switch to a
   * different one, so this always resets the whole transcript/turn/pending-card/todos
   * state alongside the new session info: an old session's messages and pending cards
   * have no business surviving into a new one's view. */
  | { type: 'session-switched'; sessionId: string; mode: AgentMode; contextLength: number | null; title: string }
  | { type: 'mode-changed'; mode: AgentMode }
  | { type: 'compaction'; state: CompactionState; droppedMessages?: number }
  | { type: 'approval.request'; requestId: string; tool: string; summary: string; detail: string; suggestedRules: string[] }
  /** Fired locally by `approvals.tsx` the instant the user clicks Allow/Deny -- BEFORE the
   * `approval.reply` RPC even resolves. This is what makes "pending -> answered" a
   * single-fire transition on the UI side too (not just server-side, where a stale
   * requestId is already refused): once this reducer has cleared `pendingApproval`, a
   * second click on a since-unmounted/disabled card has nothing left to dispatch against. */
  | { type: 'approval.answered'; decision: ApprovalDecision }
  | { type: 'question.request'; requestId: string; question: string; options: string[] }
  | { type: 'question.answered'; answer: string }
  | { type: 'todos'; items: TodoItem[] }

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

/** The most recent tool item still awaiting its result -- matched by recency, not by
 * name: tool calls run one at a time in this architecture (no concurrent tool execution,
 * per host.ts's own event-ordering contract: step.start -> deltas -> tool.call ->
 * [approval] -> tool.result, always before the NEXT tool.call or step.start), so "the
 * last item, if it's an unresolved tool call" is always the right one to patch -- and
 * stays correct even when the same tool is called twice in a row within one turn. */
function lastPendingTool(items: ChatItem[]): (ChatItem & { kind: 'tool' }) | undefined {
  const last = items[items.length - 1]
  return last?.kind === 'tool' && last.result === undefined ? last : undefined
}

export function reduceChat(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'user-message': {
      const item: ChatItem = { kind: 'user', id: state.nextId, text: action.text }
      return { ...state, items: [...state.items, item], nextId: state.nextId + 1 }
    }

    case 'turn-started':
      // A fresh turn starts clean: no leftover step timing/stats from the previous one.
      return { ...state, turnRunning: true, currentStep: null, lastStepDone: null }

    case 'step.start':
      return {
        ...state,
        // A step does NOT open a reasoning block here: the block is created lazily by the
        // first `thinking.delta` that actually arrives, so a step that goes straight to a
        // tool call or an answer leaves no empty "Thought" card behind. That a step is
        // running at all is `currentStep`/`turnRunning`, which the composer renders.
        currentStep: { step: action.step, timeoutMs: action.timeoutMs, startedAtMs: action.startedAtMs },
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
      // text.delta (there is already an assistant item open), the whole-string event
      // duplicates it -- ignored rather than appended again.
      if (lastAssistantItem(state.items)) return state
      const items = closeThinking(state.items, action.atMs)
      const item: ChatItem = { kind: 'assistant', id: state.nextId, text: action.text, interrupted: false }
      return { ...state, items: [...items, item], nextId: state.nextId + 1 }
    }

    case 'tool.call': {
      // The other way a step's reasoning ends -- and the one the original code missed,
      // which is why every tool-calling step used to leave a live "thinking…" row behind.
      const items = closeThinking(state.items, action.atMs)
      const item: ChatItem = { kind: 'tool', id: state.nextId, name: action.name, args: action.args }
      return { ...state, items: [...items, item], nextId: state.nextId + 1 }
    }

    case 'tool.result': {
      const pending = lastPendingTool(state.items)
      if (!pending) return state // a result with no matching pending call is a no-op, not a crash
      const updated: ChatItem = {
        ...pending, result: { ok: action.ok, preview: preview(action.content), content: action.content },
      }
      return { ...state, items: [...state.items.slice(0, -1), updated] }
    }

    case 'step.done':
      return {
        ...state,
        // Backstop: a step that emitted reasoning and then nothing else (no text, no tool
        // call -- e.g. it hit its timeout) still has to stop animating.
        items: closeThinking(state.items, action.atMs),
        currentStep: null,
        lastStepDone: {
          step: action.step,
          seconds: action.seconds,
          tokensPerSecond: action.tokensPerSecond,
          promptTokens: action.promptTokens,
          draftAcceptance: action.draftAcceptance,
        },
      }

    case 'turn.done': {
      // An aborted turn's partial assistant text (if any) is marked `interrupted` so the
      // UI can show the "[interrupted]" marker next to it. Reasoning is closed first:
      // interrupting mid-thought is exactly the case that used to leave a pulsing row.
      const closed = closeThinking(state.items, action.atMs)
      const assistant = lastAssistantItem(closed)
      const items = assistant && action.stoppedBecause === 'aborted'
        ? [...closed.slice(0, -1), { ...assistant, interrupted: true }]
        : closed
      // Pending interaction cards die with the turn: the host's abort()/switch already
      // resolved them as denied on its side, so a card left visible here would be a ghost
      // whose "Allow" authorizes nothing (the polish review's Important 2) -- clearing
      // them on turn.done keeps the UI and the host telling the same story.
      return {
        ...state, items, turnRunning: false, currentStep: null,
        pendingApproval: null, pendingQuestion: null,
      }
    }

    case 'send-failed': {
      const items = closeThinking(state.items, action.atMs)
      const item: ChatItem = { kind: 'error', id: state.nextId, message: action.message }
      return { ...state, items: [...items, item], turnRunning: false, currentStep: null, nextId: state.nextId + 1 }
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
        pendingQuestion: { requestId: action.requestId, question: action.question, options: action.options },
      }

    case 'question.answered': {
      if (!state.pendingQuestion) return state
      const item: ChatItem = {
        kind: 'question-record', id: state.nextId, question: state.pendingQuestion.question, answer: action.answer,
      }
      return { ...state, items: [...state.items, item], pendingQuestion: null, nextId: state.nextId + 1 }
    }

    case 'todos':
      return { ...state, todos: action.items }

    case 'session-switched':
      // A full reset, deliberately: see this action's own doc comment for why an old
      // session's transcript/pending cards must not survive into a new one's view.
      return {
        ...initialChatState(),
        session: {
          sessionId: action.sessionId, mode: action.mode, contextLength: action.contextLength, title: action.title,
        },
      }

    case 'mode-changed':
      return {
        ...state,
        session: state.session ? { ...state.session, mode: action.mode } : state.session,
      }

    case 'compaction':
      return {
        ...state,
        lastCompaction: {
          state: action.state, droppedMessages: action.droppedMessages, seq: (state.lastCompaction?.seq ?? 0) + 1,
        },
      }

    default: {
      const _exhaustive: never = action
      return _exhaustive
    }
  }
}
