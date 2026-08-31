import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { AgentMode } from '@core/permissions/engine'
import type { ProtocolClient } from '../lib/client'
import { pendingTool, type ChatAction, type ChatItem, type ChatState, type StageName } from '../lib/state'
import { formatDuration, formatProgress } from '../lib/format'
import { applyMention, mentionAtCaret, type Mention } from '../lib/mentions'
import { pathDrag, subscribePathDrag, within, type PathDrag } from '../lib/drag'
import { Icon } from '../components/icons'
import { carryAcceptance, commandShaped, glueSuggestions, lintPrompt, lintShaped, taskShaped, type DraftSuggestions } from '../lib/prompt-lint'

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

/**
 * What each gate is called on screen.
 *
 * Written as what it is DOING rather than what it is NAMED. "acceptance gate" is the name
 * in the code and means nothing to somebody watching a progress line; "checking the work
 * against what you asked for" is the same fact in the words the person would use, and the
 * words are what makes the wait tolerable.
 */
const STAGE_LABEL: Record<StageName, string> = {
  contract: 'reading your request',
  premises: 'checking what the plan assumes',
  understanding: 'making sure it understood you',
  build: 'building and testing',
  acceptance: 'checking the work against what you asked for',
  review: 'a second reader is going over the change',
}

/** The one window-owned slash command; see `send()`. */
const COMPACT_COMMAND = '/compact'

/**
 * The gate commands, and why they are window-owned like `/compact` rather than model-facing.
 *
 * None of them is a message to anybody. The model has no tool that runs a build or starts a
 * reviewer, so a `/review` that reached it as chat would be answered with a confident
 * account of a review that never happened — the same failure `/compact` produced when it
 * was typed twice.
 */
const GATE_COMMANDS: Record<string, 'build' | 'review'> = {
  '/check': 'build',
  '/review': 'review',
}
/**
 * The doctor, which is a command and no longer a tool.
 *
 * The model kept reaching for it and there is nothing it can do with the answer: the report
 * describes the agent's own behaviour and is addressed to whoever maintains the agent, so a
 * model that reads it mid-task can only act on it — a self-modification nobody asked for —
 * or narrate it, spending a turn saying what the file already says. Taking it out of the
 * tool array is what makes that true rather than merely asked for.
 *
 * Both spellings, because the owner asked for it by the Russian one and a command that is
 * not recognised is indistinguishable from a command that did nothing.
 */
const DOCTOR_COMMANDS: readonly string[] = ['/doctor', '/доктор']

