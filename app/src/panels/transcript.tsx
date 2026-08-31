import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { memo } from 'preact/compat'
import type { ComponentChildren, VNode } from 'preact'
import type { StoppedBecause } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { pendingTool, type ChatAction, type ChatItem, type ChatState } from '../lib/state'
import { Markdown } from '../lib/markdown'
import { DiffStatBadge, DiffView, diffStat } from '../lib/diff'
import { presentTool, screenshotPathOf, type ToolKind } from '../lib/tools'
import { formatDuration, formatProgress } from '../lib/format'
import { useStickToBottom } from '../lib/sticky-scroll'
import { Icon } from '../components/icons'
import { CopyButton } from '../components/copy'
import { ApprovalCard, QuestionCard, TodosCard } from './approvals'
import { DecisionsCard } from './decisions'
import { RunBanner } from './run-banner'

/**
 * How many of the newest rows are mounted before the rest are put behind a click.
 *
 * Chosen against the measurement rather than by feel: rendering cost is invisible below
 * about 5,000 items and clearly visible by 10,000. Four hundred sits far under that with
 * room to spare, and is more conversation than anyone scrolls back through while a turn is
 * running — a few hundred rows is what this window handled comfortably for its whole life,
 * before one turn could produce tens of thousands.
 */
export const VISIBLE_TAIL = 400

/**
 * Which rows to mount, and how many are being held back.
 *
 * Exported and pure so the rule can be tested without a DOM: this window has no render
 * harness, and the decision worth holding is arithmetic, not markup. `hidden` is what the
 * bar above the transcript reports, and it is the count of items NOT rendered — never a
 * guess, never "about".
 */
export function visibleWindow<T>(
  items: readonly T[], showAll: boolean, frozenStart?: number,
): { shown: readonly T[]; hidden: number } {
  const natural = showAll ? 0 : Math.max(0, items.length - VISIBLE_TAIL)
  // While the reader is scrolled UP, the window's start is FROZEN where it was when they
  // unpinned: advancing it live meant every streamed item deleted a row from under them —
  // the view held until the row being read was evicted, then jumped, repeatedly, in
  // exactly the >400-item sessions the cap exists for. The window grows downward during
  // the read and snaps back to the sliding tail on re-pin.
  const hidden = frozenStart !== undefined ? Math.min(natural, frozenStart) : natural
  return { shown: hidden === 0 ? items : items.slice(hidden), hidden }
}

/**
 * Where the conversation lands when the chat comes back from behind a file tab.
 *
 * Exported and pure for the same reason `visibleWindow` is: this window has no render
 * harness, and the decision worth holding is the rule, not the assignment.
 *
 * The two answers are genuinely different. A reader who had scrolled UP wants the offset they
 * left, to the pixel — that is the paragraph they were in the middle of. A reader who was
 * pinned to the bottom wants the bottom AS IT IS NOW: the turn keeps streaming while a file
 * tab is fronted, and every re-pin the sticky-scroll hook attempted meanwhile was discarded
 * by a container with no layout box, so the offset it left is hundreds of rows short.
 */
export function chatReturnScrollTop(
  { parked, stuck, scrollHeight }: { parked: number; stuck: boolean; scrollHeight: number },
): number {
  return stuck ? scrollHeight : parked
}

/** The id of the newest item of a kind, without copying the array to find it. */
function lastIdOfKind(items: readonly ChatItem[], kind: ChatItem['kind']): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.kind === kind) return item.id
  }
  return 0
}

/**
 * The transcript: everything that has happened this session, in order, rendered as the
 * thing it actually is rather than as a line of text about it.
 *
 * Three rules this file exists to enforce, all of them fixes for what the previous version
 * got wrong:
 *
 * 1. **Reasoning is visible.** A `thinking` item renders its full text, always expanded
 *    (the user's explicit choice), with a live cursor while it streams. It is collapsible
 *    per-block for when a long chain of thought gets in the way of re-reading the answer.
 * 2. **Nothing animates that isn't happening.** Every live affordance is driven by
 *    `item.done` / `item.result === undefined`, both of which the reducer now closes on
 *    every path a step can end. There is no "animate until something else replaces me".
 * 3. **A change shows as a change.** `edit_file`/`write_file` render an inline coloured
 *    diff at the point in the conversation where the model made it — not as a summary line
 *    pointing at a panel somewhere else.
 *
 * **Rows are memoised, and that is load-bearing, not a micro-optimisation.** A streamed
 * token replaces one item and produces a new `items` array, so without `memo` every row in
 * the transcript re-rendered on every token: every diff re-parsed into a VNode per line,
 * every fenced block re-highlighted, every answer re-lexed by marked. On a long session
 * that is hundreds of megabytes of garbage per second, and it crashed the WebView renderer
 * with "Out of Memory" during real use. The reducer replaces item objects instead of
 * mutating them, so a reference comparison is exactly right: only the item that actually
 * changed re-renders.
 *
 * For the same reason nothing here passes a ticking clock down to every row. A live
 * reasoning block owns its own timer; a finished one has nothing to animate.
 */

