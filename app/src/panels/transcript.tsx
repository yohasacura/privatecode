import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { memo } from 'preact/compat'
import type { ComponentChildren, VNode } from 'preact'
import type { StoppedBecause } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { pendingTool, type ChatAction, type ChatItem, type ChatState } from '../lib/state'
import { groupItems, summaryText, type TranscriptUnit } from '../lib/action-groups'
import {
  ArrowDown, Brain, ChevronDown, ChevronRight, ExternalLink, FileDiff, FileText, MessageSquare, PencilLine, Play,
  RotateCcw, Search, ShieldCheck, Terminal,
} from 'lucide-preact'
import { Button, IconButton } from '../ui/button'
import { Chip } from '../ui/chip'
import { StageStrip } from './stage-strip'
import { cn } from '../ui/cn'
import { Markdown } from '../lib/markdown'
import { DiffStatBadge, DiffView, diffStat } from '../lib/diff'
import { presentTool, screenshotPathOf, type ToolKind } from '../lib/tools'
import { formatDuration, formatProgress } from '../lib/format'
import { useStickToBottom } from '../lib/sticky-scroll'
import { Icon } from '../components/icons'
import { CopyButton, HOLDER, HOVER_ACTION } from '../components/copy'
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
 * 3. **A change shows as a change.** `Edit`/`Write` render an inline coloured
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
  // The last row of the live conversation is the one that may offer "Continue" or
  // "Resume", and the one still being written while the turn runs.
  const lastShownId = all.length > 0 ? all[all.length - 1]!.id : 0
  const tailOf = (item: ChatItem): RowTail => (
    viewing !== null || item.id !== lastShownId ? null : state.turnRunning ? 'streaming' : 'last')
  const checksOff = state.session?.gateMode === 'manual'

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
  /** Alt+click on a group header opens every group in the transcript; a new session resets it. */
  const [expandAll, setExpandAll] = useState(false)
  const shownSessionId = viewing === null ? (state.session?.sessionId ?? '') : viewing.sessionId
  const frozenStartRef = useRef<number | undefined>(undefined)
  useEffect(() => { setShowAll(false); setExpandAll(false); frozenStartRef.current = undefined }, [shownSessionId])
  // Pinned to the bottom → the window slides as it always did. Scrolled up → freeze the
  // start where the reader left the bottom, so nothing is evicted from under them.
  if (stuck) frozenStartRef.current = undefined
  else frozenStartRef.current ??= showAll ? 0 : Math.max(0, all.length - VISIBLE_TAIL)
  const { shown, hidden } = visibleWindow(all, showAll, frozenStartRef.current)

  return (
    <div class="transcript-wrap">
      {viewing !== null && (
        <div data-viewing="" class="flex shrink-0 items-center gap-2.5 border-b border-border bg-panel px-3.5 py-2 font-ui text-[12.5px] leading-[1.45] text-dim">
          <span class="inline-flex shrink-0 text-accent [&>svg]:size-4" aria-hidden="true"><MessageSquare /></span>
          <span class="min-w-0 flex-1">
            Reading <b class="font-semibold text-fg">{viewing.title || '(untitled)'}</b>. The active session is still
            {state.turnRunning ? ' working' : ' where your messages go'} — write below to
            continue this one instead.
          </span>
          <Button size="sm" onClick={onBackToLive}>Back to the active session</Button>
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
          <div data-earlier="" class="mx-auto mb-1.5 flex max-w-(--read) items-center gap-2.5 rounded-md border border-border bg-raised px-3 py-2 font-ui">
            <span class="min-w-0 flex-1 text-[11.5px] text-dim">
              {hidden} earlier {hidden === 1 ? 'message is' : 'messages are'} not shown, to keep
              a long conversation responsive. Nothing was lost.
            </span>
            <Button size="sm" onClick={() => setShowAll(true)}>Show everything</Button>
          </div>
        )}

        {shown.length === 0 && !state.turnRunning
          ? <EmptyState />
          : groupItems(shown.filter((item) => item.id !== suppressedId), state.turnRunning).map((unit) => (
            unit.kind === 'single'
              ? <TranscriptRow key={unit.item.id} item={unit.item} onOpenFile={onOpenFile} client={client} tail={tailOf(unit.item)} />
              : (
                <ActionGroup key={`g${unit.id}`} unit={unit} expandAll={expandAll} onExpandAll={() => setExpandAll(true)}>
                  {unit.items.map((item) => (
                    <TranscriptRow key={item.id} item={item} onOpenFile={onOpenFile} client={client} tail={tailOf(item)} />
                  ))}
                </ActionGroup>
                )
          ))}

        {/* The checks of this turn, under the answer (§5). Live session only: a viewed
            session's gates ran in its own time and are in its rows. */}
        {viewing === null && (state.stages.length > 0 || (checksOff && state.items.length > 0)) && (
          <Row kind="stages" marker={<ShieldCheck size={13} />}>
            <StageStrip stages={state.stages} checksOff={checksOff} />
          </Row>
        )}

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
        <Button
          size="sm"
          icon={<ArrowDown />}
          class="absolute bottom-3.5 left-1/2 -translate-x-1/2 rounded-full shadow-(--shadow-pop)"
          onClick={scrollToBottom}
          data-action="jump-latest"
        >
          latest
        </Button>
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
      <button
        type="button"
        aria-expanded={open}
        class="flex w-full cursor-pointer items-baseline gap-2.5 border-0 bg-transparent p-0 text-left font-ui text-[11.5px] text-faint"
        onClick={() => setOpen((o) => !o)}
      >
        <span class="record-text">
          compacted{sizes}
          {dropped !== undefined && (
            <>{sizes ? ',' : ' —'} {dropped} message{dropped === 1 ? '' : 's'} replaced by a briefing</>
          )}
          {item.keptMessages !== undefined && <>, {item.keptMessages} kept as they were</>}
        </span>
        <span class="shrink-0 whitespace-nowrap text-accent hover:underline">{open ? 'hide the briefing' : 'what it kept'}</span>
      </button>
      {open && (
        <div class="mt-2 border-l-2 border-border pl-2.5">
          <div class="mb-1.5 text-[11.5px] text-faint">
            From here on the model reads this briefing instead of the conversation it replaced.
          </div>
          <pre class="m-0 max-h-[420px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.5] text-dim">{item.summary ?? '(the briefing was not recorded)'}</pre>
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

/**
 * The model's work between two answers, as one row with a sentence and the calls beneath
 * it (docs/UI-REDESIGN-2026-09.md §5). Open while it runs and when something in it failed;
 * folded otherwise. A click toggles; Alt+click opens every group in the transcript.
 */
function ActionGroup({ unit, expandAll, onExpandAll, children }: {
  unit: Extract<TranscriptUnit, { kind: 'group' }>
  expandAll: boolean
  onExpandAll: () => void
  children: ComponentChildren
}): VNode {
  const { summary, live } = unit
  const failed = summary.failed > 0 || summary.checksFailed > 0
  const [choice, setChoice] = useState<boolean | null>(null)
  const open = choice ?? (live || failed || expandAll)
  const label = live ? (summary.latest ?? 'Working…') : summaryText(summary)
  return (
    <div class={cn('row row-group', live && 'row-group-live')} data-group={live ? 'live' : failed ? 'failed' : 'done'}>
      <div class="row-gutter" aria-hidden="true">
        {live
          ? <span class="pulse-dot" />
          : failed ? <span class="text-red">{Icon.alert()}</span> : <span class="text-green">{Icon.check()}</span>}
      </div>
      <div class="row-body">
        <button
          type="button"
          aria-expanded={open}
          onClick={(e) => { if (e.altKey) { onExpandAll(); setChoice(true) } else setChoice(!open) }}
          title={open ? 'Fold this work away' : 'Show each step (Alt+click: every group)'}
          class={cn(
            'flex w-full items-center gap-2 rounded-sm border-0 bg-transparent px-1 py-1 text-left font-ui text-[13px] cursor-pointer',
            'transition-colors duration-(--duration-fast) hover:bg-hover',
            'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
            live ? 'text-fg' : failed ? 'text-red' : 'text-dim',
          )}
        >
          <span class="inline-flex shrink-0 text-faint [&>svg]:size-3.5">{open ? <ChevronDown /> : <ChevronRight />}</span>
          <span class="min-w-0 flex-1 truncate">{label}</span>
          <span class="shrink-0 text-[11px] text-faint tabular-nums">{unit.items.length} {unit.items.length === 1 ? 'step' : 'steps'}</span>
        </button>
        {open && (
          <div class="mt-1 border-l border-border-soft pl-2 [&>.row]:mx-0 [&>.row]:mb-2 [&>.row]:max-w-none">
            {children}
          </div>
        )}
      </div>
    </div>
  )
}

/** Three things to try, as chips that fill the composer (the composer listens for `pc:compose`). */
const STARTERS = [
  'Explain how this project starts up and where the main pieces live',
  'Find where the settings are read and list every key that is used',
  'Add a test for the most important class in this project',
]

function EmptyState(): VNode {
  return (
    <div class="empty-state mx-auto mt-[12vh] max-w-(--read) text-center font-ui text-dim">
      <div class="mb-6 flex justify-center text-accent [&>svg]:size-[34px] [&>.icon]:size-[34px]" aria-hidden="true">{Icon.shield()}</div>
      <h2 class="m-0 mb-1.5 text-[17px] font-semibold tracking-[-0.01em] text-fg">Ask for a change, a review, or an explanation.</h2>
      <p class="m-0 text-[12.5px]">Everything stays on this machine. The agent reads and edits only this workspace.</p>
      <div class="mt-4 flex flex-wrap justify-center gap-1.5">
        {STARTERS.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('pc:compose', { detail: text }))}
            class="rounded-full border border-border bg-panel px-3 py-1 font-ui text-[12px] text-dim cursor-pointer transition-colors duration-(--duration-fast) hover:border-border-strong hover:text-fg"
          >
            {text}
          </button>
        ))}
      </div>
      <div class="mt-5 flex justify-center gap-4 text-[12px] text-faint">
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
/** Where a row stands in the live conversation: the last one, still being written, or neither. */
type RowTail = 'streaming' | 'last' | null

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
  item, onOpenFile, client, tail = null,
}: {
  item: ChatItem
  onOpenFile: (path: string) => void
  /** Stable for the app's lifetime, like `onOpenFile` -- so `memo` below still holds. */
  client: ProtocolClient
  /** Changes only for the last row and the one it replaces, so `memo` still holds. */
  tail?: RowTail
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
          {item.harness === true
            ? <div class="user-text">{item.text}</div>
            : (
              <div class={HOLDER}>
                <div class="user-text">{item.text}</div>
                <CopyButton text={item.text} title="Copy message" />
                <button
                  type="button"
                  class={cn(HOVER_ACTION, 'right-7')}
                  title="Edit and resend"
                  aria-label="Edit and resend"
                  onClick={() => window.dispatchEvent(new CustomEvent('pc:compose', { detail: item.text }))}
                >
                  <PencilLine size={13} />
                </button>
              </div>
              )}
        </Row>
      )

    case 'assistant':
      // lib/markdown.tsx tokenises with marked and maps every token to JSX itself -- there
      // is no HTML sink anywhere in that path, so model output gained formatting, never
      // markup execution.
      return (
        <Row kind="assistant" marker={tail === 'streaming' ? <span class="pulse-dot" /> : null}>
          <div class={HOLDER}>
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

    case 'error': {
      const dropped = item.tone !== 'info' && DROPPED_STREAM.test(item.message)
      return (
        <Row
          kind={item.tone === 'info' ? 'note' : 'error'}
          marker={item.tone === 'info' ? Icon.check() : Icon.alert()}
        >
          <div class="notice-title" title={dropped ? item.message : undefined}>
            {dropped ? 'The connection dropped mid-generation.' : item.message}
          </div>
          {dropped && (
            <div class="notice-detail">
              Whatever arrived before it is kept above. Continue asks the model to pick up from there.
            </div>
          )}
          {dropped && tail === 'last' && (
            <Button
              size="sm"
              class="mt-2"
              icon={<RotateCcw />}
              data-action="continue"
              onClick={() => window.dispatchEvent(new CustomEvent('pc:send', { detail: 'continue' }))}
            >
              Continue
            </Button>
          )}
        </Row>
      )
    }

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
          {tail === 'last' && item.reason !== 'truncated' && (
            <Button
              size="sm"
              class="mt-2"
              icon={<Play />}
              data-action="resume"
              onClick={() => window.dispatchEvent(new CustomEvent('pc:send', { detail: 'continue' }))}
            >
              Resume
            </Button>
          )}
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
/** The shapes a stream that died mid-generation takes by the time it reaches the transcript. */
const DROPPED_STREAM = /connection dropped|stream ended before completion|socket hang up|ECONNRESET|fetch failed|terminated/i

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
      marker={<span class={cn('inline-flex [&>svg]:size-3.5', !item.done && 'text-accent motion-safe:animate-pulse')}><Brain /></span>}
    >
      <button
        type="button"
        aria-expanded={open}
        class="group/reason flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent p-0 pb-1 text-left font-ui"
        onClick={() => setOpen((o) => !o)}
      >
        <span class={cn('text-[10.5px] font-semibold uppercase tracking-[0.1em] group-hover/reason:text-fg', item.done ? 'text-faint' : 'text-accent')}>
          {item.done ? 'Reasoned' : 'Reasoning'}
        </span>
        {elapsed !== null && elapsed >= 0 && (
          <span class="font-mono text-[10.5px] text-faint tabular-nums">{formatDuration(elapsed)}</span>
        )}
        <span class="font-mono text-[10.5px] text-faint tabular-nums">~{estimateTokens(item.text.length)} tok</span>
        <span class="inline-flex text-faint opacity-0 transition-opacity duration-(--duration-fast) group-hover/reason:opacity-100 [&>svg]:size-3.5">
          {open ? <ChevronDown /> : <ChevronRight />}
        </span>
      </button>
      {open && (
        <div class="max-h-[440px] overflow-y-auto whitespace-pre-wrap break-words font-ui text-[12.5px] leading-[1.65] text-dim" ref={bodyRef}>
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

const KIND_ICON: Record<ToolKind, VNode> = {
  diff: <FileDiff />,
  fileop: <FileText />,
  read: <Search />,
  command: <Terminal />,
  meta: <MessageSquare />,
  other: <MessageSquare />,
}

/** The card: a hairline that shows on hover, so a run of calls reads as a list and not a
 * stack of boxes; the whole header is the expand control — a 6px chevron is not a target
 * anyone aims at. */
const TOOL_CARD = 'group/tool relative overflow-hidden rounded-sm border border-transparent transition-colors duration-(--duration-fast) hover:border-border-soft focus-within:border-border-soft'
const TOOL_HEAD = 'flex w-full items-center gap-2 border-0 bg-transparent py-1.5 pl-2 pr-[34px] text-left font-ui text-[13px] text-fg'
const TOOL_TARGET = 'min-w-0 flex-1 truncate font-mono text-[12px] text-dim'
const OUTPUT = 'm-0 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.5] text-dim'


/** Whether a completed call's body is worth showing without asking. A diff and a command
 * are the point of their card; a 400-line directory listing is not. */
/**
 * What is worth reading unasked: a failure, always; a diff, because the change IS the
 * result. A command that succeeded is one line — `exit 0 in 5.7 s` on the collapsed row —
 * and its log a click away; opened by default it was a wall of build warnings between the
 * edit and the answer, which is where the eye was going.
 */
function defaultOpen(kind: ToolKind, ok: boolean): boolean {
  if (!ok) return true
  return kind === 'diff'
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
    <div class="group/output relative">
      <button
        type="button"
        class="absolute right-2 top-1.5 cursor-pointer rounded-sm border-0 bg-transparent px-1.5 py-0.5 font-ui text-[11px] text-faint opacity-0 transition-opacity duration-(--duration-fast) hover:bg-hover hover:text-fg group-hover/output:opacity-100 focus-visible:opacity-100"
        onClick={copy}
        title="Copy the whole output"
      >
        {copied ? 'copied' : 'copy'}
      </button>
      {/* No inner scroller on purpose: a nested scroll area inside a scrolling transcript is
          the worst way to read a log. Length is bounded by line count instead. */}
      <pre class={cn(OUTPUT, 'px-3 py-2.5')}>{shown}</pre>
      {overflows && (
        <button
          type="button"
          class="block w-full cursor-pointer border-0 border-t border-border-soft bg-transparent px-3 py-1.5 text-left font-ui text-[11.5px] text-accent hover:bg-hover"
          onClick={() => setExpanded((e) => !e)}
        >
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

  if (state.kind === 'loading') return <div class="loading-quiet px-2.5 py-1.5 font-ui text-[11.5px] text-faint">loading {path}…</div>
  if (state.kind === 'error') return <div class="px-2.5 py-1.5 font-ui text-[11.5px] text-red">could not show {path}: {state.why}</div>
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
      <div class={TOOL_CARD} data-tool="writing">
        {/* Not a button: there is nothing to expand yet, and a header that looks pressable
            but is not is worse than one that plainly is not. */}
        <div class={TOOL_HEAD}>
          <span class="whitespace-nowrap font-medium">{item.name}</span>
          {target !== null ? <span class={TOOL_TARGET}>{target}</span> : <span class="flex-1" />}
          <span class="shrink-0 whitespace-nowrap text-[11.5px] text-faint">
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
      class="mx-2.5 mb-2 mt-1 max-h-[180px] overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[11.5px] leading-[1.4] text-dim"
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
      <div class={cn(TOOL_CARD, !pending && !result.ok && 'hover:border-red-line')} data-tool={pending ? 'pending' : result.ok ? 'ok' : 'fail'}>
        <button
          type="button"
          class={cn(TOOL_HEAD, pending ? 'cursor-default' : 'cursor-pointer hover:bg-raised', 'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent')}
          aria-expanded={pending ? undefined : isOpen}
          onClick={() => { if (!pending) setOpen(!isOpen) }}
          disabled={pending}
        >
          {/* Whose action this is. Absent for the main model, so the common case is
              unchanged and the badge means something when it appears: a worker reading
              eight files used to be indistinguishable from the model reading them itself. */}
          {item.agent !== undefined && (
            <Chip tone="accent" class="h-4 px-1 text-[10px] tracking-[0.02em]" title={`Done by the ${item.agent} worker, not the main model`}>
              {item.agent}
            </Chip>
          )}
          <span class="inline-flex shrink-0 text-faint [&>svg]:size-[13px]">{KIND_ICON[p.kind]}</span>
          <span class={cn('whitespace-nowrap font-medium', !pending && !result.ok && 'text-red')}>{p.verb}</span>
          {/* A command is NOT summarised in the header -- it goes in the body below, whole
              and wrapped. Squeezing a real shell line into one ellipsised row is how you
              end up unable to tell what was actually executed. */}
          {!isCommand && <span class={TOOL_TARGET} title={p.target}>{p.target}</span>}
          {isCommand && <span class="flex-1" />}
          {stat && <DiffStatBadge stat={stat} />}
          {!pending && (
            <span class="inline-flex shrink-0 text-faint [&>svg]:size-3.5">{isOpen ? <ChevronDown /> : <ChevronRight />}</span>
          )}
        </button>

        {/* Opening the file is its own control rather than the whole header, so clicking
            the row to expand a diff can never navigate somewhere unexpected instead. */}
        {p.path !== null && (
          <IconButton
            size="sm"
            class="absolute right-1.5 top-1 opacity-0 transition-opacity duration-(--duration-fast) group-hover/tool:opacity-100 focus-visible:opacity-100"
            label={`Open ${p.path}`}
            onClick={() => onOpenFile(p.path as string)}
          >
            <ExternalLink />
          </IconButton>
        )}

        {/* The command itself is always visible, whole, wrapped -- even while it is still
            running, which is exactly when you most want to know what was launched. */}
        {isCommand && (
          <div class="flex items-start gap-2 pb-2 pl-2.5 pr-3 font-mono text-[11.5px] leading-[1.55]">
            <span class="shrink-0 text-accent">$</span>
            <code class="min-w-0 select-text whitespace-pre-wrap break-words text-fg">{p.target}</code>
          </div>
        )}

        {/* The run, WHILE it runs: stdout/stderr as it arrives, pinned to the tail like a
            terminal. Before this, a two-minute build was a frozen card and "is it working
            or wedged" had no answer in the window. Replaced by the result on exit. */}
        {pending && item.live !== undefined && item.live !== '' && (
          <LiveOutput text={item.live} />
        )}

        {!pending && isOpen && (
          <div class="mb-1 ml-2 mt-0.5 overflow-hidden rounded-sm border border-border-soft bg-panel">
            {clipped && (
              <div class="flex gap-0.5 border-b border-border-soft bg-bg px-2 py-1" role="group" aria-label="Which copy of the output">
                <Button size="sm" variant={showModelCopy ? 'ghost' : 'secondary'} aria-pressed={!showModelCopy} onClick={() => setShowModelCopy(false)} title="Everything the tool produced">
                  Full
                </Button>
                <Button size="sm" variant={showModelCopy ? 'secondary' : 'ghost'} aria-pressed={showModelCopy} onClick={() => setShowModelCopy(true)} title="Exactly what went into the model's context — the rest never reached it">
                  What the model got
                </Button>
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
                  : <pre class={cn(OUTPUT, 'max-h-[380px] overflow-auto px-3 py-2')}>{shownText}</pre>}
          </div>
        )}
        {/* A preview that merely repeats the target ("src/app.ts (32 lines)" under a header
            already reading "Read src/app.ts") is a second line that says nothing. */}
        {!pending && !isOpen && result.preview !== '' && !result.preview.includes(p.target) && (
          <div class="truncate pb-1.5 pl-[29px] pr-2.5 font-ui text-[11.5px] text-faint">{result.preview}</div>
        )}
      </div>
    </Row>
  )
}
