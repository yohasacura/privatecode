import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { AgentMode } from '@core/permissions/engine'
import type { ProtocolClient } from '../lib/client'
import { pendingTool, type ChatAction, type ChatState } from '../lib/state'
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

/** The one window-owned slash command; see `send()`. */
const COMPACT_COMMAND = '/compact'

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

  const BUILT_IN = [{
    name: 'compact',
    description: 'Summarise the conversation now and free the context it occupies',
  }]
  const matching = slashPrefix === null
    ? []
    : [...BUILT_IN, ...commands].filter((c) => c.name.startsWith(slashPrefix)).slice(0, 8)

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
  // A manual turn and an unattended run hold the same single slot host-side, and every
  // guard in this file has to treat them as one thing. They were treated as unrelated —
  // `turnRunning` is false during a run's turns, since runs emit `run.turn`, never
  // `turn.done` — and the audit confirmed four distinct failures through that gap, two of
  // them wedging the composer permanently and one aborting an hours-long run with a
  // single keystroke into a viewed session.
  const busy = state.turnRunning || state.run !== null
  const blockedByRun = state.viewing !== null && busy

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
    if (state.turnRunning || state.run !== null || queued === null) return
    setQueued(null)
    if (queued.text === COMPACT_COMMAND) runCompact()
    else submit(queued.text, queued.attach)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submit is recreated per render
  }, [state.turnRunning, queued])

  // A queued message belongs to the conversation it was typed into. Switching sessions
  // must not deliver it to a different one.
  const sessionId = state.session?.sessionId
  useEffect(() => { setQueued(null) }, [sessionId])

  /**
   * The run-start card: the task comes from the composer (the thing you would type into a
   * dialog is the thing you already typed), the budgets come from here.
   *
   * The budgets existed in the protocol from the day runs did — `run.start` takes `maxTurns`
   * and `maxHours`, the runner honours them, and cutting a running turn at the hour budget
   * was measured and fixed — and the window never offered either. So the only way to bound
   * a run from the app was to watch it, which is the one thing an unattended run exists to
   * not need.
   *
   * Both empty by default, meaning unbounded, because that is what the button has always
   * meant and a default that silently stops the night's work at some number I invented
   * would be the worse surprise.
   */
  const [runConfigOpen, setRunConfigOpen] = useState(false)
  /** The task as it stood when the popover opened. `startRun` used to re-read the live
   * composer text at click time, so anything that happened in between — the textarea is
   * never disabled — changed or emptied the task under the open card. */
  const [runTask, setRunTask] = useState('')
  const [maxTurnsText, setMaxTurnsText] = useState('')
  const [maxHoursText, setMaxHoursText] = useState('')

  function requestRun(): void {
    const task = input.trim()
    if (task === '') {
      dispatch({
        type: 'send-failed',
        message: 'Type what you want done first — an unattended run needs a task to start from.',
      })
      return
    }
    setRunTask(task)
    setRunConfigOpen(true)
  }

  /** A budget field is either empty (no budget) or a positive number; anything else keeps
   * the card open rather than starting a run with a silently-dropped bound. */
  function parseBudget(text: string): number | undefined | null {
    const trimmed = text.trim()
    if (trimmed === '') return undefined
    const n = Number(trimmed)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  function startRun(): void {
    // The CAPTURED task, and the world re-checked at click time. The popover has no focus
    // trap and the textarea under it stays live, so anything can have happened since it
    // opened — the audited case: press Enter in the textarea (the task goes out as a manual
    // turn, the input empties), then click Start run. The old code read the now-empty input,
    // started a phantom run, and its failure handler reset `turnRunning` for the REAL turn
    // still streaming — after which its `turn.done` was dropped and every writing card
    // leaked to the next same-name call.
    const task = runTask
    if (busy) {
      setRunConfigOpen(false)
      dispatch({
        type: 'send-failed',
        message: 'A turn started while the run card was open — let it finish (or stop it), then start the run.',
      })
      return
    }
    const maxTurns = parseBudget(maxTurnsText)
    const maxHours = parseBudget(maxHoursText)
    if (maxTurns === null || maxHours === null) {
      dispatch({ type: 'send-failed', message: 'A budget is a positive number, or empty for none.' })
      return
    }
    setRunConfigOpen(false)
    setInput('')
    dispatch({ type: 'user-message', text: task })
    dispatch({
      type: 'run-started', task, atMs: Date.now(),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(maxHours !== undefined ? { maxHours } : {}),
    })
    client.call('run.start', {
      task,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(maxHours !== undefined ? { maxHours } : {}),
    }).catch((e: Error) => {
      // ONLY the run's own bookkeeping. This used to also dispatch `send-failed`, whose
      // reducer resets `turnRunning` — poisoning a real manual turn when the failure was
      // "a turn is already running". The ended banner carries the reason; nothing else
      // needs to change state that does not belong to the run.
      dispatch({ type: 'run.ended', turns: 0, stoppedBecause: 'error', detail: e.message })
    })
  }

  function stopRun(): void {
    client.call('run.stop', {}).catch(() => { /* the run ends on its own signal */ })
  }

  function send(): void {
    const text = input.trim()
    if (text === '') return
    // A manual send makes the open run card stale — its captured task may be the very text
    // being sent right now — so the card closes rather than offering to start a run whose
    // description no longer matches anything.
    setRunConfigOpen(false)

    // `/compact` is the window's own command, not the model's and not the user's: the
    // context-overflow message has advised "compact it" since Plan 2 while the window had no
    // way to do it, and waiting for the automatic trigger means waiting for a long turn to
    // end first. Handled here rather than sent, because it is not a message to anyone.
    //
    // While a turn runs it QUEUES, exactly as typed text does. The server has one slot, so
    // compacting now is not something the session can honour — and the first version simply
    // called it anyway and put "a turn is already running in this session" in the transcript,
    // which is a refusal dressed up as an error.
    if (text === COMPACT_COMMAND) {
      setInput('')
      setMention(null)
      if (busy) {
        setQueued({ text: COMPACT_COMMAND, attach: [] })
        return
      }
      runCompact()
      return
    }

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
    if (busy) {
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

  function runCompact(): void {
    client.call('compact', {}).catch((e: unknown) => {
      dispatch({ type: 'send-failed', message: e instanceof Error ? e.message : String(e) })
    })
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
      const message = e instanceof Error ? e.message : String(e)
      // The host still had a turn running while this window believed it did not. Whatever
      // caused the disagreement, the one thing that must not happen is losing what someone
      // typed: seen in a screenshot as a red "a turn is already running in this session"
      // where a message used to be, with the box already emptied. Queued instead, which is
      // what the composer promises for anything typed mid-turn.
      if (message.includes('a turn is already running')) {
        setQueued((q) => (q === null
          ? { text, attach }
          : { text: `${q.text}\n${text}`, attach: [...new Set([...q.attach, ...attach])] }))
        return
      }
      dispatch({ type: 'send-failed', message })
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
  // The countdown counts SILENCE, so it counts from the last thing that streamed. The
  // elapsed readout below counts from the step's start. Two anchors, because they are two
  // questions — sharing one field made the elapsed readout show 0.0s for every streaming
  // step, which is the readout that exists to prove the app has not hung.
  const remainingMs = step ? Math.max(0, step.timeoutMs - (now - step.aliveAtMs)) : null
  const last = state.lastStepDone
  const waitingOnYou = state.pendingApproval !== null || state.pendingQuestion !== null
  // The call actually EXECUTING, which is the oldest one still unanswered — not the last
  // item. A step runs its calls in order, so while call 1 runs, calls 2 and 3 already have
  // cards; the last of them is the one the model wrote most recently, not the one running.
  // `npm test` executing for three minutes under the label `running write_file` is the
  // shape of it. `pendingTool` is the same rule the reducer uses to route a result.
  const runningTool = pendingTool(state.items)?.name ?? null

  /**
   * The one line of live state, shown INSIDE the control rather than on a strip above it.
   * `currentStep` is null for the whole stretch between a step's model call ending and the
   * next starting -- exactly when a tool is running or an approval is open -- so that case
   * gets its own wording instead of a blank.
   */
  /** Whether tokens are actually coming out right now, as opposed to the model still
   * reading. The last item being a live reasoning block WITH text is the only honest
   * evidence of that; a step having started is not. */
  const newestItem = state.items[state.items.length - 1]
  const streaming = newestItem !== undefined && newestItem.kind === 'thinking' &&
    !newestItem.done && newestItem.text.length > 0
  /**
   * The model is writing a TOOL CALL, and nothing shows it.
   *
   * The arguments of `edit_file` are generated exactly like reasoning is — token by token,
   * for as long as the change is big — but the window only learns of a call once it has
   * arrived whole. So the chat went silent for the entire time the edit was being composed,
   * which is the longest silence in a normal turn and the one that reads as a freeze.
   *
   * The state is recognisable without any new plumbing: a step is running, the reasoning
   * block for it has CLOSED (the model stopped thinking in prose), and no call has been
   * announced yet. There is only one thing that can be.
   */
  // Now read from the call itself rather than inferred from the shape of the transcript.
  // The inference above -- reasoning closed, turn running, no call yet -- was the best
  // available while a call only existed once it had arrived whole; it was right about WHAT
  // was happening and could say nothing about what was being written. The card in the
  // transcript now shows the tool and its target as they are generated, so this line only
  // has to name the state.
  const composingCall = newestItem !== undefined && newestItem.kind === 'tool' &&
    newestItem.writing === true

  function statusLine(): VNode | null {
    if (waitingOnYou) return <span class="status-live">waiting on you · nothing generating</span>
    // Why a run ENDED outranks how the last turn went: after an unattended run the first
    // question is always "why did it stop" — which is now the RunBanner card in the
    // transcript, where it can carry the full detail and be dismissed. Repeating it here
    // squeezed the same sentence into one status line and kept it there forever.
    if (state.turnRunning) {
      // Nothing about compaction here any more. It has its own live row in the transcript,
      // which starts when it starts and ends stating what it did — and a status line driven
      // by `lastCompaction` (the last EVENT seen, not a live flag) is what left "compacting…"
      // on screen next to a running step, and next to a queued message, with no way to tell
      // whether anything was happening at all.
      if (!step) return <span class="status-live">{runningTool ? `running ${runningTool}` : 'working'}</span>
      return (
        <span class="status-live">
          step {step.step} · {formatDuration(now - step.startedAtMs)}
          {/* The gap that reads as a freeze. llama.cpp matches its cache by longest common
              prefix, so the tokens a step APPENDS -- a file the last tool returned -- have to
              be processed before the first new one comes out. A `read_file` may return 60,000
              characters (~15k tokens), and at the ~393 tok/s measured on this machine that is
              close to forty seconds of silence, after which generation runs at its usual
              speed. Saying so turns "it hung" into "it is reading". */}
          {composingCall
            ? <span class="status-quiet"> · writing the change — the tool call is generated a token at a time, like the reasoning above it</span>
            : !streaming && <span class="status-quiet"> · reading what the last step returned</span>}
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
            onClick={state.run ? stopRun : requestRun}
          >
            {state.run ? `Stop · turn ${state.run.turn}` : 'Run unattended'}
          </button>

          {runConfigOpen && (
            <div class="run-config" role="dialog" aria-label="Start an unattended run">
              <div class="run-config-task" title={runTask}>{runTask}</div>
              <div class="run-config-fields">
                <label class="run-config-field">
                  <span>Turn budget</span>
                  <input
                    class="input input-small"
                    inputMode="numeric"
                    placeholder="none"
                    value={maxTurnsText}
                    onInput={(e) => setMaxTurnsText(e.currentTarget.value)}
                  />
                </label>
                <label class="run-config-field">
                  <span>Hour budget</span>
                  <input
                    class="input input-small"
                    inputMode="numeric"
                    placeholder="none"
                    value={maxHoursText}
                    onInput={(e) => setMaxHoursText(e.currentTarget.value)}
                  />
                </label>
              </div>
              <div class="run-config-hint">
                Empty means no limit. The hour budget cuts a running turn; questions park in
                the decision queue instead of blocking.
              </div>
              <div class="run-config-actions">
                <button class="btn" onClick={() => setRunConfigOpen(false)}>Cancel</button>
                <button class="btn btn-primary" onClick={startRun}>Start run</button>
              </div>
            </div>
          )}

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