export function Transcript({
  client, state, dispatch, onOpenFile, onBackToLive, offscreen = false,
}: {
  client: ProtocolClient
  state: ChatState
  dispatch: (action: ChatAction) => void
  onOpenFile: (path: string) => void
  /** Stop reading an earlier session and go back to the one that works. */
  onBackToLive: () => void
  /** The chat face is hidden behind a file tab. Not unmounted — `display: none`. */
  offscreen?: boolean
}): VNode {
  const scrollRef = useRef<HTMLDivElement>(null)

  const lastItem = state.items[state.items.length - 1]
  // No signal to compute: the hook watches the container itself, which is the only thing
  // that knows about a tool result arriving, a card being expanded, or "show more lines".
  const { stuck, scrollToBottom } = useStickToBottom(scrollRef)

  // Carry the scroll offset across being hidden behind a file tab.
  //
  // `.chat-face-hidden` is `display: none`, and an element with no layout box has no scroll
  // offset: the browser discards it and hands back 0 when the box returns. Nothing here
  // noticed — the sticky-scroll hook's MutationObserver only watches mutations INSIDE this
  // container, and hiding the face mutates an ancestor's class — so opening a file tab to
  // read a diff and pressing Esc landed at the very TOP of the conversation, with `stuck`
  // still true, i.e. without even the jump-to-latest button to get back.
  //
  // The offset is recorded from scroll events rather than read when `offscreen` flips,
  // because by the time any effect runs the class is already committed and `scrollTop` reads
  // 0. Every change to a scroll offset fires a scroll event, programmatic ones included, so
  // this ref always holds the last offset the container genuinely had.
  const parkedScroll = useRef(0)
  const offscreenRef = useRef(offscreen)
  offscreenRef.current = offscreen
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    function onScroll(): void {
      const node = scrollRef.current
      if (node !== null && !offscreenRef.current) parkedScroll.current = node.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (offscreen || el === null) return
    el.scrollTop = chatReturnScrollTop({
      parked: parkedScroll.current, stuck, scrollHeight: el.scrollHeight,
    })
    // Only the transition matters: `stuck` is read at the moment the face comes back, and
    // re-running this whenever it flips would fight the sticky-scroll hook for the offset.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the hide/show flip
  }, [offscreen])

  // Sending always returns you to the bottom. If you were reading back through the
  // transcript and then typed, you want to watch the answer, not stay where you were.
  //
  // A backwards loop rather than `[...items].reverse().find(...)`: this runs on every render,
  // and while a step streams that is once per animation frame. Copying the whole array sixty
  // times a second to look at its end is a cost with nothing to show for it.
  const lastUserId = lastIdOfKind(state.items, 'user')
  useEffect(() => {
    if (lastUserId !== 0) scrollToBottom()
  }, [lastUserId, scrollToBottom])

  const waiting = state.turnRunning && isQuiet(lastItem) &&
    !state.pendingApproval && !state.pendingQuestion

  // While an approval is open, the call it is asking about is already announced -- in more
  // detail, with the diff or the command text -- by the card itself. Rendering the bare
  // pending stub above it says the same thing twice. It comes back the moment the decision
  // is made, carrying the outcome.
  //
  // Only while the LIVE conversation is the one on screen. The id it computes comes from
  // `state.items`, and a viewed session's items are numbered by their own counter starting
  // from 1 — so the two id spaces overlap, and a pending approval on live item 37 blanked
  // the 37th row of whatever stored session was being read: a hole in the middle of someone
  // else's conversation, with no bar, no note and nothing to explain it.
  // The call the dialog is about is the one EXECUTING — the oldest still unanswered — not
  // the last item. A step running three edits has cards for all three the moment their
  // arguments finish streaming, so the last of them is the one written most recently. Using
  // it blanked an unrelated row (a hole in the transcript) while leaving the approved call's
  // stub duplicated under the card. `pendingTool` is the same rule the reducer routes a
  // result with, and it skips cards still being written, which can never be the subject.
  const suppressedId = state.viewing === null && state.pendingApproval !== null
    ? pendingTool(state.items)?.id ?? null
    : null

  // Reading an earlier session shows ITS conversation; the live one keeps accumulating into
  // `state.items` behind this view, so going back shows everything that happened meanwhile.
  const viewing = state.viewing
  const all = viewing === null ? state.items : viewing.items

  // Only the tail is mounted, unless you ask for the rest.
  //
  // A turn used to be capped at forty steps, so a conversation reached a few hundred rows
  // and stopped. With no ceiling, one turn can produce tens of thousands, and every one of
  // them stayed in the DOM forever — with diffs and command output expanded by default, up
  // to a hundred and sixty lines each. Measured on this app's own preact: 9.4 ms of VNode
  // diffing per frame at 25,000 items, which is over half a frame budget on its own, and
  // that is the SMALL half. The DOM those rows build, and the layout the sticky-scroll hook
  // forces on every frame, is what actually makes the window stop responding.
  //
  // A cap fixes all three at once — nodes, VNodes and diff work — and it restores the cost
  // profile a several-hundred-row conversation always had, whatever the turn length. The
  // rest is one click away and nothing is discarded: `state.items` is untouched, and the
  // session file is the real record either way.
  // Reset whenever the conversation being shown CHANGES. One click used to disable the cap
  // for the rest of the app run — across a session switch, and across looking at a stored
  // session and coming back — so a decision made about a forty-row conversation silently
  // governed a twenty-thousand-row one.
  const [showAll, setShowAll] = useState(false)
  const shownSessionId = viewing === null ? (state.session?.sessionId ?? '') : viewing.sessionId
  const frozenStartRef = useRef<number | undefined>(undefined)
  useEffect(() => { setShowAll(false); frozenStartRef.current = undefined }, [shownSessionId])
  // Pinned to the bottom → the window slides as it always did. Scrolled up → freeze the
  // start where the reader left the bottom, so nothing is evicted from under them.
  if (stuck) frozenStartRef.current = undefined
  else frozenStartRef.current ??= showAll ? 0 : Math.max(0, all.length - VISIBLE_TAIL)
  const { shown, hidden } = visibleWindow(all, showAll, frozenStartRef.current)

  return (
    <div class="transcript-wrap">
      {viewing !== null && (
        <div class="viewing-bar">
          <span class="viewing-icon" aria-hidden="true">{Icon.chat()}</span>
          <span class="viewing-text">
            Reading <b>{viewing.title || '(untitled)'}</b>. The active session is still
            {state.turnRunning ? ' working' : ' where your messages go'} — write below to
            continue this one instead.
          </span>
          <button class="btn btn-small" onClick={onBackToLive}>Back to the active session</button>
        </div>
      )}

      {viewing === null && (
        <TodosCard
          todos={state.todos}
          onClear={() => { void client.call('todos.clear', {}).catch(() => { /* already gone */ }) }}
          onOpenFile={onOpenFile}
        />
      )}

      <div class="transcript" ref={scrollRef}>
        {hidden > 0 && (
          <div class="earlier-bar">
            <span class="earlier-text">
              {hidden} earlier {hidden === 1 ? 'message is' : 'messages are'} not shown, to keep
              a long conversation responsive. Nothing was lost.
            </span>
            <button class="btn btn-small" onClick={() => setShowAll(true)}>Show everything</button>
          </div>
        )}

        {shown.length === 0 && !state.turnRunning
          ? <EmptyState />
          : shown.map((item) => (
            item.id === suppressedId
              ? null
              : <TranscriptRow key={item.id} item={item} onOpenFile={onOpenFile} client={client} />
          ))}

        {waiting && (
          <div class="row row-waiting">
            <div class="row-gutter" aria-hidden="true"><span class="pulse-dot" /></div>
            {/* No measurement here, deliberately, though this row is exactly when one is
                available: the composer's status line carries every other live reading (the
                step number, the elapsed time, the timeout countdown) and is on screen at the
                same moment. Watched live, the two rendered the identical
                "reading 4.9k / 4.9k · none cached" one above the other for the whole of a
                prefill. This row's job is that something is happening HERE, in the
                conversation; the number belongs where the other numbers are. */}
            <div class="row-body">
              working{state.currentStep ? ` · step ${state.currentStep.step}` : ''}
            </div>
          </div>
        )}

        {/* Wrapped in a Row like everything else: a card that ignored the gutter sat 28px
            left of the whole conversation, which is exactly the sort of thing that makes a
            UI look assembled rather than designed. */}
        {/* The run, above everything else that can appear here: while it is active it is
            the reason the other cards exist, and after it ends its reason-for-stopping is
            the first thing wanted. */}
        {/* Live-session state only, same rule as the TodosCard gate: rendered inside a
            VIEWED transcript it read as THAT session having run unattended, live clock,
            Stop button and all. */}
        {state.viewing === null && (state.run !== null || state.lastRun !== null) && (
          <Row kind="card-row" marker={Icon.play()}>
            <RunBanner client={client} state={state} dispatch={dispatch} />
          </Row>
        )}

        {/* Above the live approval, because a parked question is older: it has been
            waiting since the night and the thing in front of you can be answered in a
            second. */}
        {state.pendingDecisions > 0 && (
          <Row kind="card-row" marker={Icon.chat()}>
            <DecisionsCard
              client={client}
              pending={state.pendingDecisions}
              onChanged={() => dispatch({ type: 'decisions.changed', pending: state.pendingDecisions - 1 })}
            />
          </Row>
        )}
        {state.pendingApproval && (
          <Row kind="card-row" marker={Icon.shield()}>
            <ApprovalCard
              client={client}
              approval={state.pendingApproval}
              onAnswered={(decision) => dispatch({ type: 'approval.answered', decision })}
            />
          </Row>
        )}
        {state.pendingQuestion && (
          <Row kind="card-row" marker={Icon.chat()}>
            <QuestionCard
              client={client}
              question={state.pendingQuestion}
              onAnswered={(answer) => dispatch({ type: 'question.answered', answer })}
            />
          </Row>
        )}
      </div>

      {!stuck && (
        <button class="jump-latest" onClick={scrollToBottom}>
          {Icon.arrowDown()} latest
        </button>
      )}
    </div>
  )
}

