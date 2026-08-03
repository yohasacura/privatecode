import { useEffect, useReducer, useState } from 'preact/hooks'
import type { AgentMode } from '@core/permissions/engine'
import type { ProtocolClient } from '../lib/client'
import { type ChatItem, initialChatState, reduceChat } from '../lib/state'
import { ApprovalCard, QuestionCard, TodosWidget } from './approvals'

const MODES: readonly AgentMode[] = ['normal', 'plan', 'auto-edit', 'autopilot']

/**
 * The chat panel (Plan 4 Tasks 5-6): message list (user/assistant/thinking/tool/approval-
 * record/question-record rows) over `lib/state.ts`'s pure reducer, an input row (Enter
 * sends, Shift+Enter newlines, Esc aborts), a mode selector, a todo checklist in the
 * header area, a turn-status row (step counter + timeout countdown, then step.done
 * numbers), and -- ABOVE the input row -- the approval/question card while one is pending
 * (see `approvals.tsx`).
 *
 * Dirty-tree checking for autopilot (a `git_status` host round-trip before the mode
 * actually takes effect) is explicitly deferred to Task 8's status-bar wiring, per the
 * plan brief -- this task's autopilot guard is ONLY the red styling + confirm click-through
 * described below, nothing that touches the workspace.
 */
export function ChatPanel({ client }: { client: ProtocolClient }) {
  const [state, dispatch] = useReducer(reduceChat, undefined, initialChatState)
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AgentMode>('normal')
  const [pendingAutopilot, setPendingAutopilot] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const unsubs = [
      client.on('step.start', (d) =>
        dispatch({ type: 'step.start', step: d.step, timeoutMs: d.timeoutMs, startedAtMs: Date.now() })),
      client.on('thinking.delta', (d) => dispatch({ type: 'thinking.delta', text: d.text })),
      client.on('text.delta', (d) => dispatch({ type: 'text.delta', text: d.text })),
      client.on('assistant.text', (d) => dispatch({ type: 'assistant.text', text: d.text })),
      client.on('tool.call', (d) => dispatch({ type: 'tool.call', name: d.name, args: d.args })),
      client.on('tool.result', (d) => dispatch({ type: 'tool.result', name: d.name, ok: d.ok, content: d.content })),
      client.on('step.done', (d) => dispatch({
        type: 'step.done',
        step: d.step,
        seconds: d.seconds,
        ...(d.tokensPerSecond !== undefined ? { tokensPerSecond: d.tokensPerSecond } : {}),
      })),
      client.on('turn.done', (d) => dispatch({ type: 'turn.done', stoppedBecause: d.stoppedBecause })),
      client.on('approval.request', (d) => dispatch({
        type: 'approval.request', requestId: d.requestId, tool: d.tool, summary: d.summary,
        detail: d.detail, suggestedRules: d.suggestedRules,
      })),
      client.on('question.request', (d) => dispatch({
        type: 'question.request', requestId: d.requestId, question: d.question, options: d.options,
      })),
      client.on('todos', (d) => dispatch({ type: 'todos', items: d.items })),
    ]
    return () => { for (const u of unsubs) u() }
  }, [client])

  // Countdown ticker: only runs while a turn is actually in flight, so an idle panel does
  // not re-render on a timer for no reason.
  useEffect(() => {
    if (!state.turnRunning) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [state.turnRunning])

  // Esc-to-abort is deliberately a WINDOW-level listener, not the textarea's own
  // onKeyDown: the textarea is `disabled` for exactly the span of time a turn is
  // running (see the input row below), and a disabled form element cannot receive
  // focus, so a real user's Esc keypress would never reach a handler scoped to it at
  // the one moment abort matters. Caught the same way as the other two bugs in this
  // task's history: a synthetic `dispatchEvent` on the disabled textarea during
  // verification worked (dispatchEvent bypasses `disabled` for a JS-driven event), which
  // would have hidden this from a script-only check -- a real keyboard user cannot
  // reproduce that. `client.call('abort', ...)` is unconditional here rather than gated
  // on `state.turnRunning`: `SessionHost.abort()` is documented idempotent (a harmless
  // no-op with nothing running and nothing pending), so there is no stale-closure risk
  // from this effect's `[client]`-only dependency array.
  useEffect(() => {
    function onWindowKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        client.call('abort', {}).catch(() => { /* best-effort; turn.done (or its absence) is the real signal */ })
      }
    }
    window.addEventListener('keydown', onWindowKeyDown)
    return () => window.removeEventListener('keydown', onWindowKeyDown)
  }, [client])

  function send(): void {
    const text = input.trim()
    if (text === '' || state.turnRunning) return
    setInput('')
    dispatch({ type: 'user-message', text })
    dispatch({ type: 'turn-started' })
    client.call('send', { text }).catch((e: unknown) => {
      dispatch({ type: 'send-failed', message: e instanceof Error ? e.message : String(e) })
    })
  }

  function abort(): void {
    if (!state.turnRunning) return
    client.call('abort', {}).catch(() => { /* best-effort; turn.done (or its absence) is the real signal */ })
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function requestModeChange(next: AgentMode): void {
    if (next === 'autopilot') {
      setPendingAutopilot(true)
      return
    }
    setPendingAutopilot(false)
    applyMode(next)
  }

  function confirmAutopilot(): void {
    setPendingAutopilot(false)
    applyMode('autopilot')
  }

  function applyMode(next: AgentMode): void {
    setMode(next)
    client.call('setMode', { mode: next }).catch((e: unknown) => {
      dispatch({ type: 'send-failed', message: e instanceof Error ? e.message : String(e) })
    })
  }

  const remainingMs = state.currentStep
    ? Math.max(0, state.currentStep.timeoutMs - (now - state.currentStep.startedAtMs))
    : null

  return (
    <div class="chat-panel">
      <div class="chat-toolbar">
        <select
          class="mode-select"
          value={mode}
          onChange={(e) => requestModeChange(e.currentTarget.value as AgentMode)}
        >
          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {pendingAutopilot && (
          <button class="autopilot-confirm" onClick={confirmAutopilot}>
            Confirm autopilot (unattended edits)
          </button>
        )}
      </div>

      <TodosWidget todos={state.todos} />

      <div class="chat-transcript">
        {state.items.map((item) => <ChatItemRow key={item.id} item={item} />)}
      </div>

      <div class="chat-turn-status">
        {state.currentStep && remainingMs !== null && (
          <span>step {state.currentStep.step} — {Math.ceil(remainingMs / 1000)}s left</span>
        )}
        {!state.turnRunning && state.lastStepDone && (
          <span>
            step {state.lastStepDone.step} done in {state.lastStepDone.seconds.toFixed(1)}s
            {state.lastStepDone.tokensPerSecond !== undefined
              ? `, ${state.lastStepDone.tokensPerSecond.toFixed(1)} tok/s` : ''}
          </span>
        )}
      </div>

      {state.pendingApproval && (
        <ApprovalCard
          client={client}
          approval={state.pendingApproval}
          onAnswered={(decision) => dispatch({ type: 'approval.answered', decision })}
        />
      )}
      {state.pendingQuestion && (
        <QuestionCard
          client={client}
          question={state.pendingQuestion}
          onAnswered={(answer) => dispatch({ type: 'question.answered', answer })}
        />
      )}

      <div class="chat-input-row">
        <textarea
          class="chat-input"
          value={input}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          disabled={state.turnRunning}
          placeholder="Message the model. Enter to send, Shift+Enter for a newline, Esc to abort."
        />
        <div class="chat-input-buttons">
          <button onClick={send} disabled={state.turnRunning || input.trim() === ''}>Send</button>
          <button class="stop-button" onClick={abort} disabled={!state.turnRunning}>Stop</button>
        </div>
      </div>
    </div>
  )
}

function ChatItemRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div class="chat-row chat-user">
          <div class="chat-row-label">you</div>
          <pre class="chat-text">{item.text}</pre>
        </div>
      )
    case 'assistant':
      // Global Constraint 6: the model's output renders as PLAIN TEXT here, never through
      // innerHTML or a markdown renderer -- `{item.text}` is a plain JSX text child (Preact
      // escapes it like any other text node), and `.chat-text` is `white-space: pre-wrap`
      // rather than HTML-interpreted. Markdown rendering is deliberately deferred; this
      // WebView also holds Tauri IPC power, so treating model text as markup is exactly the
      // injection seam the plan's security review is watching for.
      return (
        <div class="chat-row chat-assistant">
          <div class="chat-row-label">assistant</div>
          <pre class="chat-text">
            {item.text}
            {item.interrupted ? <span class="interrupted-marker"> [interrupted]</span> : null}
          </pre>
        </div>
      )
    case 'thinking':
      return (
        <div class="chat-row chat-thinking">
          [thinking… ~{Math.ceil(item.chars / 4)} tok]
        </div>
      )
    case 'tool': {
      const status = item.result === undefined ? 'pending' : item.result.ok ? 'ok' : 'fail'
      const icon = status === 'pending' ? '→' : status === 'ok' ? '✓' : '✗'
      const detail = item.result ? item.result.preview : item.args.slice(0, 160)
      return (
        <div class={`chat-row chat-tool tool-${status}`}>
          <span class="tool-icon">{icon}</span>
          <b class="tool-name">{item.name}</b>
          <span class="tool-detail">{detail}</span>
        </div>
      )
    }
    case 'error':
      return <div class="chat-row chat-error">⚠ {item.message}</div>
    case 'approval-record': {
      const verdict = item.decision.verdict
      const comment = verdict === 'deny' ? item.decision.comment : undefined
      const remember = verdict === 'allow' ? item.decision.remember : undefined
      return (
        <div class={`chat-row chat-approval-record approval-${verdict}`}>
          {verdict === 'allow' ? '✓' : '✗'} <b>{item.tool}</b>: {item.summary} — {verdict}
          {remember ? ` (always: ${remember.rule} @ ${remember.layer})` : ''}
          {comment ? ` — "${comment}"` : ''}
        </div>
      )
    }
    case 'question-record':
      return (
        <div class="chat-row chat-question-record">
          ? {item.question} → <b>{item.answer}</b>
        </div>
      )
  }
}
