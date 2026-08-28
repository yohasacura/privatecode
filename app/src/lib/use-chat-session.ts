import { useEffect, useReducer } from 'preact/hooks'
import type { ProtocolClient } from './client'
import { type ChatAction, type ChatState, initialChatState, reduceChat } from './state'
import { notify } from './notify'
import { formatDuration } from './format'

/**
 * How long a turn has to run before its ending is worth a notification.
 *
 * `notify` already declines while the window is focused, so this is not about noise while
 * you are watching — it is about the twenty seconds you spend in another window during a
 * quick turn. A minute is comfortably longer than that and far shorter than the hours this
 * is really for.
 */
const LONG_TURN_MS = 60_000

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
    /** When the running turn's first step began, or 0 between turns. See `turn.done`. */
    let turnStartedAtMs = 0

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
    let toolOutputBuffer = ''
    /** Per call index, because parallel calls interleave in one stream and concatenating
     * them into one buffer would splice two JSON documents together. */
    const argsBuffer = new Map<number, string>()
    let frame: number | null = null
    /** rAF does not tick in a hidden window (minimised app, background WebView) — found
     * live when a running command's output never rendered on an unfocused pane. The
     * timeout is the backstop that keeps dispatches flowing there; whichever fires first
     * cancels the other. 100ms: imperceptible when visible, cheap when not. */
    let backstop: ReturnType<typeof setTimeout> | null = null
    function schedule(): void {
      frame ??= requestAnimationFrame(flush)
      backstop ??= setTimeout(flush, 100)
    }

    function flush(): void {
      if (frame !== null) { cancelAnimationFrame(frame); frame = null }
      if (backstop !== null) { clearTimeout(backstop); backstop = null }
      // Anything at all having streamed is proof the step is alive, which is exactly what
      // the core's deadline measures — it re-arms on every delta (`Agent.stepClock`). Sent
      // once per frame rather than per delta: the countdown only needs to know the step is
      // not silent, and the three buffers below are the same frame's worth of evidence.
      if (thinkingBuffer !== '' || textBuffer !== '' || toolOutputBuffer !== '' || argsBuffer.size > 0) {
        dispatch({ type: 'step.alive', atMs: Date.now() })
      }
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
      if (toolOutputBuffer !== '') {
        const text = toolOutputBuffer
        toolOutputBuffer = ''
        dispatch({ type: 'tool.output', text })
      }
      if (argsBuffer.size > 0) {
        // Drained into a list first: dispatching while iterating the map would let a delta
        // arriving synchronously in a reducer's wake mutate what is still being read.
        const pending = [...argsBuffer.entries()]
        argsBuffer.clear()
        for (const [index, args] of pending) dispatch({ type: 'tool.call.delta', index, args })
      }
    }

    function buffer(into: 'thinking' | 'text', text: string): void {
      if (into === 'thinking') thinkingBuffer += text
      else textBuffer += text
      schedule()
    }

    function bufferArgs(index: number, args: string): void {
      argsBuffer.set(index, (argsBuffer.get(index) ?? '') + args)
      schedule()
    }

    /**
     * Everything that is NOT streamed text goes through here, and it drains the buffer first.
     *
     * Order is the whole point: a tool call recorded before the reasoning that led to it, or
     * a step closed before its own last words arrived, would be a worse defect than the
     * stutter this fixes.
     */
    function emit(action: ChatAction): void {
      flush()
      dispatch(action)
    }
    const unsubs = [
      client.on('step.start', (d) => {
        // The FIRST step 1 of the turn, not every one. A turn can contain several step-1s:
        // the verify fixer runs its own `runTurn`, and so does the overflow retry, each
        // starting its step count over. Keying on `d.step === 1` alone therefore restarted
        // the clock hours into a long turn, and the notification it feeds would have
        // reported the length of the last fix rather than of the work — or, if the fixer
        // finished quickly, said nothing at all.
        if (d.step === 1 && turnStartedAtMs === 0) turnStartedAtMs = Date.now()
        dispatch({
          type: 'step.start', step: d.step, timeoutMs: d.timeoutMs, startedAtMs: Date.now(),
          ...(d.firstTokenTimeoutMs !== undefined ? { firstTokenTimeoutMs: d.firstTokenTimeoutMs } : {}),
        })
      }),
      // Through `emit`, not a bare dispatch — the ordering IS the feature. A continuation
      // fires right after the last streamed delta, which is still sitting in the buffer
      // with an animation frame pending; dispatched around the buffer, that frame's flush
      // landed a `step.alive` AFTER this action and knocked `waitingFirstToken` back to
      // false, so the countdown judged the continuation's minutes-long re-prefill against
      // the flat between-token budget — the exact false alarm this event exists to stop.
      client.on('step.continuation', (d) => emit({
        type: 'step.continuation', atMs: Date.now(),
        ...(d.firstTokenTimeoutMs !== undefined ? { firstTokenTimeoutMs: d.firstTokenTimeoutMs } : {}),
      })),
      // Also through `emit`, and here the buffer holds the DEAD attempt's last deltas:
      // flushing first attaches them to the cards this action removes, so the retry's
      // fresh stream opens clean ones instead of appending to a corpse.
      client.on('step.retry', () => emit({ type: 'step.retry', atMs: Date.now() })),
      client.on('thinking.delta', (d) => buffer('thinking', d.text)),
      // A running command's stdout, coalesced per frame like every other stream: a `dir /s`
      // can emit hundreds of chunks a second, and each dispatch is a re-render.
      client.on('tool.output', (d) => { toolOutputBuffer += d.text; schedule() }),
      // `atMs` is the wall clock at which this event arrived; the reducer uses it only to
      // stamp the end of the reasoning block each of these closes (see state.ts).
      client.on('text.delta', (d) => buffer('text', d.text)),
      client.on('assistant.text', (d) => emit({ type: 'assistant.text', text: d.text, atMs: Date.now() })),
      // The NAME goes through `emit`, not the buffer: it opens the card, and it has to be
      // ordered against the reasoning that precedes it (emit drains the buffer first) or the
      // card lands above the thinking that led to it. The arguments are coalesced per frame
      // like any other stream — on a large edit they arrive in hundreds of fragments.
      client.on('tool.call.delta', (d) => {
        if (d.name !== undefined) {
          emit({ type: 'tool.call.delta', index: d.index, name: d.name, atMs: Date.now() })
        }
        if (d.args !== undefined && d.args !== '') bufferArgs(d.index, d.args)
      }),
      client.on('tool.call', (d) => emit({ type: 'tool.call', name: d.name, args: d.args, atMs: Date.now() })),
      client.on('tool.result', (d) => emit({
        type: 'tool.result', name: d.name, ok: d.ok, content: d.content,
        ...(d.display !== undefined ? { display: d.display } : {}),
      })),
      client.on('stage', (d) => emit({
        type: 'stage',
        stage: d.stage,
        state: d.state,
        ...(d.detail !== undefined ? { detail: d.detail } : {}),
        ...(d.at !== undefined ? { at: d.at } : {}),
        ...(d.outcome !== undefined ? { outcome: d.outcome } : {}),
        ...(d.ms !== undefined ? { ms: d.ms } : {}),
      })),
      client.on('generation.progress', (d) => emit({
        type: 'generation.progress',
        scope: d.scope,
        // Rebuilt rather than spread so a future field on the wire cannot arrive in the
        // reducer's state unannounced. One of the two is present, never both.
        progress: {
          ...(d.prompt !== undefined ? { prompt: d.prompt } : {}),
          ...(d.generated !== undefined ? { generated: d.generated } : {}),
        },
      })),
      client.on('step.done', (d) => emit({
        type: 'step.done',
        step: d.step,
        seconds: d.seconds,
        atMs: Date.now(),
        ...(d.tokensPerSecond !== undefined ? { tokensPerSecond: d.tokensPerSecond } : {}),
        ...(d.promptTokens !== undefined ? { promptTokens: d.promptTokens } : {}),
        ...(d.draftAcceptance !== undefined ? { draftAcceptance: d.draftAcceptance } : {}),
        ...(d.contextUsed !== undefined ? { contextUsed: d.contextUsed } : {}),
        ...(d.compactAt !== undefined ? { compactAt: d.compactAt } : {}),
      })),
      client.on('turn.done', (d) => {
        emit({
          type: 'turn.done', stoppedBecause: d.stoppedBecause, atMs: Date.now(),
          ...(d.delivered === false ? { delivered: false as const } : {}),
        })
        // A turn ending became a walk-away event, and nothing said so.
        //
        // Only an unattended RUN ever announced itself, because a turn was capped at forty
        // steps — ten minutes, which you wait out. With no ceiling a single typed request
        // can run for hours, and the person who typed it has no reason to sit there. `notify`
        // already declines while the window is focused, so this cannot fire at someone who
        // is watching.
        const ranMs = turnStartedAtMs === 0 ? 0 : Date.now() - turnStartedAtMs
        turnStartedAtMs = 0
        if (ranMs < LONG_TURN_MS) return
        void notify(
          d.stoppedBecause === 'done' ? 'PrivateCode finished' : `PrivateCode stopped: ${d.stoppedBecause}`,
          `The turn ran for ${formatDuration(ranMs)}.`,
        )
      }),
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
        dispatch({
          type: 'question.request', requestId: d.requestId, question: d.question, options: d.options,
          ...(d.multiSelect === true ? { multiSelect: true as const } : {}),
        })
        void notify('PrivateCode has a question', d.question)
      }),
      client.on('todos', (d) => emit({ type: 'todos', items: d.items })),
      client.on('verify', (d) => emit({
        type: 'verify', command: d.command, ok: d.ok, attempt: d.attempt,
        ...(d.exitCode !== undefined ? { exitCode: d.exitCode } : {}),
        ...(d.problem !== undefined ? { problem: d.problem } : {}),
        // The folder the check ran in. `session.ts` emits it at all four onVerify sites and
        // the protocol calls it "the answer to a question a person actually has" -- it was
        // simply not forwarded, so in a multi-folder workspace two rows read
        // `verify npm test -- passed` / `-- exited 1` with nothing saying which folder.
        ...(d.folder !== undefined ? { folder: d.folder } : {}),
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
      client.on('run.turn', (d) => {
        // A run's turns do not each produce a `turn.done`, so this is where the clock has to
        // be released: without it, `turnStartedAtMs` kept the FIRST turn's start for the
        // whole run and the notification reported hours for a turn that took minutes.
        turnStartedAtMs = 0
        emit({ type: 'run.turn', turn: d.turn })
      }),
      client.on('run.ended', (d) => {
        // The run's clock must not leak into the next manual turn: left set, the first
        // follow-up after an overnight run notified "The turn ran for 9h" about a
        // ten-second reply.
        turnStartedAtMs = 0
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
        type: 'compaction',
        state: d.state,
        ...(d.droppedMessages !== undefined ? { droppedMessages: d.droppedMessages } : {}),
        // Forwarded, not dropped. The card was built to show before/after sizes and the
        // briefing, the core sends both, and this one line quietly kept neither — so it read
        // "0 → 0 (0% freed)… (the briefing was not recorded)" over a real 214-message
        // compaction. An event copied field by field is an event that loses whatever the
        // copy forgets.
        ...(d.detail !== undefined ? { detail: d.detail } : {}),
        ...(d.reason !== undefined ? { reason: d.reason } : {}),
      })),
    ]
    return () => {
      // A frame scheduled against a subscription that is going away would dispatch into a
      // session this hook has already left. The backstop is armed in the same places the
      // frame is, and leaking it means the same stale dispatch up to 100ms later.
      if (frame !== null) cancelAnimationFrame(frame)
      if (backstop !== null) clearTimeout(backstop)
      for (const u of unsubs) u()
    }
  }, [client])

  return [state, dispatch]
}