/**
 * What a compaction actually did, at the point it did it.
 *
 * The numbers first, because "did it help" is the immediate question and a compaction that
 * frees 14% is one this project shipped for a while. The briefing folds open: it is what the
 * model works from now, so it is the honest answer to "what does it still know".
 */
function CompactionRecord({ item }: { item: Extract<ChatItem, { kind: 'compaction-record' }> }): VNode {
  const [open, setOpen] = useState(false)

  if (item.state === 'running') {
    // A compaction re-reads the entire conversation before it writes a word, so the first
    // stretch of this row is pure prefill and the sentence below was, for minutes, the only
    // thing distinguishing it from a hang. The measured line says which half it is in.
    const measured = item.progress !== undefined ? formatProgress(item.progress) : null
    return (
      <Row kind="record record-compaction" marker={<span class="pulse-dot" />}>
        <span class="record-text">
          compacting the conversation — summarising what happened so far so it fits in the
          context window. This takes a few minutes on a full one.
          {measured !== null && <span class="record-quiet"> · {measured}</span>}
        </span>
      </Row>
    )
  }

  // The state that used to be invisible, and looked exactly like a hang because of it.
  // The summary is written; the swap into the transcript happens at the START of the next
  // turn (session.ts applies it inside send()), so there is genuinely nothing to wait for
  // and nothing to do — which is only obvious if the row says it.
  if (item.state === 'ready') {
    return (
      <Row kind="record record-compaction" marker={Icon.check()}>
        <span class="record-text">
          summary ready — it replaces the earlier conversation when you send your next
          message. Nothing to wait for.
        </span>
      </Row>
    )
  }

  // The two outcomes that change nothing used to print nothing at all, so a `/compact` that
  // could not help looked exactly like a `/compact` that was ignored.
  if (item.state === 'skipped') {
    // Two different answers, and reading them as one is why "nothing happened" sounded like
    // a fault: a short conversation has nothing a briefing could usefully replace.
    return (
      <Row kind="record record-compaction" marker={Icon.check()}>
        <span class="record-text">
          {item.reason === 'nothing-to-gain'
            ? 'nothing to compact yet — this conversation is still shorter than the ' +
              'briefing that would replace it. Nothing was changed, and nothing needed to be.'
            : 'compaction made no difference — the summary would not have been meaningfully ' +
              'smaller than the conversation, so nothing was changed.'}
        </span>
      </Row>
    )
  }
  if (item.state === 'failed') {
    return (
      <Row kind="record record-deny" marker={Icon.alert()}>
        <span class="record-text">
          compaction failed, and nothing was changed. The conversation is exactly as it was.
        </span>
      </Row>
    )
  }

  // Every number here is optional, and a missing one is NOT zero. A restored compaction has
  // only its briefing and the count from the on-disk marker -- the before/after sizes were
  // measurements of a moment that has passed and were never written down. Defaulting them to
  // zero is what printed "0 → 0 (0% freed)" over a real 214-message compaction, so each
  // clause now appears only when there is something true to put in it.
  const { beforeTokens: before, afterTokens: after, droppedMessages: dropped } = item
  const sizes = before !== undefined && after !== undefined && before > 0
    ? <> — <b>{tokens(before)} → {tokens(after)}</b> ({Math.round((1 - after / before) * 100)}% freed)</>
    : null
  return (
    <Row kind="record record-compaction" marker={Icon.check()}>
      <button class="compaction-head" onClick={() => setOpen((o) => !o)}>
        <span class="record-text">
          compacted{sizes}
          {dropped !== undefined && (
            <>{sizes ? ',' : ' —'} {dropped} message{dropped === 1 ? '' : 's'} replaced by a briefing</>
          )}
          {item.keptMessages !== undefined && <>, {item.keptMessages} kept as they were</>}
        </span>
        <span class="compaction-toggle">{open ? 'hide the briefing' : 'what it kept'}</span>
      </button>
      {open && (
        <div class="compaction-body">
          <div class="compaction-note">
            From here on the model reads this briefing instead of the conversation it replaced.
          </div>
          <pre class="compaction-summary">{item.summary ?? '(the briefing was not recorded)'}</pre>
        </div>
      )}
    </Row>
  )
}

