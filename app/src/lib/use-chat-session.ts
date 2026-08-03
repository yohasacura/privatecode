import { useEffect, useReducer } from 'preact/hooks'
import type { ProtocolClient } from './client'
import { type ChatAction, type ChatState, initialChatState, reduceChat } from './state'

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
    const unsubs = [
      client.on('step.start', (d) =>
        dispatch({ type: 'step.start', step: d.step, timeoutMs: d.timeoutMs, startedAtMs: Date.now() })),
      client.on('thinking.delta', (d) => dispatch({ type: 'thinking.delta', text: d.text })),
      // `atMs` is the wall clock at which this event arrived; the reducer uses it only to
      // stamp the end of the reasoning block each of these closes (see state.ts).
      client.on('text.delta', (d) => dispatch({ type: 'text.delta', text: d.text, atMs: Date.now() })),
      client.on('assistant.text', (d) => dispatch({ type: 'assistant.text', text: d.text, atMs: Date.now() })),
      client.on('tool.call', (d) => dispatch({ type: 'tool.call', name: d.name, args: d.args, atMs: Date.now() })),
      client.on('tool.result', (d) => dispatch({ type: 'tool.result', name: d.name, ok: d.ok, content: d.content })),
      client.on('step.done', (d) => dispatch({
        type: 'step.done',
        step: d.step,
        seconds: d.seconds,
        atMs: Date.now(),
        ...(d.tokensPerSecond !== undefined ? { tokensPerSecond: d.tokensPerSecond } : {}),
        ...(d.promptTokens !== undefined ? { promptTokens: d.promptTokens } : {}),
        ...(d.draftAcceptance !== undefined ? { draftAcceptance: d.draftAcceptance } : {}),
      })),
      client.on('turn.done', (d) => dispatch({ type: 'turn.done', stoppedBecause: d.stoppedBecause, atMs: Date.now() })),
      client.on('approval.request', (d) => dispatch({
        type: 'approval.request', requestId: d.requestId, tool: d.tool, summary: d.summary,
        detail: d.detail, suggestedRules: d.suggestedRules,
      })),
      client.on('question.request', (d) => dispatch({
        type: 'question.request', requestId: d.requestId, question: d.question, options: d.options,
      })),
      client.on('todos', (d) => dispatch({ type: 'todos', items: d.items })),
      client.on('compaction', (d) => dispatch({
        type: 'compaction', state: d.state, ...(d.droppedMessages !== undefined ? { droppedMessages: d.droppedMessages } : {}),
      })),
    ]
    return () => { for (const u of unsubs) u() }
  }, [client])

  return [state, dispatch]
}
