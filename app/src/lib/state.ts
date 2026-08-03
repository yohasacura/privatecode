import type { ApprovalDecision, TodoItem } from '@core/interaction'
import type { StoppedBecause } from '@core/host/protocol'

/**
 * The chat panel's pure transcript reducer (Plan 4 Task 5): every protocol event that
 * touches the transcript is turned into a `ChatAction`, folded through `reduceChat` into a
 * new `ChatState` -- no DOM, no timers, no `Date.now()`/`Math.random()`, so the whole
 * delta-accumulate / step-reset / interrupt behavior is unit-testable without a client, a
 * transport, or Preact at all. `chat.tsx` owns the impure half: subscribing to
 * `ProtocolClient` events, calling `dispatch`, and rendering `state.items` in order.
 *
 * Two behaviors mirror `core/src/cli/render.ts`'s streaming REPL renderer on purpose (the
 * plan calls this out explicitly):
 * - A step's `thinking` item grows (one line, a running token-count estimate) for as long
 *   as only `thinking.delta` events arrive. The instant a `text.delta` arrives for that
 *   step, the thinking item is REMOVED (not just stopped) and a growing `assistant` item
 *   takes its place -- `render.ts`'s `onThinking` guard (`if (streaming && textStreamed)
 *   return`) is the same suppression rule, adapted from "don't print a summary line" to
 *   "don't leave a stale thinking row sitting above the content".
 * - `assistant.text` (the non-streaming, whole-string event that always follows a step)
 *   is IGNORED when that step's content already streamed via `text.delta` -- appending it
 *   too would duplicate the same prose, matching `render.ts`'s `textStreamed` check in
 *   `onAssistantText`.
 */

export type ChatItem =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string; interrupted: boolean }
  | { kind: 'thinking'; id: number; step: number; chars: number }
  | { kind: 'tool'; id: number; name: string; args: string; result?: { ok: boolean; preview: string } }
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
}

export function initialChatState(): ChatState {
  return {
    items: [], turnRunning: false, currentStep: null, lastStepDone: null, nextId: 1,
    pendingApproval: null, pendingQuestion: null, todos: [],
  }
}

export type ChatAction =
  | { type: 'user-message'; text: string }
  | { type: 'turn-started' }
  | { type: 'step.start'; step: number; timeoutMs: number; startedAtMs: number }
  | { type: 'thinking.delta'; text: string }
  | { type: 'text.delta'; text: string }
  | { type: 'assistant.text'; text: string }
  | { type: 'tool.call'; name: string; args: string }
  | { type: 'tool.result'; name: string; ok: boolean; content: string }
  | { type: 'step.done'; step: number; seconds: number; tokensPerSecond?: number }
  | { type: 'turn.done'; stoppedBecause: StoppedBecause }
  | { type: 'send-failed'; message: string }
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

/** The current step's thinking item, if the LAST item in the transcript is one -- thinking
 * deltas only ever accumulate onto the most recently opened step's own line, never an
 * older one further back in the transcript. */
function lastThinkingItem(items: ChatItem[]): (ChatItem & { kind: 'thinking' }) | undefined {
  const last = items[items.length - 1]
  return last?.kind === 'thinking' ? last : undefined
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
        currentStep: { step: action.step, timeoutMs: action.timeoutMs, startedAtMs: action.startedAtMs },
        // A NEW step's thinking line always starts at 0 chars -- growing it from
        // whatever the PREVIOUS step's thinking item happened to reach would misreport
        // this step's own token estimate (the "step-reset" behavior the plan's unit
        // tests ask for by name).
        items: [...state.items, { kind: 'thinking', id: state.nextId, step: action.step, chars: 0 }],
        nextId: state.nextId + 1,
      }

    case 'thinking.delta': {
      const thinking = lastThinkingItem(state.items)
      if (!thinking) return state // a delta arriving with no open thinking line is a no-op, not a crash
      const updated: ChatItem = { ...thinking, chars: thinking.chars + action.text.length }
      return { ...state, items: [...state.items.slice(0, -1), updated] }
    }

    case 'text.delta': {
      const thinking = lastThinkingItem(state.items)
      const assistant = lastAssistantItem(state.items)
      if (assistant) {
        const updated: ChatItem = { ...assistant, text: assistant.text + action.text }
        return { ...state, items: [...state.items.slice(0, -1), updated] }
      }
      // First text.delta of this step: the REPL's suppression rule, restated for a
      // transcript -- the thinking line is REPLACED (removed, not merely frozen) by a
      // fresh assistant item that starts accumulating streamed content.
      const withoutThinking = thinking ? state.items.slice(0, -1) : state.items
      const item: ChatItem = { kind: 'assistant', id: state.nextId, text: action.text, interrupted: false }
      return { ...state, items: [...withoutThinking, item], nextId: state.nextId + 1 }
    }

    case 'assistant.text': {
      // Mirrors render.ts's onAssistantText: if this step's content already streamed via
      // text.delta (there is already an assistant item open), the whole-string event
      // duplicates it -- ignored rather than appended again.
      if (lastAssistantItem(state.items)) return state
      const item: ChatItem = { kind: 'assistant', id: state.nextId, text: action.text, interrupted: false }
      return { ...state, items: [...state.items, item], nextId: state.nextId + 1 }
    }

    case 'tool.call': {
      const item: ChatItem = { kind: 'tool', id: state.nextId, name: action.name, args: action.args }
      return { ...state, items: [...state.items, item], nextId: state.nextId + 1 }
    }

    case 'tool.result': {
      const pending = lastPendingTool(state.items)
      if (!pending) return state // a result with no matching pending call is a no-op, not a crash
      const updated: ChatItem = { ...pending, result: { ok: action.ok, preview: preview(action.content) } }
      return { ...state, items: [...state.items.slice(0, -1), updated] }
    }

    case 'step.done':
      return {
        ...state,
        currentStep: null,
        lastStepDone: { step: action.step, seconds: action.seconds, tokensPerSecond: action.tokensPerSecond },
      }

    case 'turn.done': {
      // An aborted turn's partial assistant text (if any) is marked `interrupted` so the
      // UI can show the "[interrupted]" marker next to it -- see chat.tsx.
      const assistant = lastAssistantItem(state.items)
      const items = assistant && action.stoppedBecause === 'aborted'
        ? [...state.items.slice(0, -1), { ...assistant, interrupted: true }]
        : state.items
      return { ...state, items, turnRunning: false, currentStep: null }
    }

    case 'send-failed': {
      const item: ChatItem = { kind: 'error', id: state.nextId, message: action.message }
      return { ...state, items: [...state.items, item], turnRunning: false, currentStep: null, nextId: state.nextId + 1 }
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

    default: {
      const _exhaustive: never = action
      return _exhaustive
    }
  }
}