/** `8.3k`, the same shape the status bar uses. */
function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** True when nothing on screen is currently moving on its own -- which is when a plain
 * "working…" line is the honest thing to show, and only then. */
function isQuiet(last: ChatItem | undefined): boolean {
  if (!last) return true
  if (last.kind === 'thinking') return last.done
  if (last.kind === 'tool') return last.result !== undefined
  return last.kind !== 'assistant'
}

function EmptyState(): VNode {
  return (
    <div class="empty-state">
      <div class="empty-mark" aria-hidden="true">{Icon.shield()}</div>
      <h2>Ask for a change, a review, or an explanation.</h2>
      <p>Everything stays on this machine. The agent reads and edits only this workspace.</p>
      <div class="empty-keys">
        <span><kbd>Enter</kbd> send</span>
        <span><kbd>Shift</kbd>+<kbd>Enter</kbd> newline</span>
        <span><kbd>Esc</kbd> stop</span>
        {/* The palette is the main way around the app and was mentioned nowhere at all:
            implemented, bound, and undiscoverable except by habit from other tools. */}
        <span><kbd>Ctrl</kbd>+<kbd>K</kbd> everything else</span>
        <span><kbd>@</kbd> attach a file</span>
      </div>
    </div>
  )
}

/**
 * Every row has the same shape: a narrow marker gutter and a content column.
 *
 * That gutter is what turns a pile of differently-shaped cards into a single readable
 * column. Everything lines up on one text edge, and the left rail carries the status —
 * who spoke, whether a call succeeded — so the content itself does not have to repeat it.
 */