const GATES_OFF = '/gates off'
const GATES_ON = '/gates on'

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
   * The improver's suggestion chips: what the model proposes ADDING to the draft — the
   * draft itself is never rewritten. Criteria and constraints arrive accepted (uncheck to
   * drop); questions travel only once answered. `improvedFor` is the draft the suggestions
   * belong to — editing the draft keeps the chips (the user judges relevance) but a pause
   * re-improves the NEW text and replaces them; a result for a stale draft is discarded.
   */
  const [suggested, setSuggested] = useState<DraftSuggestions | null>(null)
  /** The EXPANDER's result: the rough command rewritten as a detailed, project-grounded
   * brief, shown as a preview card. Nothing enters the box without an explicit click. */
  const [expandPreview, setExpandPreview] = useState<string | null>(null)
  /** The draft the preview describes. Unlike the chips — additive, safe to keep across
   * edits — accepting a preview REPLACES the box, so the card must die the moment the
   * draft diverges from what it was generated for. */
  const expandFor = useRef<string>('')
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set())
  const [answers, setAnswers] = useState<ReadonlyMap<string, string>>(new Map())
  const [openQuestion, setOpenQuestion] = useState<string | null>(null)
  const [improving, setImproving] = useState(false)
  const [improveNote, setImproveNote] = useState<string | null>(null)
  const improvedFor = useRef<string>('')
  // A message the host reported as never delivered (Esc during contract distillation)
  // comes back to the box it was typed in, in front of whatever was typed since — losing
  // someone's paragraph to an abort is the one outcome this path exists to prevent.
  useEffect(() => {
    if (state.restoreDraft === null) return
    const draft = state.restoreDraft
    setInput((current) => current === '' ? draft : `${draft}\n${current}`)
    dispatch({ type: 'draft-restored' })
  }, [state.restoreDraft, dispatch])
  /**
   * Text typed while a turn was running, held until it ends.
   *
   * The placeholder promised this ("Queue your next message") and `send()` simply returned
   * early when `turnRunning`, so pressing Enter mid-turn did nothing at all — silently.
   * Typing a follow-up while the agent works is the normal thing to do on a long run, so
   * the promise is the part worth keeping.
   */
  //
  // A LIST, drained one entry per turn end — never merged into one blob. Merging looked
  // harmless ("two thoughts are both worth keeping") until the entries stopped being plain
  // prose: "/compact" glued to a follow-up drained as the chat message "/compact\nhello",
  // which the model — having no compaction tool — answered by announcing it had compacted.
  // Separate entries keep a command a command and a message a message.
  const [queued, setQueued] = useState<{ text: string; attach: string[] }[]>([])
  /** A manual compaction in flight. It holds the host's single slot exactly like a turn,
   * so the drain below must wait for it — draining into it just bounced off the host's
   * refusal once per round trip for the whole compaction. */
  const [compacting, setCompacting] = useState(false)
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
  /** What `@` offers: files AND folders. `dir` drives the icon and the hint — attaching a
   * folder sends a LISTING of what is in it, not every file's contents, and a picker that
   * looked identical for the two would be promising the wrong thing. */
  const [mentionHits, setMentionHits] = useState<{ path: string; dir: boolean }[]>([])
  const [mentionPick, setMentionPick] = useState(0)
  /** The user's own slash commands. Re-fetched whenever the box starts with `/`, because
   * these are files edited by hand while the app is open. */
  const [commands, setCommands] = useState<{ name: string; description: string }[]>([])
  /** Keyboard selection in the command picker — the mention picker's pattern, which this
   * picker lacked: arrows moved the caret, Enter submitted the half-typed prefix into the
   * slash guard's refusal, and Escape fell through to the window abort listener. */
  const [commandPick, setCommandPick] = useState(0)
  /** Escape dismisses the picker without sending anything anywhere; typing re-opens it. */
  const [commandsDismissed, setCommandsDismissed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** An unknown-command check in flight; see `send()`'s slash guard. */
  const slashCheckRef = useRef(false)
  const mode: AgentMode = state.session?.mode ?? 'normal'
  /**
   * Walking back through what you have already sent.
   *
   * The list is THIS conversation's user messages, newest last, with the harness's own
   * `role: 'user'` notes filtered out — a verify result and a plan focus note share the role
   * with your words and are not things you typed. Derived from `state.items` rather than
   * kept in a parallel list, so a resumed session has its history without a second thing to
   * restore, and it resets on a session switch for free.
   */
  const history = useMemo(
    () => state.items
      .filter((i): i is ChatItem & { kind: 'user' } => i.kind === 'user' && i.harness !== true)
      .map((i) => i.text),
    [state.items],
  )

  /**
   * Where in the history we are: -1 is "not recalling, the box is your own draft".
   *
   * The draft is stashed on the way in and restored on the way back out past the newest
   * entry, because losing a half-written message to a stray Up is the failure that makes
   * people stop using history at all.
   */
  const [historyAt, setHistoryAt] = useState(-1)
  const stashedDraft = useRef('')

  // A new message of your own ends the walk: the box is a draft again, and the entry you
  // had recalled is now in the history behind you.
  useEffect(() => { setHistoryAt(-1) }, [history.length])

  /** The caret is where an arrow has nothing else to do — the whole gate on recall. */
  function atStart(el: HTMLTextAreaElement): boolean {
    return el.selectionStart === 0 && el.selectionEnd === 0
  }
  function atEnd(el: HTMLTextAreaElement): boolean {
    return el.selectionStart === el.value.length && el.selectionEnd === el.value.length
  }

  /**
   * One step through the history, or null when there is nowhere to go.
   *
   * Returns the TEXT rather than moving the box itself, so the caller decides whether the
   * key was consumed — an Up at the oldest entry must stay an ordinary Up.
   */
  function recall(direction: -1 | 1): string | null {
    if (history.length === 0) return null
    if (direction === -1) {
      if (historyAt === -1) stashedDraft.current = input
      const next = historyAt === -1 ? history.length - 1 : historyAt - 1
      if (next < 0) return null
      setHistoryAt(next)
      return history[next] as string
    }
    if (historyAt === -1) return null
    const next = historyAt + 1
    if (next >= history.length) {
      // Past the newest entry is your own draft, not an empty box.
      setHistoryAt(-1)
      return stashedDraft.current
    }
    setHistoryAt(next)
    return history[next] as string
  }

  /** Puts a recalled message in the box with the caret at the END, which is where you want
   * it: recall is nearly always "that, with a change on the end". */
  function apply(text: string): void {
    setInput(text)
    setMention(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el === null) return
      el.focus()
      el.setSelectionRange(text.length, text.length)
    })
  }

  /**
   * A reply the model thinks you might send, offered as ghost text in an empty box.
   *
   * Asked only after an answer that ENDED IN A QUESTION. That gate is structural on
   * purpose: the assistant asked, so a reply is the obvious next thing, and the alternative
   * — asking after every turn — spends a generation proposing something nobody wanted.
   * Cleared the moment you type, because a suggestion competing with your own words is
   * noise, and cleared on a session switch, because it belongs to one conversation.
   */
  const [ghost, setGhost] = useState<string | null>(null)
  useEffect(() => { setGhost(null) }, [state.session?.sessionId])
  // Typing is the clearest possible "I do not want the suggestion". Cleared here rather
  // than inside the input handler so a draft restored from anywhere — a queued message
  // coming back, an undelivered turn — clears it too.
  useEffect(() => { if (input !== '') setGhost(null) }, [input !== ''])

  /** The shape that earns a suggestion: the last thing said was a question to YOU. Checked
   * on the last non-empty line, so a long answer that closes with a question still counts
   * and one that merely contains a rhetorical `?` in the middle does not. */
  function endsInQuestion(text: string): boolean {
    const lines = text.trimEnd().split('\n')
    const last = lines[lines.length - 1]?.trim() ?? ''
    return last.endsWith('?') || last.endsWith('？')
  }

  const newest = state.items.length > 0 ? state.items[state.items.length - 1] : undefined
  const lastAssistantText = newest !== undefined && newest.kind === 'assistant' ? newest.text : ''

  useEffect(() => {
    if (state.turnRunning || input !== '' || lastAssistantText === '') return
    if (!endsInQuestion(lastAssistantText)) return
    let cancelled = false
    client.call('prompt.reply', {})
      .then((r) => { if (!cancelled) setGhost(r.reply) })
      .catch(() => { /* no suggestion is a fine outcome, and not one worth reporting */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `input` gates entry, and
    // re-running on every keystroke would fire a generation per character.
  }, [client, state.turnRunning, lastAssistantText])

  /** Tab takes the suggestion. The caret lands at the end, because the usual next move is
   * to add a clause to it rather than to send it untouched. */
  function acceptGhost(): void {
    if (ghost === null) return
    const text = ghost
    setGhost(null)
    apply(text)
  }

  /** Whether the post-turn gates run by themselves. Read off the session, so it survives a
   * restart and does not follow you into a different conversation. */
  const gateMode = state.session?.gateMode ?? 'auto'

  /** Flips the gates, optimistically. The host is the truth, but a chip that waits for a
   * round trip before changing reads as a click that did nothing. */
  function setGateMode(next: 'auto' | 'manual'): void {
    dispatch({ type: 'gate-mode', gateMode: next })
    client.call('gates.set', { mode: next })
      .catch((e: Error) => {
        dispatch({ type: 'gate-mode', gateMode })
        dispatch({ type: 'error-note', message: e.message })
      })
  }

  // Suggestions are distilled against ONE session's transcript; a switch makes them
  // foreign context wearing familiar chips. The draft itself survives — only the model's
  // additions to it are session-bound.
  const sessionId = state.session?.sessionId
  useEffect(() => {
    setSuggested(null)
    setExpandPreview(null)
    setOpenQuestion(null)
    improvedFor.current = ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    // A running GATE keeps the clock going too. `/check` and `/review` run with no turn, and
    // without this their elapsed reading froze at the second the stage opened — a number
    // that has stopped moving is exactly how a hang looks.
    if (!state.turnRunning && state.runningStage === null) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [state.turnRunning, state.runningStage === null])

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
  }, {
    name: 'check',
    description: "Run this workspace's build and tests now, on the work as it stands",
  }, {
    name: 'review',
    description: 'Have a reader with a fresh context go over the change now',
  }, {
    name: 'gates',
    description: 'gates off — stop building, auditing and reviewing after every turn. gates on — resume',
  }]
  const matching = slashPrefix === null || commandsDismissed
    ? []
    : [...BUILT_IN, ...commands].filter((c) => c.name.startsWith(slashPrefix)).slice(0, 8)
  const pickedCommand = matching[Math.min(commandPick, Math.max(0, matching.length - 1))]

  /** Completes the picked entry into the box, ready for arguments (or a plain Enter). */
  function chooseCommand(name: string): void {
    setInput(`/${name} `)
    setCommandPick(0)
    textareaRef.current?.focus()
  }

  useEffect(() => {
    if (mention === null) { setMentionHits([]); return }
    let cancelled = false
    client.call('fs.find', { query: mention.query, limit: 8 })
      .then((r) => { if (!cancelled) { setMentionHits(r.entries); setMentionPick(0) } })
      .catch(() => { if (!cancelled) setMentionHits([]) })
    return () => { cancelled = true }
  }, [client, mention?.query])

  /**
   * Attaches paths the person did not type: a drop from Explorer, a drag out of the tree.
   *
   * Both halves are required and neither is optional. `attached` is the list `submit` sends;
   * the text is what keeps it there, because `liveAttachments` filters `attached` by what is
   * still written in the box (see its comment). Appended at the END rather than at the caret
   * — a drop has no caret, and splicing into the middle of a half-written sentence is not
   * what anyone means by dropping a file on a window.
   */
  function attachPaths(paths: string[]): void {
    if (paths.length === 0) return
    setAttached((a) => [...new Set([...a, ...paths])])
    setInput((text) => {
      const fresh = paths.filter((p) => !text.includes(`@${p}`))
      if (fresh.length === 0) return text
      const mentions = fresh.map((p) => `@${p}`).join(' ')
      // The space before matters: `mentionAtCaret` only opens the picker on an `@` that
      // starts a word, so gluing a mention onto the previous word would make a token that
      // reads as a mention to `liveAttachments` and as prose to everything else.
      return text === '' ? `${mentions} ` : `${text.replace(/\s+$/, '')} ${mentions} `
    })
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  /**
   * Files and folders dropped onto the window from outside the app.
   *
   * Tauri's own drag-drop event, not HTML5. That is not a preference: the webview
   * intercepts OS drops by default (`dragDropEnabled`, on since the window was created), so
   * an HTML5 `drop` handler never fires on Windows — and even with the interception turned
   * off, a WebView2 renderer is handed `File` objects with no filesystem path, while
   * `attach` is a list of paths. The Tauri route gives absolute OS paths, which is exactly
   * what the host can map into the workspace.
   *
   * Imported lazily and failing quietly, because the dev bridge (`?ws=`) is a plain browser
   * tab with no Tauri IPC at all. Dropping a file there does nothing, which is honest — the
   * alternative is a boot-time crash in the one mode used for UI work.
   */
  const [dropping, setDropping] = useState(false)
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview')
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload
          if (payload.type === 'enter' || payload.type === 'over') { setDropping(true); return }
          if (payload.type === 'leave') { setDropping(false); return }

          setDropping(false)
          if (payload.paths.length === 0) return
          client.call('attach.resolve', { paths: payload.paths })
            .then((r) => {
              attachPaths(r.resolved.map((x) => x.path))
              // Said out loud, one line each. A file that silently failed to attach is the
              // failure mode that matters here: you would send the message believing the
              // model had been shown something it never saw.
              for (const bad of r.rejected) {
                dispatch({ type: 'settings-problem', text: `${bad.path} was not attached: ${bad.reason}` })
              }
            })
            .catch((e: Error) => dispatch({ type: 'settings-problem', text: `Drop failed: ${e.message}` }))
        })
        if (cancelled) stop()
        else unlisten = stop
      } catch {
        // Not running under Tauri. Nothing to listen to, and nothing wrong.
      }
    })()

    return () => { cancelled = true; unlisten?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attachPaths is re-created per render by design
  }, [client, dispatch])

  /**
   * Paths dragged out of the workspace tree, which cannot use the route above.
   *
   * Tauri's event only sees drags arriving from OUTSIDE the app; a drag that starts and
   * ends inside the window never reaches it. Nor can that half use HTML5 drag-and-drop —
   * the same `dragDropEnabled` that makes the Explorer drop deliver PATHS is documented by
   * Tauri as disabling HTML5 DnD on Windows, so the two features would trade places rather
   * than coexist. Pointer events belong to neither mechanism and so work alongside both;
   * `lib/drag.ts` carries the reasoning and the store.
   *
   * Capture phase, deliberately: the tree's own pointerup ends the drag, and this listener
   * has to read it first. Capture on `window` runs before any bubble-phase listener for the
   * same event, which makes that an ordering guarantee instead of a race.
   */
  const composerRef = useRef<HTMLDivElement>(null)
  /** The drag in flight, or null. Held as state (not read from the store on render) so the
   * chip follows the cursor: the store notifies on every move, and this is what turns that
   * into a re-render. */
  const [carried, setCarried] = useState<PathDrag | null>(null)
  const carrying = carried !== null
  useEffect(() => subscribePathDrag((drag) => {
    setCarried(drag)
    setDropping(drag !== null && within(composerRef.current, drag.x, drag.y))
  }), [])

  useEffect(() => {
    function onUp(e: PointerEvent): void {
      const drag = pathDrag()
      if (drag === null) return
      if (!within(composerRef.current, e.clientX, e.clientY)) return
      attachPaths(drag.paths)
    }
    window.addEventListener('pointerup', onUp, { capture: true })
    return () => window.removeEventListener('pointerup', onUp, { capture: true })
    // `attachPaths` is captured once, and that is safe rather than overlooked: its body
    // touches only its argument, the two state setters (stable by identity) and a ref. It
    // reads no render-scoped value, so a fresh closure per render would behave identically.
  }, [])

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
  // `improving` is in the list because `prompt.improve` holds the same host-side sending
  // slot a turn does: a send fired into that window is refused, rolled back, requeued, and
  // the drain effect resubmits it instantly — a refusal loop at WS round-trip rate until
  // the improve finishes. Counted as busy, the send queues once and drains after.
  const busy = state.turnRunning || state.run !== null || compacting || improving
  const blockedByRun = state.viewing !== null && busy
  // For the ONE caller that runs after an await: the unknown-command check resolves against
  // whatever is true THEN, not what was true at render time. A stale `busy === false`
  // captured before the fetch would walk a message straight into a slot a run had taken.
  const busyRef = useRef(busy)
  busyRef.current = busy
  // For the abort-on-send in deliver(): true when the ONLY thing holding the host slot
  // is a draft preview (improve/expand) — the one busy contributor safe to kill.
  const previewHoldsSlot = improving && !state.turnRunning && state.run === null && !compacting
  const previewHoldsSlotRef = useRef(previewHoldsSlot)
  previewHoldsSlotRef.current = previewHoldsSlot

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
  // ONE effect for both things that can happen to the queue, because their ORDER is the
  // bug surface: as two effects, a session switch (which also resets turnRunning) ran the
  // drain first, and the drain submitted session A's queued message as a real turn into
  // session B before the restore ever saw it. Here the switch check comes first, always.
  const drainSessionRef = useRef(state.session?.sessionId)
  useEffect(() => {
    const sessionId = state.session?.sessionId
    if (drainSessionRef.current !== sessionId) {
      drainSessionRef.current = sessionId
      // Not delivered to the new session — a queued message belongs to the conversation it
      // was typed into — but not destroyed either: back into the box, the same affordance
      // the chip's own "edit" button offers.
      if (queued.length > 0) {
        const restored = queued.map((q) => q.text).join('\n')
        setInput((cur) => (cur === '' ? restored : `${restored}\n${cur}`))
        setAttached((a) => [...new Set([...a, ...queued.flatMap((q) => q.attach)])])
        setQueued([])
      }
      return
    }
    if (state.turnRunning || state.run !== null || compacting || improving || queued.length === 0) return
    const [next, ...rest] = queued
    setQueued(rest)
    // Entries were guarded when they were typed (the slash check runs before queueing), so
    // the drain only routes: a queued /compact runs as the command it is, everything else
    // sends. One entry per drain — sending starts a turn, and the next entry waits for it.
    // Same three-way branch as `send`: a queued entry is drained through the same paths it
    // would have taken had the session been idle when it was typed.
    const queuedGate = GATE_COMMANDS[next!.text]
    if (next!.text === COMPACT_COMMAND) runCompact()
    else if (queuedGate !== undefined) runGate(queuedGate)
    else submit(next!.text, next!.attach)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submit is recreated per render
  }, [state.turnRunning, state.run, compacting, improving, queued, state.session?.sessionId])

  // A queued message belongs to the conversation it was typed into. Switching sessions
  // must not deliver it to a different one.

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
      // A NOTE — this branch fires precisely BECAUSE a turn is streaming, and send-failed
      // would flip that turn to not-running, the exact poisoning its message warns about.
      dispatch({
        type: 'error-note',
        message: 'A turn started while the run card was open — let it finish (or stop it), then start the run.',
      })
      return
    }
    const maxTurns = parseBudget(maxTurnsText)
    const maxHours = parseBudget(maxHoursText)
    if (maxTurns === null || maxHours === null) {
      dispatch({ type: 'error-note', message: 'A budget is a positive number, or empty for none.' })
      return
    }
    setRunConfigOpen(false)
    setInput('')
    // The same advisor cleanup submit() does: the draft the chips and the preview
    // described was just consumed as the run's task, and turnRunning stays false for a
    // run's whole duration — without this the stale card sat on screen all run long.
    setSuggested(null)
    setExpandPreview(null)
    setOpenQuestion(null)
    improvedFor.current = ''
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
    // Accepted suggestions travel glued BELOW the draft; the draft itself goes as typed.
    // Glued before the length guard and before the optimistic row, so what the user sees
    // in the transcript is exactly what the model received. NOT glued onto a slash
    // command: chips belong to the task draft they were made for, and if the box now holds
    // `/compact` (the draft was replaced after they arrived) gluing would break the
    // exact-match above and feed the chips to a command as arguments.
    const draft = input.trim()
    const text = (suggested !== null && !/^\/[a-z0-9-]+(\s|$)/i.test(draft)
      ? glueSuggestions(draft, suggested, accepted, answers)
      : draft)
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
        setQueued((q) => [...q, { text: COMPACT_COMMAND, attach: [] }])
        return
      }
      runCompact()
      return
    }

    // The gate commands, handled here for the same reason `/compact` is: none of them is a
    // message to anyone, and sending one as chat would have the model announce it had done
    // something it has no tool for. They queue behind a running turn, also like `/compact` —
    // the server has one slot, and a gate makes model calls.
    // The doctor runs no model calls at all — it walks the stored files — so unlike the
    // gates it does not queue behind a turn and does not touch the one server slot.
    if (DOCTOR_COMMANDS.includes(text.trim().toLowerCase())) {
      setInput('')
      setMention(null)
      runDoctor()
      return
    }

    const gate = GATE_COMMANDS[text.trim().toLowerCase()]
    if (gate !== undefined) {
      setInput('')
      setMention(null)
      if (busy) {
        setQueued((q) => [...q, { text: text.trim().toLowerCase(), attach: [] }])
        return
      }
      runGate(gate)
      return
    }
    if (text.trim().toLowerCase() === GATES_OFF || text.trim().toLowerCase() === GATES_ON) {
      const manual = text.trim().toLowerCase() === GATES_OFF
      setInput('')
      setMention(null)
      // Through the SAME setter the chip uses. It did not, and the two disagreed: the
      // command changed the session and the chip went on showing the old state, which is
      // worse than having no chip — an indicator that is sometimes wrong is one you have to
      // stop believing.
      setGateMode(manual ? 'manual' : 'auto')
      dispatch({
        type: 'error-note',
        tone: 'info',
        message: manual
          ? 'Automatic checks are off for this session. Nothing builds, audits or reviews '
            + 'until you ask: /check runs the build and tests, /review runs the '
            + 'independent read of the diff.'
          : 'Automatic checks are back on for this session.',
      })
      return
    }

    // A slash command that is not one does NOT go to the model as chat. Watched live: a
    // stray "/compact/compact" reached the model as text, and the model — having no
    // compaction tool at all — confidently announced "the context is now compacted". A
    // typo'd command answered with a fabricated success is strictly worse than an error.
    // Only a leading single-token `/name` is treated as an attempted command; a path like
    // `/etc/hosts` fails the shape test and is sent as the ordinary text it is.
    const slash = /^\/([a-z0-9-]+)(?:\s|$)/i.exec(text)
    if (slash) {
      const name = slash[1]!.toLowerCase()
      // A built-in reaching here means it was written with arguments it does not take
      // (`/review now`), or `/gates` without on|off. Same NOTE treatment as `/compact`:
      // send-failed would end a turn that is streaming perfectly well.
      if (name === 'check' || name === 'review') {
        dispatch({ type: 'error-note', message: `/${name} takes no arguments. Nothing was sent.` })
        return
      }
      if (name === 'gates') {
        dispatch({ type: 'error-note', message: '/gates takes "on" or "off". Nothing was sent.' })
        return
      }
      if (name === 'compact') {
        // `/compact` alone was handled above, so this is `/compact <something>`. A NOTE,
        // not send-failed: this can fire mid-turn, and send-failed would end a turn that
        // is streaming fine.
        dispatch({ type: 'error-note', message: '/compact takes no arguments. Nothing was sent.' })
        return
      }
      const knownIn = (list: { name: string }[]): boolean =>
        list.some((c) => c.name.toLowerCase() === name)
      const refuse = (available: { name: string }[]): void => {
        const known = ['/compact', ...BUILT_IN.slice(1).map((c) => `/${c.name}`),
          ...available.map((c) => `/${c.name}`)].join(', ')
        dispatch({
          type: 'error-note',
          message: `/${name} is not a command here (${known}). Nothing was sent — the model cannot run commands it does not have.`,
        })
      }
      if (!knownIn(commands)) {
        // The cache is filled by typing a slash, but a pasted command arrives whole and may
        // land before any fetch — ask once more before refusing, and deliver after all if
        // the workspace really has it. One check at a time: the text stays in the box while
        // this resolves, so a second Enter would otherwise fire a second fetch and send the
        // same message twice.
        if (slashCheckRef.current) return
        slashCheckRef.current = true
        client.call('commands.list', {})
          .then((r) => {
            setCommands(r.commands)
            if (knownIn(r.commands)) deliver(text)
            else refuse(r.commands)
          })
          .catch(() => refuse(commands))
          .finally(() => { slashCheckRef.current = false })
        return
      }
    }

    deliver(text)
  }

  /** The second half of `send()`: routing that applies once the text is cleared to go. */
  function deliver(text: string): void {
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
          // The failure must land where the user is LOOKING, and the text must survive.
          // The error row is appended to the live session's items, which the transcript
          // does not show while `viewing` is set — so end the viewing; and the box was
          // already cleared, so put the message back rather than losing it.
          dispatch({ type: 'viewing-ended' })
          dispatch({ type: 'error-note', message: e instanceof Error ? e.message : String(e) })
          setInput((cur) => (cur === '' ? pending.text : `${pending.text}\n${cur}`))
          setAttached((a) => [...new Set([...a, ...pending.attach])])
        })
      return
    }
    // A queued message carries its OWN attachments. Leaving them in the shared picker state
    // meant the files you picked for the NEXT message were cleared when the queued one
    // finally drained.
    const attach = liveAttachments
    // Read through the ref, not the render closure: `deliver` also runs after the
    // unknown-command fetch resolves, by which point a run may have taken the slot.
    if (busyRef.current) {
      // Appended as its OWN entry, never merged into the previous one — see `queued`.
      setQueued((q) => [...q, { text, attach }])
      setInput('')
      setAttached([])
      setMention(null)
      // When the only thing ahead of the queue is an auto-fired preview, waiting is
      // pure loss: the box just emptied, so its result is guaranteed to be discarded.
      // Kill it — the host's currentAbort IS the preview's controller, the draft
      // helpers swallow the abort into null, `improving` clears, the drain submits.
      if (previewHoldsSlotRef.current) void client.call('abort', {}).catch(() => { /* already over */ })
      return
    }
    submit(text, attach)
  }

  function runCompact(): void {
    setCompacting(true)
    client.call('compact', {})
      .catch((e: unknown) => {
        dispatch({ type: 'send-failed', message: e instanceof Error ? e.message : String(e) })
      })
      .finally(() => setCompacting(false))
  }

  /**
   * Runs one gate on demand, and holds the turn flag while it does.
   *
   * `compacting` is reused rather than a second flag of its own: it means "this window is
   * holding the host's single slot for something that is not a chat turn", which is exactly
   * what a gate does. A second boolean would have to be checked everywhere this one already
   * is, and the first place it was forgotten would let a message be sent into a busy host.
   */
  function runDoctor(): void {
    client.call('doctor.run', {})
      .then((r) => {
        if (r.sessions === 0) {
          // Not a page of zeroes, which reads as "this agent has done nothing wrong".
          dispatch({ type: 'error-note', tone: 'info', message: r.report })
          return
        }
        dispatch({ type: 'diagnosis', report: r.report, savedTo: r.savedTo })
      })
      .catch((e: unknown) => {
        dispatch({ type: 'send-failed', message: e instanceof Error ? e.message : String(e) })
      })
  }

  function runGate(gate: 'build' | 'review'): void {
    setCompacting(true)
    client.call('gates.run', { gate })
      .then((r) => {
        // A gate that wrote nothing to the transcript still has to answer. Watched live:
        // `/review` on a session with no contract ran, closed, and left no trace at all —
        // the stage line flashed past in under a second and the person was left wondering
        // whether the command had even been recognised. Only when the transcript is silent,
        // so a review that reported findings does not get a redundant summary under them.
        if (!r.reported) {
          dispatch({
            type: 'error-note',
            tone: 'info',
            message: `/${gate === 'build' ? 'check' : 'review'}: ${r.outcome}`,
          })
        }
      })
      .catch((e: unknown) => {
        dispatch({ type: 'send-failed', message: e instanceof Error ? e.message : String(e) })
      })
      .finally(() => setCompacting(false))
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
    setSuggested(null)
    setExpandPreview(null)
    setOpenQuestion(null)
    improvedFor.current = ''
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
        // Undo the optimism FIRST: `turn-started` above set `turnRunning` for a turn the
        // host refused to start, and nothing else ever clears it (a run's turns emit no
        // `turn.done`), so without this the composer wedges on Stop forever — and the
        // optimistic user-message row would render again when the queue drains.
        dispatch({ type: 'send-rolled-back' })
        setQueued((q) => [...q, { text, attach }])
        return
      }
      dispatch({ type: 'send-failed', message })
    })
  }

  function abort(): void {
    client.call('abort', {}).catch(() => { /* see the Esc handler */ })
  }

  /**
   * The model half of the prompt improver. One small request against the idle slot; the
   * lint chips are the free half. `auto` swallows refusals (the pause trigger must never
   * nag about a busy slot); Ctrl+E reports them. A result for a draft that changed while
   * the request flew is DISCARDED — suggestions must describe the text under the cursor.
   */
  function improve(auto = false): void {
    // The full busy set plus `viewing`, not just turnRunning: a run and a compaction hold
    // the same host slot (each fire would be a refusal, and the auto path retried it every
    // pause for the length of a run), and while READING an earlier session the host would
    // distill against the live one — the wrong conversation entirely.
    if (improving || state.turnRunning || state.run !== null || compacting || state.viewing !== null) return
    if (!taskShaped(input)) return
    const draft = input
    if (auto && draft === improvedFor.current) return
    setImproving(true)
    client.call('prompt.improve', { text: draft })
      .then((r) => {
        if (textareaRef.current !== null && textareaRef.current.value !== draft) return
        improvedFor.current = draft
        if (r.suggestions !== null) {
          // The user's curation survives a re-improve: chips that came back verbatim keep
          // their state, only genuinely new ones arrive in the default one.
          const carried = carryAcceptance(r.suggestions, suggested, accepted, answers)
          setSuggested(r.suggestions)
          setAccepted(carried.accepted)
          setAnswers(carried.answers)
          setOpenQuestion(null)
          // One draft, one advisor: chips and an expansion preview must never describe
          // the box at the same time.
          setExpandPreview(null)
        } else if (!auto) {
          // A manual Ctrl+E deserves an answer even when it is "nothing": silence here
          // read as the button being broken. Auto stays quiet — that is its whole point.
          setImproveNote('nothing to add')
          setTimeout(() => setImproveNote(null), 4_000)
        }
      })
      .catch((e: unknown) => {
        // A refused draft is not retried until edited — without this, the pause trigger
        // re-armed on every `improving` flip and hammered a busy host every ~2 seconds.
        improvedFor.current = draft
        if (!auto) dispatch({ type: 'error-note', message: e instanceof Error ? e.message : String(e) })
      })
      .finally(() => setImproving(false))
  }

  /**
   * The other model half: a short rough command ("make a red button") grown into a
   * detailed brief out of what the session context already knows about the project —
   * repo map, notes, conversation. A PREVIEW: nothing replaces the draft without a
   * click. Same slot and stale-discard discipline as improve() above.
   */
  function expand(auto = false): void {
    // Same guard set as improve(), same reasons — see there.
    if (improving || state.turnRunning || state.run !== null || compacting || state.viewing !== null) return
    const draft = input
    if (draft.trim().length < 8) return
    if (auto && draft === improvedFor.current) return
    setImproving(true)
    client.call('prompt.expand', { text: draft })
      .then((r) => {
        if (textareaRef.current !== null && textareaRef.current.value !== draft) return
        improvedFor.current = draft
        if (r.expanded !== null) {
          expandFor.current = draft
          setExpandPreview(r.expanded)
          // One draft, one advisor — chips from an earlier, different draft must not be
          // glued below a brief they never described.
          setSuggested(null)
          setAccepted(new Set())
          setAnswers(new Map())
          setOpenQuestion(null)
        } else if (!auto) {
          setImproveNote('the model added no detail')
          setTimeout(() => setImproveNote(null), 4_000)
        }
      })
      .catch((e: unknown) => {
        improvedFor.current = draft
        if (!auto) dispatch({ type: 'error-note', message: e instanceof Error ? e.message : String(e) })
      })
      .finally(() => setImproving(false))
  }

  // The preview describes exactly one draft, and its accept REPLACES the box — so the
  // card leaves the moment the draft diverges. Accepting is safe against this effect:
  // it clears the preview in the same commit that changes the input.
  useEffect(() => {
    if (expandPreview !== null && input !== expandFor.current) setExpandPreview(null)
  }, [input, expandPreview])

  /** Ctrl+E and the pause trigger route by draft shape: a long task-shaped draft gets
   * the suggestion chips, everything else gets the expansion preview. */
  function improveOrExpand(auto = false): void {
    if (taskShaped(input)) improve(auto)
    else expand(auto)
  }

  // THE PAUSE TRIGGER IS GONE, and its absence is the feature.
  //
  // It fired on three invisible gates at once — a lint heuristic deciding the draft was
  // "task-shaped with 2+ gaps", two quiet seconds, and a free slot — so from outside it
  // appeared sometimes and not others with nothing to explain the difference. Reported as
  // "где-то она появляется, где-то нет".
  //
  // The half of it that was worth having is now the understanding check, which runs in the
  // core: it reads the request through three lenses at the moment the model stops reading
  // files and is about to write one, and asks only where its own readings disagreed. That
  // arrives as an ordinary question in the conversation rather than as chips over the input,
  // it cannot invent a question (the text of one IS one of the readings), and it never fires
  // twice for the same task.
  //
  // What is left here is the rule that makes the composer predictable: AUTOMATIC things ask,
  // and things that WRITE into your draft happen only when you press the button. Ctrl+E and
  // the Improve/Expand controls below are unchanged.

  function applyMode(next: AgentMode): void {
    dispatch({ type: 'mode-changed', mode: next })
    client.call('setMode', { mode: next }).catch((e: unknown) => {
      // A note: a failed mode switch is not a failed send, and this can run mid-turn.
      dispatch({ type: 'error-note', message: e instanceof Error ? e.message : String(e) })
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
  //
  // Which BUDGET the silence counts against depends on where in the step it is. Until the
  // first token — at the step's start AND at a forced continuation, both of which re-prefill
  // — the core's clock is armed with the prefill-inclusive budget: everything appended has
  // to be processed before anything can stream, minutes for a big tool result. Counting that
  // stretch against the flat between-token budget showed "0s to timeout" for half a minute
  // over a step that then completed. `waitingFirstToken` is the reducer's own record of
  // which stretch this is.
  const stepBudgetMs = step === null
    ? null
    : step.waitingFirstToken
      ? step.firstTokenTimeoutMs ?? step.timeoutMs
      : step.timeoutMs
  const remainingMs = step && stepBudgetMs !== null
    ? Math.max(0, stepBudgetMs - (now - step.aliveAtMs))
    : null
  const last = state.lastStepDone
  const waitingOnYou = state.pendingApproval !== null || state.pendingQuestion !== null
  // The call actually EXECUTING, which is the oldest one still unanswered — not the last
  // item. A step runs its calls in order, so while call 1 runs, calls 2 and 3 already have
  // cards; the last of them is the one the model wrote most recently, not the one running.
  // `npm test` executing for three minutes under the label `running write_file` is the
  // shape of it. `pendingTool` is the same rule the reducer uses to route a result.
  const runningTool = pendingTool(state.items)?.name ?? null
  /** The gate running right now. Outranks every other reading in `statusLine`. */
  const stage = state.runningStage

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

  /** What the server says about the running request, or null when it says nothing. */
  const measured = step?.progress !== undefined ? formatProgress(step.progress) : null

  function statusLine(): VNode | null {
    if (waitingOnYou) return <span class="status-live">waiting on you · nothing generating</span>
    // A gate outranks everything below it, and it is checked BEFORE `turnRunning` rather
    // than inside it. Two reasons, and the second was found by running the built app: a gate
    // is the truest thing on screen during a turn — the premise and understanding gates run
    // from `onBeforeTool`, AFTER the agent has announced the write, so `runningTool` says
    // "running edit_file" for a write that has not started and may be vetoed outright — and
    // a gate asked for by hand (`/check`, `/review`) runs with NO turn at all, so nested
    // under `turnRunning` the status line stayed empty for the whole of it. Watched live:
    // six seconds of a build running and nothing on screen saying so.
    if (stage !== null) {
      return (
        <span class="status-live">
          {STAGE_LABEL[stage.stage]} · {formatDuration(now - stage.startedAtMs)}
          {stage.at !== undefined && (
            <span class="status-quiet"> · {stage.at.index}/{stage.at.total}</span>
          )}
          {stage.detail !== undefined && <span class="status-quiet"> · {stage.detail}</span>}
        </span>
      )
    }
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
          {/* The server's own reading, when it sends one, outranks every inference above:
              `reading 12.4k / 18.1k · 9.7k cached` says what the silence IS, and the cached
              figure says why this one is long. The inferences stay as the fallback for a
              server built without `return_progress` — they were right about the state and
              could only ever guess at its size. */}
          {composingCall && <span class="status-quiet"> · writing the change</span>}
          {measured !== null
            ? <span class="status-quiet"> · {measured}</span>
            : composingCall
              ? <span class="status-quiet"> — the tool call is generated a token at a time, like the reasoning above it</span>
              : !streaming && <span class="status-quiet"> · reading what the last step returned</span>}
          {remainingMs !== null && remainingMs < 20_000 && (
            // At zero the honest statement is what happens next, not a number that has
            // stopped moving: the core abandons the step within moments of its own clock
            // expiring, so a "0s" that persists longer than that would be this countdown
            // being wrong, never the step being fine.
            <span class="warn"> · {remainingMs > 0
              ? `${Math.ceil(remainingMs / 1000)}s to timeout`
              : 'out of time — abandoning this step'}</span>
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
    <div
      ref={composerRef}
      /* Two independent sources for one highlight: `dropping` is set by Tauri's OS-level
         drag event (a file from Explorer) and by a tree row being carried over this box.
         `carrying` is the weaker state — something is in flight somewhere on screen — and
         it is what makes the target findable while the pointer is still elsewhere. */
      class={`composer${carrying ? ' composer-carrying' : ''}${dropping ? ' composer-dropping' : ''}`}
    >
      {/* What is being carried, under the cursor. A pointer drag has no browser-supplied
          drag image, so without this the gesture is invisible and indistinguishable from a
          stuck click. Rendered here rather than in App because the composer already owns
          the drag subscription; `position: fixed` makes its place in the tree irrelevant. */}
      {carried !== null && (
        <div
          class="drag-chip"
          style={{ left: `${carried.x + 12}px`, top: `${carried.y + 12}px` }}
          aria-hidden="true"
        >
          {carried.paths.length === 1
            ? (carried.paths[0] as string).split('/').pop()
            : `${carried.paths.length} paths`}
        </div>
      )}
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
          {matching.map((c, i) => (
            <button
              key={c.name}
              class={`command-item ${c === pickedCommand ? 'command-item-on' : ''}`}
              onMouseEnter={() => setCommandPick(i)}
              onClick={() => chooseCommand(c.name)}
            >
              <span class="command-name">/{c.name}</span>
              <span class="command-desc">{c.description}</span>
            </button>
          ))}
          <div class="picker-hint">
            <kbd>↑↓</kbd> pick · <kbd>↵</kbd> complete · <kbd>Esc</kbd> dismiss
          </div>
        </div>
      )}

      {mention !== null && mentionHits.length > 0 && (
        <div class="command-picker">
          {mentionHits.map((hit, i) => (
            <button
              key={hit.path}
              class={`command-item ${i === mentionPick ? 'command-item-on' : ''}`}
              onMouseEnter={() => setMentionPick(i)}
              onClick={() => choose(hit.path)}
            >
              <span class="command-icon">{hit.dir ? Icon.folder() : Icon.file()}</span>
              <span class="command-desc" title={hit.path}>
                {hit.path}
                {hit.dir && <span class="command-hint"> — the files in it</span>}
              </span>
            </button>
          ))}
          <div class="picker-hint">
            <kbd>↑↓</kbd> pick · <kbd>↵</kbd> attach · a file sends its contents, a folder sends its file list
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

      {queued.map((q, qi) => (
        <div class="queued-note" key={qi}>
          <span class="queued-label">Queued</span>
          <span class="queued-text" title={q.text}>{q.text}</span>
          <button
            class="queued-edit"
            onClick={() => {
              setInput((i) => (i === '' ? q.text : `${q.text}\n${i}`))
              setAttached((a) => [...new Set([...a, ...q.attach])])
              setQueued((qs) => qs.filter((_, j) => j !== qi))
            }}
            title="Put it back in the box"
          >
            edit
          </button>
          <button
            class="icon-button"
            onClick={() => setQueued((qs) => qs.filter((_, j) => j !== qi))}
            title="Discard it"
          >
            {Icon.x()}
          </button>
        </div>
      ))}

      {/* One bordered surface holding the input and everything that acts on it. The three
          separate strips this replaced -- a status line above, the box, a row of pills
          below -- read as three unrelated widgets stacked around a text field.

          The anchor div exists for the run-config popover alone: the shell clips its
          children (overflow:hidden, for the rounded corners and the activity sweep), and
          the popover used to live INSIDE it — anchored above the bar, i.e. entirely inside
          the clip box, which showed only its bottom ~28px sliver over a one-line textarea.
          Anchored to this wrapper it sits above the shell, unclipped. */}
      <div class="composer-anchor">
        {runConfigOpen && (
          <div
            class="run-config"
            role="dialog"
            aria-label="Start an unattended run"
            onKeyDown={(e) => {
              // Escape dismisses the card and STOPS: the window listener would abort the
              // turn that startRun's own guard documents can already be running.
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRunConfigOpen(false) }
            }}
          >
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

      <div class={`composer-shell ${state.turnRunning ? 'composer-shell-live' : ''}`}>
        <div class="composer-activity" aria-hidden="true" />

        <textarea
          ref={textareaRef}
          class={`composer-input${ghost !== null && input === '' ? ' has-ghost' : ''}`}
          value={input}
          rows={1}
          onInput={(e) => {
            const el = e.currentTarget
            setInput(el.value)
            // Typing re-opens a dismissed command picker and resets its selection.
            setCommandsDismissed(false)
            setCommandPick(0)
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
            // The model half of the prompt improver, from the keyboard the draft is
            // already under. Guarded inside improve(): task-shaped, idle, not already in
            // flight.
            if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
              e.preventDefault()
              improveOrExpand()
              return
            }
            const picking = mention !== null && mentionHits.length > 0
            // The command picker gets the same keyboard the mention picker has — without
            // this, arrows moved the caret, Enter submitted the half-typed prefix straight
            // into the slash guard's refusal, and Escape reached the window abort listener.
            if (!picking && matching.length > 0) {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setCommandsDismissed(true)
                return
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCommandPick((i) => (i + 1) % matching.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCommandPick((i) => (i - 1 + matching.length) % matching.length)
                return
              }
              if (e.key === 'Tab') {
                e.preventDefault()
                if (pickedCommand) chooseCommand(pickedCommand.name)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                // Enter on a fully-typed command falls through and SENDS it; on a prefix it
                // completes the picked entry instead.
                const typed = input.trim().slice(1).toLowerCase()
                if (!matching.some((c) => c.name.toLowerCase() === typed)) {
                  e.preventDefault()
                  if (pickedCommand) chooseCommand(pickedCommand.name)
                  return
                }
              }
            }
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
                const path = mentionHits[mentionPick]?.path
                if (path !== undefined) choose(path)
                return
              }
            }
            // Tab takes the ghost suggestion. Reached only with an empty box and no picker
            // open — both pickers claim Tab above and return — so this can never steal the
            // key from a completion.
            if (e.key === 'Tab' && ghost !== null && input === '') {
              e.preventDefault()
              acceptGhost()
              return
            }
            // History, and only where an arrow has nothing better to do.
            //
            // Up recalls only with the caret at the very start, Down only at the very end.
            // That is not politeness about the caret — it is what lets the same two keys
            // stay ordinary text navigation inside a multi-line draft, which is most of
            // what they are for. Both pickers above have already claimed the key by the
            // time this runs, so a recall can never fight a dropdown.
            if (e.key === 'ArrowUp' && !e.shiftKey && atStart(e.currentTarget)) {
              const recalled = recall(-1)
              if (recalled !== null) { e.preventDefault(); apply(recalled) }
              return
            }
            if (e.key === 'ArrowDown' && !e.shiftKey && atEnd(e.currentTarget)) {
              const recalled = recall(1)
              if (recalled !== null) { e.preventDefault(); apply(recalled) }
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={ghost !== null && !state.turnRunning && !blockedByRun
            ? `${ghost}    (Tab)`
            : blockedByRun
            ? 'Reading an earlier session. Wait for the running turn, or go back to it, then write here to continue this one.'
            : state.viewing !== null
              ? 'Write here to continue this session from now on — the current one stops being the active one'
              : state.turnRunning
                ? 'Type your next message — it is sent when this turn ends. Esc stops.'
                : 'Ask for a change, a review, or an explanation'}
        />

        {!state.turnRunning && suggested !== null && (
          <div class="prompt-hints" aria-live="polite">
            {/* The model's suggestions as toggle chips: on = travels with the send,
                appended BELOW the draft — the draft itself is never rewritten. Questions
                travel only once answered; clicking one opens its answer box. */}
            {suggested.criteria.map((c) => (
              <button
                key={`c:${c}`}
                class={accepted.has(`c:${c}`) ? 'prompt-suggest prompt-suggest-on' : 'prompt-suggest'}
                aria-pressed={accepted.has(`c:${c}`)}
                title={`Done criterion — travels with the message:
${c}`}
                onClick={() => {
                  setAccepted((prev) => {
                    const next = new Set(prev)
                    if (next.has(`c:${c}`)) next.delete(`c:${c}`)
                    else next.add(`c:${c}`)
                    return next
                  })
                  textareaRef.current?.focus()
                }}
              >
                {accepted.has(`c:${c}`) ? '☑' : '☐'} {c}
              </button>
            ))}
            {suggested.constraints.map((c) => (
              <button
                key={`k:${c}`}
                class={accepted.has(`k:${c}`) ? 'prompt-suggest prompt-suggest-on' : 'prompt-suggest'}
                aria-pressed={accepted.has(`k:${c}`)}
                title={`Constraint — travels with the message:
${c}`}
                onClick={() => {
                  setAccepted((prev) => {
                    const next = new Set(prev)
                    if (next.has(`k:${c}`)) next.delete(`k:${c}`)
                    else next.add(`k:${c}`)
                    return next
                  })
                  textareaRef.current?.focus()
                }}
              >
                {accepted.has(`k:${c}`) ? '☑' : '☐'} {c}
              </button>
            ))}
            {suggested.questions.map((q) => (
              <span key={`q:${q}`} class="prompt-question-wrap">
                <button
                  class={answers.get(q)?.trim() ? 'prompt-suggest prompt-suggest-on' : 'prompt-suggest prompt-question'}
                  title={answers.get(q)?.trim()
                    ? `Travels as a clarification:
${q} — ${answers.get(q)}`
                    : `The improver's question — travels only with your answer:
${q}`}
                  onClick={() => setOpenQuestion((cur) => cur === q ? null : q)}
                >
                  {answers.get(q)?.trim() ? '☑' : '?'} {q}
                </button>
                {openQuestion === q && (
                  <input
                    class="input input-small prompt-question-input"
                    value={answers.get(q) ?? ''}
                    placeholder="answer…"
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    onInput={(e) => {
                      const v = e.currentTarget.value
                      setAnswers((prev) => new Map(prev).set(q, v))
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setOpenQuestion(null) } }}
                  />
                )}
              </span>
            ))}
            <button
              class="prompt-hint-improve"
              title="Dismiss the suggestions — the draft goes as typed"
              onClick={() => { setSuggested(null); setOpenQuestion(null); textareaRef.current?.focus() }}
            >
              {Icon.x()}
            </button>
          </div>
        )}
        {!state.turnRunning && expandPreview !== null && (
          <div class="prompt-expand" aria-live="polite">
            {/* The expanded brief as a PREVIEW: accepting replaces the draft (it stays
                editable), dismissing sends the draft as typed. Never applied silently. */}
            <pre class="prompt-expand-text">{expandPreview}</pre>
            <div class="prompt-expand-actions">
              <button
                class="prompt-hint-improve"
                onClick={() => {
                  setInput(expandPreview)
                  // The accepted text is "already processed": no auto re-run until edited.
                  improvedFor.current = expandPreview
                  setExpandPreview(null)
                  // Belt to the braces in expand(): whatever chips exist described some
                  // OTHER draft, and gluing them under the brief would smuggle dead
                  // requirements into the send.
                  setSuggested(null)
                  setOpenQuestion(null)
                  textareaRef.current?.focus()
                }}
              >
                Accept — replace the draft
              </button>
              <button
                class="prompt-hint-improve"
                title="Dismiss — the draft goes as typed"
                onClick={() => { setExpandPreview(null); textareaRef.current?.focus() }}
              >
                {Icon.x()}
              </button>
            </div>
          </div>
        )}
        {!state.turnRunning && suggested === null && expandPreview === null &&
          (lintShaped(input) && lintPrompt(input).length > 0 || commandShaped(input) || improveNote !== null) && (
          <div class="prompt-hints" aria-live="polite">
            {lintShaped(input) && lintPrompt(input).map((hint) => <span key={hint} class="prompt-hint">{hint}</span>)}
            {improveNote !== null && <span class="prompt-hint">{improveNote}</span>}
            <button
              class="prompt-hint-improve"
              onClick={() => improveOrExpand()}
              disabled={improving}
              title={taskShaped(input)
                ? 'Suggest criteria and constraints for the draft (Ctrl+E)'
                : 'Expand into a detailed prompt grounded in this project (Ctrl+E)'}
            >
              {improving ? 'Thinking…' : taskShaped(input) ? 'Improve (Ctrl+E)' : 'Expand (Ctrl+E)'}
            </button>
          </div>
        )}
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

          {/* What happens AFTER a turn, on the row that says what happens during one.

              Here rather than buried in Settings because of how it failed: the owner turned
              the checks off, worked for a couple of hours, and then had no way anywhere in
              the window to find out whether they were still off. A setting whose state is
              invisible is a setting you stop trusting. The title lists what the three gates
              actually are — the second half of the same complaint was not knowing which
              checks existed at all. */}
          <button
            class={`mode-chip gate-chip ${gateMode === 'manual' ? 'gate-chip-off' : ''}`}
            title={gateMode === 'manual'
              ? 'Checks are OFF for this session. Nothing runs the build, audits the work '
                + 'against what you asked for, or reviews the diff until you ask: /check runs '
                + 'the build and tests, /review runs the independent read. Click to turn them '
                + 'back on.'
              : 'After a turn that changed code: the build and tests run, the work is audited '
                + 'against what you asked for, and a reader with a fresh context goes over the '
                + 'diff. Click to turn all three off and run them by hand with /check and '
                + '/review.'}
            disabled={!state.session}
            onClick={() => setGateMode(gateMode === 'manual' ? 'auto' : 'manual')}
          >
            {gateMode === 'manual' ? 'Checks off' : 'Checks on'}
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
    </div>
  )
}
