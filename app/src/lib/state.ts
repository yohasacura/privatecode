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
}

export function initialChatState(): ChatState {
  return { items: [], turnRunning: false, currentStep: null, lastStepDone: null, nextId: 1 }
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

    default: {
      const _exhaustive: never = action
      return _exhaustive
    }
  }
}