function Row({
  kind, marker, children,
}: {
  kind: string
  marker?: VNode | null
  children: ComponentChildren
}): VNode {
  return (
    <div class={`row row-${kind}`}>
      <div class="row-gutter" aria-hidden="true">{marker}</div>
      <div class="row-body">{children}</div>
    </div>
  )
}

/** See the file header: the reference comparison on `item` is what keeps a streamed token
 * from re-rendering (and re-parsing) the entire transcript. `onOpenFile` is stable — it is
 * created once in `App.tsx` — so the default shallow comparison is enough. */
const TranscriptRow = memo(function TranscriptRow({
  item, onOpenFile, client,
}: {
  item: ChatItem
  onOpenFile: (path: string) => void
  /** Stable for the app's lifetime, like `onOpenFile` -- so `memo` below still holds. */
  client: ProtocolClient
}): VNode {
  switch (item.kind) {
    case 'user':
      // Not a right-aligned bubble: a long instruction is the most important thing on the
      // screen and should get the full reading width, marked as input rather than boxed
      // off in a corner the way a messaging app would.
      // A harness note wears the same role and none of the emphasis. It is here because the
      // model read it as an instruction and the transcript should show what the model saw;
      // it is not one of the person's messages, and marking it as one is what made a
      // resumed session look like it had twice as many.
      return (
        <Row
          kind={item.harness === true ? 'user user-note' : 'user'}
          marker={<span class="marker-caret">{item.harness === true ? '·' : '›'}</span>}
        >
          <div class="user-text">{item.text}</div>
        </Row>
      )

    case 'assistant':
      // lib/markdown.tsx tokenises with marked and maps every token to JSX itself -- there
      // is no HTML sink anywhere in that path, so model output gained formatting, never
      // markup execution.
      return (
        <Row kind="assistant">
          <div class="copy-holder">
            <Markdown text={item.text} />
            <CopyButton text={item.text} />
          </div>
          {item.interrupted && <div class="interrupted">stopped by you</div>}
        </Row>
      )

    case 'thinking':
      return <ReasoningBlock item={item} />

    case 'tool':
      return <ToolCard item={item} onOpenFile={onOpenFile} client={client} />

    case 'error':
      return (
        <Row
          kind={item.tone === 'info' ? 'note' : 'error'}
          marker={item.tone === 'info' ? Icon.check() : Icon.alert()}
        >
          <div class="notice-title">{item.message}</div>
        </Row>
      )

    case 'approval-record': {
      const allowed = item.decision.verdict === 'allow'
      const comment = item.decision.verdict === 'deny' ? item.decision.comment : undefined
      const remember = item.decision.verdict === 'allow' ? item.decision.remember : undefined
      return (
        <Row kind={`record record-${item.decision.verdict}`} marker={allowed ? Icon.check() : Icon.x()}>
          <span class="record-text">
            <b>{item.tool}</b> {allowed ? 'allowed' : 'denied'} — {item.summary}
            {remember && <em> · always: {remember.rule} ({remember.layer})</em>}
            {comment && <em> · “{comment}”</em>}
          </span>
        </Row>
      )
    }

    case 'question-record':
      return (
        <Row kind="record" marker={Icon.check()}>
          <span class="record-text">{item.question} — <b>{item.answer}</b></span>
        </Row>
      )

    // Shown on a pass as well as a failure: a check that silently added thirty seconds to
    // every writing turn would read as the app having hung.
    case 'verify-record':
      return (
        <Row
          kind={`record record-${item.ok ? 'allow' : 'deny'}`}
          marker={item.ok ? Icon.check() : Icon.alert()}
        >
          <span class="record-text">
            verified with <b>{item.command}</b>
            {item.folder !== undefined ? <> in <b>{item.folder}</b></> : null} — {item.detail}
          </span>
        </Row>
      )

    // A diagnosis somebody asked for. Rendered whole and unwrapped: it is the text that
    // gets forwarded, and a version the window reflowed would not be the thing that was
    // saved. `pre` rather than markdown for the same reason — the report's columns line up
    // and a renderer that collapsed the whitespace would take the table apart.
    case 'diagnosis':
      return (
        <Row kind="record" marker={Icon.check()}>
          <div class="record-text">
            <pre class="diagnosis-report">{item.report}</pre>
            {item.savedTo === null
              ? <div class="row-note">The report could not be written to a file — copy it from here.</div>
              : <div class="row-note">Saved to <b>{item.savedTo}</b> — that file is the whole report, and it contains nothing that is not above.</div>}
          </div>
        </Row>
      )

    // Where the conversation the model can see was replaced by a briefing about it. Shown
    // in place, because "what does it still know" is only answerable relative to a point in
    // the conversation.
    case 'compaction-record':
      return <CompactionRecord item={item} />

    case 'stopped': {
      const explain = STOP_REASONS[item.reason]
      return (
        <Row kind="stopped" marker={Icon.stop()}>
          <div class="notice-title">{explain.title}</div>
          <div class="notice-detail">{explain.detail}</div>
        </Row>
      )
    }
  }
})

