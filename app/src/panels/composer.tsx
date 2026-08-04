import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { AgentMode } from '@core/permissions/engine'
import type { ProtocolClient } from '../lib/client'
import type { ChatAction, ChatState } from '../lib/state'
import { formatDuration } from '../lib/format'
import { applyMention, mentionAtCaret, type Mention } from '../lib/mentions'
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
  { value: 'normal', label: 'Normal', hint: 'Asks before editing files or running commands.' },
  { value: 'plan', label: 'Plan', hint: 'Read-only. Investigates and proposes, changes nothing.' },
  { value: 'auto-edit', label: 'Auto-edit', hint: 'Edits freely. Still asks before running commands.' },
  { value: 'autopilot', label: 'Autopilot', hint: 'Acts unattended. Built-in protections still apply.' },
]

/** Well under `protocol.ts`'s 1 MB line cap: one oversized request line makes the sidecar
 * treat the stream as compromised and exit, and the shell has no respawn path. Refusing
 * here, visibly, is the cheap honest guard. */
const MAX_SEND_CHARS = 500_000

export function Composer({
  client, state, dispatch, modalOpen, onAdoptViewed,
}: {
  client: ProtocolClient
  state: ChatState
  dispatch: (action: ChatAction) => void
  /** A dialog is on screen and owns Escape. See the keydown effect below. */
  modalOpen: boolean
  /** Become the session currently being read. Called by `send()` and nowhere else: the
   * message is what commits to the switch. */
  onAdoptViewed: () => Promise<void>
}): VNode {
  const [input, setInput] = useState('')
  /**
   * Text typed while a turn was running, held until it ends.
   *
   * The placeholder promised this ("Queue your next message") and `send()` simply returned
   * early when `turnRunning`, so pressing Enter mid-turn did nothing at all — silently.
   * Typing a follow-up while the agent works is the normal thing to do on a long run, so
   * the promise is the part worth keeping.
   */
  const [queued, setQueued] = useState<{ text: string; attach: string[] } | null>(null)
  const [pendingAutopilot, setPendingAutopilot] = useState(false)
  /**
   * Files picked with `@`, and the open picker's state.
   *
   * `attached` is what the PICKER added, never a re-parse of the text: `@Component`,
   * `@media` and an email address are all `@something`, and silently attaching a file
   * because a decorator happened to name one would be the worst kind of surprise. What
   * actually gets sent is `attached` filtered by what is still written in the box, so
   * deleting the mention un-attaches the file, which is the obvious way to undo it.
   */
  const [attached, setAttached] = useState<string[]>([])
  const [mention, setMention] = useState<Mention | null>(null)
  const [mentionHits, setMentionHits] = useState<string[]>([])
  const [mentionPick, setMentionPick] = useState(0)
  /** The user's own slash commands. Re-fetched whenever the box starts with `/`, because
   * these are files edited by hand while the app is open. */
  const [commands, setCommands] = useState<{ name: string; description: string }[]>([])
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
  // `modalOpen` is not optional politeness: the settings dialog has its own Escape
  // handler, and both listeners are on `window`, so one press closed the dialog AND killed
  // the running turn -- dismissing a dialog is not a request to stop the agent.
  const modalOpenRef = useRef(modalOpen)
  modalOpenRef.current = modalOpen
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape' || modalOpenRef.current) return
      client.call('abort', {}).catch(() => { /* turn.done, or its absence, is the real signal */ })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [client])

  // A command is expanded host-side in `send`, so this list is purely discovery: without
  // it a feature the user configured in a directory is invisible in the window.
  const slashPrefix = /^\/[a-z0-9-]*$/i.test(input.trim()) ? input.trim().slice(1).toLowerCase() : null
  useEffect(() => {
    if (slashPrefix === null) return
    let cancelled = false
    client.call('commands.list', {})
      .then((r) => { if (!cancelled) setCommands(r.commands) })
      .catch(() => { /* a workspace with no commands directory is the normal case */ })
    return () => { cancelled = true }
  }, [client, slashPrefix === null])

  const matching = slashPrefix === null
    ? []
    : commands.filter((c) => c.name.startsWith(slashPrefix)).slice(0, 8)

  useEffect(() => {
    if (mention === null) { setMentionHits([]); return }
    let cancelled = false
    client.call('fs.find', { query: mention.query, limit: 8 })
      .then((r) => { if (!cancelled) { setMentionHits(r.paths); setMentionPick(0) } })
      .catch(() => { if (!cancelled) setMentionHits([]) })
    return () => { cancelled = true }
  }, [client, mention?.query])

  /** Replaces the `@…` being typed with the chosen path, and remembers the attachment. */
  function choose(path: string): void {
    const el = textareaRef.current
    if (!el || mention === null) return
    const next = applyMention(input, mention, el.selectionStart ?? input.length, path)
    setInput(next.text)
    setAttached((a) => (a.includes(path) ? a : [...a, path]))
    setMention(null)
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(next.caret, next.caret) })
  }

  /** What will actually be sent: a picked file counts only while its mention is still
   * written in the box. */
  const liveAttachments = attached.filter((p) => input.includes(`@${p}`))

  /**
   * Reading an earlier session WHILE the live one is mid-turn.
   *
   * Sending here would tear the running session down — the exact thing the rail no longer
   * does behind a click, so it must not happen behind a keystroke either. The wait is short
   * and it is visible; the alternative is losing a turn you are in the middle of.
   */
  const blockedByRun = state.viewing !== null && state.turnRunning

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

  // The queue drains on ANY turn ending, including one you stopped yourself: pressing Stop
  // ends the agent's work, not your message, and the queued text is usually the new
  // direction. It is visible and cancellable the whole time it waits, so this is never a
  // surprise.
  useEffect(() => {
    if (state.turnRunning || queued === null) return
    setQueued(null)
    submit(queued.text, queued.attach)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submit is recreated per render
  }, [state.turnRunning, queued])

  // A queued message belongs to the conversation it was typed into. Switching sessions
  // must not deliver it to a different one.
  const sessionId = state.session?.sessionId
  useEffect(() => { setQueued(null) }, [sessionId])

  /**
   * Starts an unattended run with whatever is in the composer as the task.
   *
   * Taking the composer text rather than opening a dialog: the thing you would type into a
   * dialog is the thing you already typed, and an empty composer is a clear enough signal
   * to refuse.
   */
  function startRun(): void {
    const task = input.trim()
    if (task === '') {
      dispatch({
        type: 'send-failed',
        message: 'Type what you want done first — an unattended run needs a task to start from.',
      })
      return
    }
    setInput('')
    dispatch({ type: 'user-message', text: task })
    client.call('run.start', { task }).catch((e: Error) => {
      dispatch({ type: 'send-failed', message: e.message })
    })
  }

  function stopRun(): void {
    client.call('run.stop', {}).catch(() => { /* the run ends on its own signal */ })
  }

  function send(): void {
    const text = input.trim()
    if (text === '') return

    // Reading an earlier session, and about to write into it: SENDING is what commits to the
    // switch. Clicking a session in the rail only reads it, so the running one keeps going;
    // this is the moment you said you wanted it instead. Guarded above by the composer being
    // disabled while a turn is still running — becoming another session tears the live one
    // down, and doing that behind a keystroke is the bug this whole change removes.
    if (blockedByRun) return
    if (state.viewing !== null) {
      const pending = { text, attach: liveAttachments }
      setInput('')
      setAttached([])
      setMention(null)
      onAdoptViewed()
        .then(() => submit(pending.text, pending.attach))
        .catch((e: unknown) => {
          dispatch({ type: 'send-failed', message: e instanceof Error ? e.message : String(e) })
        })
      return
    }
    // A queued message carries its OWN attachments. Leaving them in the shared picker state
    // meant the files you picked for the NEXT message were cleared when the queued one
    // finally drained.
    const attach = liveAttachments
    if (state.turnRunning) {
      // Appended, not replaced: two thoughts typed during one long turn are both worth
      // keeping, and losing one silently is the bug this whole thing exists to fix.
      setQueued((q) => (q === null
        ? { text, attach }
        : { text: `${q.text}\n${text}`, attach: [...new Set([...q.attach, ...attach])] }))
      setInput('')
      setAttached([])
      setMention(null)
      return
    }
    submit(text, attach)
  }

  function submit(text: string, attach: string[] = []): void {
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
    setAttached([])
    setMention(null)
    dispatch({ type: 'user-message', text })
    dispatch({ type: 'turn-started' })
    client.call('send', { text, ...(attach.length > 0 ? { attach } : {}) }).catch((e: unknown) => {
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
  const waitingOnYou = state.pendingApproval !== null || state.pendingQuestion !== null
  const lastItem = state.items[state.items.length - 1]
  const runningTool = lastItem?.kind === 'tool' && lastItem.result === undefined ? lastItem.name : null

  /**
   * The one line of live state, shown INSIDE the control rather than on a strip above it.
   * `currentStep` is null for the whole stretch between a step's model call ending and the
   * next starting -- exactly when a tool is running or an approval is open -- so that case
   * gets its own wording instead of a blank.
   */
  function statusLine(): VNode | null {
    if (waitingOnYou) return <span class="status-live">waiting on you · nothing generating</span>
    // Why a run ENDED outranks how the last turn went: after an unattended run the first
    // question is always "why did it stop", and a tok/s figure answers a question nobody
    // asked. It stays until the next turn replaces it.
    if (!state.turnRunning && state.lastRun) {
      return (
        <span class="status-idle">
          run ended: {state.lastRun.stoppedBecause} after {state.lastRun.turns} turn
          {state.lastRun.turns === 1 ? '' : 's'} · <span class="run-detail">{state.lastRun.detail}</span>
        </span>
      )
    }
    if (state.turnRunning) {
      // A compaction over a full context is minutes of a single non-streaming request:
      // nothing streams, no step starts, and the only thing on screen was the word
      // "working". But it is only TRUE while no step is in flight — `lastCompaction` is the
      // last event seen, not a live flag, and a 'started' with no terminal event after it
      // (the sidecar was restarted mid-generation) left this line up forever, next to a
      // running step. Seen in a screenshot: "compacting…" beside step 2.
      if (!step && state.lastCompaction?.state === 'started') {
        return (
          <span class="status-live">
            compacting the conversation to fit the context window — this takes a few minutes
          </span>
        )
      }
      if (!step) return <span class="status-live">{runningTool ? `running ${runningTool}` : 'working'}</span>
      return (
        <span class="status-live">
          step {step.step} · {formatDuration(now - step.startedAtMs)}
          {remainingMs !== null && remainingMs < 20_000 && (
            <span class="warn"> · {Math.ceil(remainingMs / 1000)}s to timeout</span>
          )}
        </span>
      )
    }
    if (last) {
      return (
        <span class="status-idle">
          {last.seconds.toFixed(1)}s
          {last.tokensPerSecond !== undefined && ` · ${last.tokensPerSecond.toFixed(1)} tok/s`}
        </span>
      )
    }
    return <span class="status-idle"><kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline</span>
  }

  return (
    <div class="composer">
      {pendingAutopilot && (
        <div class="autopilot-confirm">
          <span>Autopilot edits files and runs commands with no further prompts.</span>
          <button class="btn btn-danger" onClick={() => { setPendingAutopilot(false); applyMode('autopilot') }}>
            Turn it on
          </button>
          <button class="btn" onClick={() => setPendingAutopilot(false)}>Cancel</button>
        </div>
      )}

      {matching.length > 0 && (
        <div class="command-picker">
          {matching.map((c) => (
            <button
              key={c.name}
              class="command-item"
              onClick={() => { setInput(`/${c.name} `); textareaRef.current?.focus() }}
            >
              <span class="command-name">/{c.name}</span>
              <span class="command-desc">{c.description}</span>
            </button>
          ))}
        </div>
      )}

      {mention !== null && mentionHits.length > 0 && (
        <div class="command-picker">
          {mentionHits.map((path, i) => (
            <button
              key={path}
              class={`command-item ${i === mentionPick ? 'command-item-on' : ''}`}
              onMouseEnter={() => setMentionPick(i)}
              onClick={() => choose(path)}
            >
              <span class="command-icon">{Icon.file()}</span>
              <span class="command-desc" title={path}>{path}</span>
            </button>
          ))}
          <div class="picker-hint">
            <kbd>↑↓</kbd> pick · <kbd>↵</kbd> attach · the file's contents go with your message
          </div>
        </div>
      )}

      {liveAttachments.length > 0 && (
        <div class="attach-row">
          {liveAttachments.map((path) => (
            <span key={path} class="attach-chip" title={`${path} is sent with this message`}>
              {Icon.file()}
              <span class="attach-name">{path}</span>
            </span>
          ))}
        </div>
      )}

      {queued !== null && (
        <div class="queued-note">
          <span class="queued-label">Queued</span>
          <span class="queued-text" title={queued.text}>{queued.text}</span>
          <button
            class="queued-edit"
            onClick={() => {
              setInput((i) => (i === '' ? queued.text : `${queued.text}\n${i}`))
              setAttached((a) => [...new Set([...a, ...queued.attach])])
              setQueued(null)
            }}
            title="Put it back in the box"
          >
            edit
          </button>
          <button class="icon-button" onClick={() => setQueued(null)} title="Discard it">
            {Icon.x()}
          </button>
        </div>
      )}

      {/* One bordered surface holding the input and everything that acts on it. The three
          separate strips this replaced -- a status line above, the box, a row of pills
          below -- read as three unrelated widgets stacked around a text field. */}
      <div class={`composer-shell ${state.turnRunning ? 'composer-shell-live' : ''}`}>
        <div class="composer-activity" aria-hidden="true" />

        <textarea
          ref={textareaRef}
          class="composer-input"
          value={input}
          rows={1}
          onInput={(e) => {
            const el = e.currentTarget
            setInput(el.value)
            setMention(mentionAtCaret(el.value, el.selectionStart ?? el.value.length))
          }}
          // The caret can move without the text changing, and an `@` two words back is no
          // longer the one you are typing.
          onKeyUp={(e) => {
            const el = e.currentTarget
            if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
              setMention(mentionAtCaret(el.value, el.selectionStart ?? el.value.length))
            }
          }}
          onClick={(e) => {
            const el = e.currentTarget
            setMention(mentionAtCaret(el.value, el.selectionStart ?? el.value.length))
          }}
          onKeyDown={(e) => {
            const picking = mention !== null && mentionHits.length > 0
            if (picking) {
              // Escape closes the picker and STOPS THERE: the window's Escape listener
              // aborts the running turn, and dismissing a dropdown is not a request to
              // stop the agent.
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMention(null); return }
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setMentionPick((i) => (i + 1) % mentionHits.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setMentionPick((i) => (i - 1 + mentionHits.length) % mentionHits.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                const path = mentionHits[mentionPick]
                if (path !== undefined) choose(path)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={blockedByRun
            ? 'Reading an earlier session. Wait for the running turn, or go back to it, then write here to continue this one.'
            : state.viewing !== null
              ? 'Write here to continue this session from now on — the current one stops being the active one'
              : state.turnRunning
                ? 'Type your next message — it is sent when this turn ends. Esc stops.'
                : 'Ask for a change, a review, or an explanation'}
        />

        <div class="composer-bar">
          <div class="mode-group" role="group" aria-label="How much the agent may do without asking">
            {MODES.map((m) => (
              <button
                key={m.value}
                class={`mode-chip ${mode === m.value ? 'mode-chip-active' : ''} mode-${m.value}`}
                title={m.hint}
                disabled={!state.session}
                onClick={() => requestMode(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* A mode in every sense that matters, so it sits with the modes. Disabled while
              anything is running: an unattended run and a manual turn are the same single
              slot, and offering a button that would be refused is worse than not offering
              it. */}
          <button
            class={`mode-chip run-chip ${state.run ? 'run-chip-active' : ''}`}
            title={state.run
              ? 'Stop after the current turn'
              : 'Keep taking turns until the work is done or a budget stops it. ' +
                'Questions are queued instead of blocking.'}
            disabled={!state.session || (state.turnRunning && state.run === null)}
            onClick={state.run ? stopRun : startRun}
          >
            {state.run ? `Stop · turn ${state.run.turn}` : 'Run unattended'}
          </button>

          <div class="composer-meta">{statusLine()}</div>

          {/* While a turn runs the button is Stop -- but typed text still has somewhere to
              go, so it queues rather than being swallowed. Enter does the same. */}
          {state.turnRunning && input.trim() !== '' && (
            <button class="composer-queue" onClick={send} title="Queue this for when the turn ends">
              {Icon.plus()}
            </button>
          )}
          <button
            class={`composer-send ${state.turnRunning ? 'composer-send-stop' : ''}`}
            onClick={state.turnRunning ? abort : send}
            disabled={(!state.turnRunning && input.trim() === '') || blockedByRun}
            title={state.turnRunning
              ? 'Stop this turn (Esc)'
              : state.viewing !== null
                ? `Send here and continue "${state.viewing.title || 'this session'}" from now on`
                : 'Send (Enter)'}
          >
            {state.turnRunning ? Icon.stop() : Icon.send()}
          </button>
        </div>
      </div>
    </div>
  )
}
