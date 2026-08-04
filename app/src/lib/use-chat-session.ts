import { useEffect, useReducer } from 'preact/hooks'
import type { ProtocolClient } from './client'
import { type ChatAction, type ChatState, initialChatState, reduceChat } from './state'
import { notify } from './notify'

/**
 * Subscribes ONE `ProtocolClient` to `lib/state.ts`'s reducer and returns `[state,
 * dispatch]` -- the single place every protocol event is turned into a `ChatAction`.
 *
 * Lifted out of `chat.tsx` (where it lived through Task 6) in Task 7: the tree panel's
 * refresh-on-write-tool-success and the diffs panel's per-session change list both need
 * the SAME tool.call/tool.result history the chat transcript already tracks. Rather than
 * three sibling panels each independently re-subscribing to `client.on('tool.call', ...)`
 * and re-deriving their own correlation between a call and its result (three chances for
 * that logic to drift apart), `App.tsx` calls this hook once and hands `state`/`dispatch`
 * down to all three.
 *
 * `client` is nullable because `App.tsx` cannot construct the real `ProtocolClient` until
 * its own mount effect runs (the client needs `window.location`) -- this hook itself
 * handles that gracefully rather than pushing a conditional-hook-call problem onto every
 * caller.
 */
export function useChatSession(client: ProtocolClient | null): [ChatState, (action: ChatAction) => void] {
  const [state, dispatch] = useReducer(reduceChat, undefined, initialChatState)

  useEffect(() => {
    if (!client) return
    // Per-subscription, not per-render: the point is to tell a RISE from a fall, and a
    // value that resets on every render can do neither.
    let lastPending = 0

    /**
     * Streamed text is coalesced into one dispatch per animation frame.
     *
     * Measured against this machine's server with no window in the path: 1200 deltas, half of
     * them within 0.3 ms of each other and a p90 gap of 62 ms — speculative decoding hands
     * over about three tokens at a time. The stream has no stall in it at all: one gap over
     * 300 ms in the whole run, and that was the prefill before the first token. So the
     * sub-second stutter reported during reasoning was never the model. It was this window
     * re-rendering a growing block of text once per delta, fifty times a second, three of
     * them back to back on every burst.
     *
     * A frame is the shortest interval a repaint can be seen in, so waiting for one loses
     * nothing — and a burst becomes one render instead of three.
     */
    let thinkingBuffer = ''
    let textBuffer = ''
    let frame: number | null = null

    function flush(): void {
      frame = null
      if (thinkingBuffer !== '') {
        const text = thinkingBuffer
        thinkingBuffer = ''
        dispatch({ type: 'thinking.delta', text })
      }
      if (textBuffer !== '') {
        const text = textBuffer
        textBuffer = ''
        dispatch({ type: 'text.delta', text, atMs: Date.now() })
      }
    }

    function buffer(into: 'thinking' | 'text', text: string): void {
      if (into === 'thinking') thinkingBuffer += text
      else textBuffer += text
      frame ??= requestAnimationFrame(flush)
    }

    /**
     * Everything that is NOT streamed text goes through here, and it drains the buffer first.
     *
     * Order is the whole point: a tool call recorded before the reasoning that led to it, or
     * a step closed before its own last words arrived, would be a worse defect than the
     * stutter this fixes.
     */
    function emit(action: ChatAction): void {
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }
      flush()
      dispatch(action)
    }
    const unsubs = [
      client.on('step.start', (d) =>
        dispatch({ type: 'step.start', step: d.step, timeoutMs: d.timeoutMs, startedAtMs: Date.now() })),
      client.on('thinking.delta', (d) => buffer('thinking', d.text)),
      // `atMs` is the wall clock at which this event arrived; the reducer uses it only to
      // stamp the end of the reasoning block each of these closes (see state.ts).
      client.on('text.delta', (d) => buffer('text', d.text)),
      client.on('assistant.text', (d) => emit({ type: 'assistant.text', text: d.text, atMs: Date.now() })),
      client.on('tool.call', (d) => emit({ type: 'tool.call', name: d.name, args: d.args, atMs: Date.now() })),
      client.on('tool.result', (d) => emit({
        type: 'tool.result', name: d.name, ok: d.ok, content: d.content,
        ...(d.display !== undefined ? { display: d.display } : {}),
      })),
      client.on('step.done', (d) => emit({
        type: 'step.done',
        step: d.step,
        seconds: d.seconds,
        atMs: Date.now(),
        ...(d.tokensPerSecond !== undefined ? { tokensPerSecond: d.tokensPerSecond } : {}),
        ...(d.promptTokens !== undefined ? { promptTokens: d.promptTokens } : {}),
        ...(d.draftAcceptance !== undefined ? { draftAcceptance: d.draftAcceptance } : {}),
      })),
      client.on('turn.done', (d) => emit({ type: 'turn.done', stoppedBecause: d.stoppedBecause, atMs: Date.now() })),
      client.on('approval.request', (d) => {
        dispatch({
          type: 'approval.request', requestId: d.requestId, tool: d.tool, summary: d.summary,
          detail: d.detail, suggestedRules: d.suggestedRules,
        })
        // A blocked turn is the most expensive thing to not notice: nothing else happens
        // until it is answered, and unattended it will eventually be parked instead.
        void notify('PrivateCode needs a decision', d.summary)
      }),
      client.on('question.request', (d) => {
        dispatch({ type: 'question.request', requestId: d.requestId, question: d.question, options: d.options })
        void notify('PrivateCode has a question', d.question)
      }),
      client.on('todos', (d) => emit({ type: 'todos', items: d.items })),
      client.on('verify', (d) => emit({
        type: 'verify', command: d.command, ok: d.ok, attempt: d.attempt,
        ...(d.exitCode !== undefined ? { exitCode: d.exitCode } : {}),
        ...(d.problem !== undefined ? { problem: d.problem } : {}),
      })),
      client.on('decisions.changed', (d) => {
        dispatch({ type: 'decisions.changed', pending: d.pending })
        // Only a RISE is news. The count also changes as you answer them, and being told
        // about your own clicks is noise.
        if (d.pending > lastPending) {
          void notify(
            'A question was parked',
            `${d.pending} decision${d.pending === 1 ? '' : 's'} waiting for you`,
          )
        }
        lastPending = d.pending
      }),
      client.on('run.turn', (d) => emit({ type: 'run.turn', turn: d.turn })),
      client.on('run.ended', (d) => {
        dispatch({ type: 'run.ended', stoppedBecause: d.stoppedBecause, detail: d.detail, turns: d.turns })
        void notify(
          `Run ended: ${d.stoppedBecause}`,
          `${d.turns} turn${d.turns === 1 ? '' : 's'} — ${d.detail}`,
        )
      }),
      // Nothing consumed this before: a settings file that failed to parse dropped the
      // user's deny rules with no signal anywhere in the UI.
      client.on('settings.problem', (d) => emit({ type: 'settings-problem', text: d.text })),
      client.on('compaction', (d) => emit({
        type: 'compaction', state: d.state, ...(d.droppedMessages !== undefined ? { droppedMessages: d.droppedMessages } : {}),
      })),
    ]
    return () => {
      // A frame scheduled against a subscription that is going away would dispatch into a
      // session this hook has already left.
      if (frame !== null) cancelAnimationFrame(frame)
      for (const u of unsubs) u()
    }
  }, [client])

  return [state, dispatch]
}