/**
 * Why a turn ended, in the user's terms, with what to do about it.
 *
 * This exists because the app used to show nothing at all here: a turn that hit the
 * 40-step ceiling, timed out, or ran out of room simply went quiet, and the only way to
 * find out was to ask the model — which costs another turn and can only guess, since the
 * loop stops it from the outside.
 */
const STOP_REASONS: Record<Exclude<StoppedBecause, 'done'>, { title: string; detail: string }> = {
  max_steps: {
    title: 'Stopped at the step limit for one turn.',
    detail: 'It was still working, not finished. Send “continue” and it picks up where it left off.',
  },
  timeout: {
    title: 'Stopped — a step took longer than its time limit.',
    detail: 'Usually a very large file or a command that hung. Everything before this is kept.',
  },
  truncated: {
    title: 'Stopped — the model ran out of room to finish, twice in a row.',
    detail: 'The conversation is probably too long; start a new session, or ask it to summarise first.',
  },
  aborted: {
    title: 'Stopped by you.',
    detail: 'Whatever had already arrived is kept, and the next message continues from here.',
  },
}

// ---------------------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------------------

/** ~4 characters per token is the usual rough rule and is only ever shown as `~N`. */
function estimateTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 4))
}

function ReasoningBlock({ item }: { item: ChatItem & { kind: 'thinking' } }): VNode {
  // Always expanded by default -- the user asked to see the reasoning, not to click for it.
  const [open, setOpen] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const bodyRef = useRef<HTMLDivElement>(null)

  // The timer lives HERE, not in the transcript: a clock passed down as a prop ticks every
  // row and defeats the memoisation the file header explains. Only a block that is still
  // being written has anything to count.
  useEffect(() => {
    if (item.done) return
    const id = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [item.done])

  // The body is its own 440px scroller, and nothing else ever scrolls it — the sticky
  // follower pins the OUTER transcript only. Past ~21 lines a live stream continued below
  // this box's fold: text and caret frozen mid-sentence while the token counter climbed,
  // which reads exactly like a hang. While streaming, the box follows its own bottom;
  // once done it stays wherever the reader put it.
  useEffect(() => {
    if (item.done) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [item.text, item.done])

  const elapsed = item.done
    ? (item.endedAtMs !== null ? item.endedAtMs - item.startedAtMs : null)
    : now - item.startedAtMs

  return (
    <Row
      kind={`reasoning ${item.done ? 'reasoning-done' : 'reasoning-live'}`}
      marker={<span class="marker-brain">{Icon.brain()}</span>}
    >
      <button class="reasoning-head" onClick={() => setOpen((o) => !o)}>
        <span class="reasoning-label">{item.done ? 'Reasoned' : 'Reasoning'}</span>
        {elapsed !== null && elapsed >= 0 && (
          <span class="reasoning-meta">{formatDuration(elapsed)}</span>
        )}
        <span class="reasoning-meta">~{estimateTokens(item.text.length)} tok</span>
        <span class="reasoning-chevron">{open ? Icon.chevronDown() : Icon.chevronRight()}</span>
      </button>
      {open && (
        <div class="reasoning-body" ref={bodyRef}>
          {item.text}
          {!item.done && <span class="caret" aria-hidden="true" />}
        </div>
      )}
    </Row>
  )
}

// ---------------------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------------------

const KIND_ICON: Record<ToolKind, () => VNode> = {
  diff: Icon.diff,
  fileop: Icon.file,
  read: Icon.search,
  command: Icon.terminal,
  meta: Icon.chat,
  other: Icon.chat,
}

/** Whether a completed call's body is worth showing without asking. A diff and a command
 * are the point of their card; a 400-line directory listing is not. */
function defaultOpen(kind: ToolKind, ok: boolean): boolean {
  if (!ok) return true
  return kind === 'diff' || kind === 'command'
}

/** Lines shown before the "show the rest" control appears. Generous: the point of this
 * block is that the whole log is readable, and an inner scrollbar inside a scrolling
 * transcript is the worst of both. */
const OUTPUT_HEAD_LINES = 160

/**
 * Command output, in full.
 *
 * Text is never ellipsised or hidden behind an inner scroller here -- a build log you can
 * only see the first 24 lines of is not evidence of anything. Very long output is cut at a
 * line count with an explicit control that says how much is left, so the default is bounded
 * but nothing is silently lost.
 */
function OutputBlock({ text }: { text: string }): VNode {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const lines = text.split('\n')
  const overflows = lines.length > OUTPUT_HEAD_LINES
  const shown = overflows && !expanded ? lines.slice(0, OUTPUT_HEAD_LINES).join('\n') : text

  function copy(): void {
    void navigator.clipboard?.writeText(text).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1200) },
      () => { /* still selectable */ },
    )
  }

  return (
    <div class="cmd-output-wrap">
      <button class="cmd-copy" onClick={copy} title="Copy the whole output">
        {copied ? 'copied' : 'copy'}
      </button>
      <pre class="cmd-output">{shown}</pre>
      {overflows && (
        <button class="cmd-more" onClick={() => setExpanded((e) => !e)}>
          {expanded
            ? 'show less'
            : `show ${(lines.length - OUTPUT_HEAD_LINES).toLocaleString()} more lines`}
        </button>
      )}
    </div>
  )
}

