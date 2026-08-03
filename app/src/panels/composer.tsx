import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { AgentMode } from '@core/permissions/engine'
import type { ProtocolClient } from '../lib/client'
import type { ChatAction, ChatState } from '../lib/state'
import { formatDuration } from '../lib/format'
import { Icon } from '../components/icons'

/**
 * The input area: what you type, how much freedom the agent has while it runs, and the one
 * button that both sends and stops.
 *
 * Send and Stop are the SAME control, not two buttons one of which is always dead. While a
 * turn runs there is exactly one useful action and it is Stop; while it does not, there is
 * exactly one and it is Send.
 */

const MODES: readonly { value: AgentMode; label: string; hint: string }[] = [
  { value: 'normal', label: 'Normal', hint: 'asks before editing files or running commands' },
  { value: 'plan', label: 'Plan', hint: 'read-only: investigates and proposes, changes nothing' },
  { value: 'auto-edit', label: 'Auto-edit', hint: 'edits freely, still asks before commands' },
  { value: 'autopilot', label: 'Autopilot', hint: 'acts unattended; built-in protections still apply' },
]

/** Well under `protocol.ts`'s 1 MB line cap: one oversized request line makes the sidecar
 * treat the stream as compromised and exit, and the shell has no respawn path. Refusing
 * here, visibly, is the cheap honest guard. */
const MAX_SEND_CHARS = 500_000

export function Composer({
  client, state, dispatch,
}: {
  client: ProtocolClient
  state: ChatState
  dispatch: (action: ChatAction) => void
}): VNode {
  const [input, setInput] = useState('')
  const [pendingAutopilot, setPendingAutopilot] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mode: AgentMode = state.session?.mode ?? 'normal'

  useEffect(() => {
    if (!state.turnRunning) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [state.turnRunning])

  // Esc-to-abort is a WINDOW listener, not the textarea's own onKeyDown: the textarea is
  // enabled during a turn now, but focus may legitimately be anywhere (a diff, the tree),
  // and abort is the one thing that must work from everywhere. `abort` is documented
  // idempotent host-side, so firing it with nothing running is a harmless no-op.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        client.call('abort', {}).catch(() => { /* turn.done, or its absence, is the real signal */ })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [client])

  // Grow with the content up to a cap, then scroll -- a fixed two-line box makes writing a
  // real instruction (which is most of them) an exercise in scrolling blind.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [input])

  // Re-focus the moment a turn ends: the next thing anyone does is type again.
  useEffect(() => {
    if (!state.turnRunning) textareaRef.current?.focus()
  }, [state.turnRunning])

  function send(): void {
    const text = input.trim()
    if (text === '' || state.turnRunning) return
    if (text.length > MAX_SEND_CHARS) {
      dispatch({
        type: 'send-failed',
        message: `That message is ${text.length.toLocaleString()} characters; the limit is ` +
          `${MAX_SEND_CHARS.toLocaleString()}. Save the content to a file in the workspace ` +
          'and ask the agent to read it instead.',
      })
      return
    }
    setInput('')
    dispatch({ type: 'user-message', text })
    dispatch({ type: 'turn-started' })
    client.call('send', { text }).catch((e: unknown) => {
      dispatch({ type: 'send-failed', message: e instanceof Error ? e.message : String(e) })
    })
  }

  function abort(): void {
    client.call('abort', {}).catch(() => { /* see the Esc handler */ })
  }

  function applyMode(next: AgentMode): void {
    dispatch({ type: 'mode-changed', mode: next })
    client.call('setMode', { mode: next }).catch((e: unknown) => {
      dispatch({ type: 'send-failed', message: e instanceof Error ? e.message : String(e) })
    })
  }

  function requestMode(next: AgentMode): void {
    // Autopilot is the one mode that can change the workspace with nobody watching, so it
    // takes a second, deliberate click rather than a stray one on a segmented control.
    if (next === 'autopilot' && mode !== 'autopilot') {
      setPendingAutopilot(true)
      return
    }
    setPendingAutopilot(false)
    applyMode(next)
  }

  const step = state.currentStep
  const remainingMs = step ? Math.max(0, step.timeoutMs - (now - step.startedAtMs)) : null
  const last = state.lastStepDone

  return (
    <div class="composer">
      <div class="composer-status">
        {state.turnRunning && step && (
          <>
            <span class="pulse-dot" aria-hidden="true" />
            <span>step {step.step}</span>
            <span class="dim">· {formatDuration(now - step.startedAtMs)} elapsed</span>
            {remainingMs !== null && remainingMs < 20_000 && (
              <span class="warn">· {Math.ceil(remainingMs / 1000)}s until this step times out</span>
            )}
          </>
        )}
        {!state.turnRunning && last && (
          <span class="dim">
            step {last.step} finished in {last.seconds.toFixed(1)}s
            {last.tokensPerSecond !== undefined && ` · ${last.tokensPerSecond.toFixed(1)} tok/s`}
          </span>
        )}
      </div>

      {pendingAutopilot && (
        <div class="autopilot-confirm">
          <span>Autopilot lets it edit files and run commands with no further prompts.</span>
          <button class="btn btn-danger" onClick={() => { setPendingAutopilot(false); applyMode('autopilot') }}>
            Turn it on
          </button>
          <button class="btn" onClick={() => setPendingAutopilot(false)}>Cancel</button>
        </div>
      )}

      <div class="composer-box">
        <textarea
          ref={textareaRef}
          class="composer-input"
          value={input}
          rows={1}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={state.turnRunning
            ? 'Working… type your next message, or press Esc to stop'
            : 'Ask for a change, a review, or an explanation'}
        />
        <button
          class={`composer-send ${state.turnRunning ? 'composer-send-stop' : ''}`}
          onClick={state.turnRunning ? abort : send}
          disabled={!state.turnRunning && input.trim() === ''}
          title={state.turnRunning ? 'Stop this turn (Esc)' : 'Send (Enter)'}
        >
          {state.turnRunning ? Icon.stop() : Icon.send()}
        </button>
      </div>

      <div class="composer-modes">
        {MODES.map((m) => (
          <button
            key={m.value}
            class={`mode-pill ${mode === m.value ? 'mode-pill-active' : ''} mode-${m.value}`}
            title={m.hint}
            disabled={!state.session}
            onClick={() => requestMode(m.value)}
          >
            {m.label}
          </button>
        ))}
        <span class="composer-hint">{MODES.find((m) => m.value === mode)?.hint}</span>
      </div>
    </div>
  )
}
