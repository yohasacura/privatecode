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
    const unsubs = [
      client.on('step.start', (d) =>
        dispatch({ type: 'step.start', step: d.step, timeoutMs: d.timeoutMs, startedAtMs: Date.now() })),
      client.on('thinking.delta', (d) => dispatch({ type: 'thinking.delta', text: d.text })),
      // `atMs` is the wall clock at which this event arrived; the reducer uses it only to
      // stamp the end of the reasoning block each of these closes (see state.ts).
      client.on('text.delta', (d) => dispatch({ type: 'text.delta', text: d.text, atMs: Date.now() })),
      client.on('assistant.text', (d) => dispatch({ type: 'assistant.text', text: d.text, atMs: Date.now() })),
      client.on('tool.call', (d) => dispatch({ type: 'tool.call', name: d.name, args: d.args, atMs: Date.now() })),
      client.on('tool.result', (d) => dispatch({
        type: 'tool.result', name: d.name, ok: d.ok, content: d.content,
        ...(d.display !== undefined ? { display: d.display } : {}),
      })),
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
      client.on('todos', (d) => dispatch({ type: 'todos', items: d.items })),
      client.on('verify', (d) => dispatch({
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
      client.on('run.turn', (d) => dispatch({ type: 'run.turn', turn: d.turn })),
      client.on('run.ended', (d) => {
        dispatch({ type: 'run.ended', stoppedBecause: d.stoppedBecause, detail: d.detail, turns: d.turns })
        void notify(
          `Run ended: ${d.stoppedBecause}`,
          `${d.turns} turn${d.turns === 1 ? '' : 's'} — ${d.detail}`,
        )
      }),
      // Nothing consumed this before: a settings file that failed to parse dropped the
      // user's deny rules with no signal anywhere in the UI.
      client.on('settings.problem', (d) => dispatch({ type: 'settings-problem', text: d.text })),
      client.on('compaction', (d) => dispatch({
        type: 'compaction', state: d.state, ...(d.droppedMessages !== undefined ? { droppedMessages: d.droppedMessages } : {}),
      })),
    ]
    return () => { for (const u of unsubs) u() }
  }, [client])

  return [state, dispatch]
}