/**
 * A screenshot, fetched through the same jailed `fs.read` the file preview uses.
 *
 * Loaded on demand rather than carried in the tool result: a base64 PNG is a few hundred
 * kilobytes, and putting it in the reducer's state would keep every screenshot of a long
 * session resident in memory forever, re-rendered on every keystroke in the composer.
 */
function Screenshot({ path, client }: { path: string; client: ProtocolClient }): VNode {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ok'; url: string } | { kind: 'error'; why: string }>(
    { kind: 'loading' },
  )

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    client.call('fs.read', { path })
      .then((r) => {
        if (cancelled) return
        const url = (r as { image?: { dataUrl: string } }).image?.dataUrl
        setState(url ? { kind: 'ok', url } : { kind: 'error', why: 'not an image' })
      })
      .catch((e: Error) => { if (!cancelled) setState({ kind: 'error', why: e.message }) })
    return () => { cancelled = true }
  }, [client, path])

  if (state.kind === 'loading') return <div class="tool-preview loading-quiet">loading {path}…</div>
  if (state.kind === 'error') return <div class="tool-preview">could not show {path}: {state.why}</div>
  return (
    <figure class="shot">
      <img src={state.url} alt={`Browser screenshot, ${path}`} />
      <figcaption>{path} — the model cannot see this; you can</figcaption>
    </figure>
  )
}

/**
 * The target of a call whose arguments are still half-written.
 *
 * `JSON.parse` is not available here — the document is incomplete by definition — so this
 * reads the first complete string value of the first key that names a target. A path is
 * short and is written early, so in practice it is on screen within the first fragments,
 * long before the file contents that follow it. Returns null until the closing quote
 * arrives; a half-written path is worse than none, since it reads as a different file.
 */
const TARGET_KEYS = ['path', 'file', 'pattern', 'command', 'query', 'url'] as const

function targetInPartialArgs(args: string): string | null {
  for (const key of TARGET_KEYS) {
    // The value ends at the first unescaped quote; `(?:[^"\\]|\\.)*` is what makes an
    // escaped quote inside a Windows path or a regex not end it early.
    const found = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(args)
    if (found?.[1] !== undefined && found[1] !== '') {
      try {
        return JSON.parse(`"${found[1]}"`) as string
      } catch {
        return found[1]
      }
    }
  }
  return null
}

function WritingCall({ item }: { item: ChatItem & { kind: 'tool' } }): VNode {
  const target = targetInPartialArgs(item.args)
  return (
    <Row kind="tool tool-pending" marker={<span class="pulse-dot" />}>
      <div class="tool-card">
        <div class="tool-head tool-head-writing">
          <span class="tool-verb">{item.name}</span>
          {target !== null ? <span class="tool-target">{target}</span> : <span class="tool-spacer" />}
          <span class="tool-writing-note">
            writing{item.args.length > 0 && <> · {formatBytes(item.args.length)}</>}
          </span>
        </div>
      </div>
    </Row>
  )
}

/** Characters, in the same shape the rest of the window uses for sizes. */
function formatBytes(n: number): string {
  return n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(1)}k chars`
}

/**
 * A terminal viewport for a command still running: auto-follows the tail unless the user
 * scrolled up to read something, in which case their position is theirs until they return
 * to the bottom — the same contract every terminal emulator honours.
 */
function LiveOutput({ text }: { text: string }): VNode {
  const ref = useRef<HTMLPreElement>(null)
  const stickRef = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el !== null && stickRef.current) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <pre
      class="tool-live"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {text}
    </pre>
  )
}

function ToolCard({
  item, onOpenFile, client,
}: {
  item: ChatItem & { kind: 'tool' }
  onOpenFile: (path: string) => void
  client: ProtocolClient
}): VNode {
  // A call still being generated has no arguments to present -- `args` is half a JSON
  // document. It gets its own row, which is the whole point: this is the longest silence in
  // a normal turn, and it used to show nothing at all.
  if (item.writing === true) return <WritingCall item={item} />

  const p = presentTool(item.name, item.args)
  const result = item.result
  const pending = result === undefined
  const content = result?.content ?? ''
  const [open, setOpen] = useState<boolean | null>(null)
  const isOpen = open ?? (result ? defaultOpen(p.kind, result.ok) : false)
  const stat = p.kind === 'diff' && result?.ok ? diffStat(content) : null
  const isCommand = p.kind === 'command'
  // The tool clipped what it handed the model. Being able to see EXACTLY that is not a
  // curiosity: when the agent then behaves as if it never saw something, this is the only
  // place that answers whether it actually did.
  const clipped = result !== undefined && result.display !== result.content
  const [showModelCopy, setShowModelCopy] = useState(false)
  const shownText = result === undefined ? '' : showModelCopy ? result.content : result.display
  // A screenshot's only audience is the person reading this: the model has no vision tower,
  // so the tool hands it a path and says so. Rendering the image here is what makes taking
  // one worth anything at all.
  const shotPath = result?.ok === true ? screenshotPathOf(item.name, result.display) : null

  // The success/failure glyph lives in the shared gutter, not inside the card: that is the
  // whole point of the gutter, and it buys the header the room to show the actual target.
  return (
    <Row
      kind={`tool tool-${pending ? 'pending' : result.ok ? 'ok' : 'fail'}`
        + (item.agent !== undefined ? ' tool-delegated' : '')}
      marker={pending
        ? <span class="pulse-dot" />
        : result.ok ? Icon.check() : Icon.x()}
    >
      <div class="tool-card">
        <button
          class="tool-head"
          onClick={() => { if (!pending) setOpen(!isOpen) }}
          disabled={pending}
        >
          {/* Whose action this is. Absent for the main model, so the common case is
              unchanged and the badge means something when it appears: a worker reading
              eight files used to be indistinguishable from the model reading them itself. */}
          {item.agent !== undefined && (
            <span class="tool-agent" title={`Done by the ${item.agent} worker, not the main model`}>
              {item.agent}
            </span>
          )}
          <span class="tool-icon">{KIND_ICON[p.kind]()}</span>
          <span class="tool-verb">{p.verb}</span>
          {/* A command is NOT summarised in the header -- it goes in the body below, whole
              and wrapped. Squeezing a real shell line into one ellipsised row is how you
              end up unable to tell what was actually executed. */}
          {!isCommand && <span class="tool-target" title={p.target}>{p.target}</span>}
          {isCommand && <span class="tool-spacer" />}
          {stat && <DiffStatBadge stat={stat} />}
          {!pending && (
            <span class="tool-toggle">{isOpen ? Icon.chevronDown() : Icon.chevronRight()}</span>
          )}
        </button>

        {/* Opening the file is its own control rather than the whole header, so clicking
            the row to expand a diff can never navigate somewhere unexpected instead. */}
        {p.path !== null && (
          <button class="tool-open" onClick={() => onOpenFile(p.path as string)} title={`Open ${p.path}`}>
            {Icon.file()}
          </button>
        )}

        {/* The command itself is always visible, whole, wrapped -- even while it is still
            running, which is exactly when you most want to know what was launched. */}
        {isCommand && (
          <div class="cmd-line">
            <span class="cmd-prompt">$</span>
            <code class="cmd-text">{p.target}</code>
          </div>
        )}

        {/* The run, WHILE it runs: stdout/stderr as it arrives, pinned to the tail like a
            terminal. Before this, a two-minute build was a frozen card and "is it working
            or wedged" had no answer in the window. Replaced by the result on exit. */}
        {pending && item.live !== undefined && item.live !== '' && (
          <LiveOutput text={item.live} />
        )}

        {!pending && isOpen && (
          <div class="tool-body">
            {clipped && (
              <div class="copy-switch">
                <button
                  class={showModelCopy ? '' : 'copy-switch-active'}
                  onClick={() => setShowModelCopy(false)}
                  title="Everything the tool produced"
                >
                  Full
                </button>
                <button
                  class={showModelCopy ? 'copy-switch-active' : ''}
                  onClick={() => setShowModelCopy(true)}
                  title="Exactly what went into the model's context — the rest never reached it"
                >
                  What the model got
                </button>
              </div>
            )}
            {/* `!showModelCopy` is the point, not a detail: the switch exists to answer
                "what did the model actually see", and a screenshot is the one result it
                never saw. Rendering the image under "What the model got" would make the
                one affordance built for honesty the one that lies. */}
            {shotPath !== null && !showModelCopy
              ? <Screenshot path={shotPath} client={client} />
              : p.kind === 'diff' && result.ok
                ? <DiffView content={shownText} />
                : isCommand
                  ? <OutputBlock text={shownText} />
                  : <pre class="tool-output">{shownText}</pre>}
          </div>
        )}
        {/* A preview that merely repeats the target ("src/app.ts (32 lines)" under a header
            already reading "Read src/app.ts") is a second line that says nothing. */}
        {!pending && !isOpen && result.preview !== '' && !result.preview.includes(p.target) && (
          <div class="tool-preview">{result.preview}</div>
        )}
      </div>
    </Row>
  )
}
