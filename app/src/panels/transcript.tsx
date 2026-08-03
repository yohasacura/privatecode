import { useEffect, useRef, useState } from 'preact/hooks'
import { memo } from 'preact/compat'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import type { ChatAction, ChatItem, ChatState } from '../lib/state'
import { Markdown } from '../lib/markdown'
import { DiffStatBadge, DiffView, diffStat } from '../lib/diff'
import { presentTool, type ToolKind } from '../lib/tools'
import { formatDuration } from '../lib/format'
import { useStickToBottom } from '../lib/sticky-scroll'
import { Icon } from '../components/icons'
import { ApprovalCard, QuestionCard, TodosCard } from './approvals'

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
  client, state, dispatch, onOpenFile,
}: {
  client: ProtocolClient
  state: ChatState
  dispatch: (action: ChatAction) => void
  onOpenFile: (path: string) => void
}): VNode {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Streaming appends to the LAST item rather than adding one, so item count alone would
  // not re-pin the view while a long answer streams; the tail's own length would not move
  // when a new item is pushed. Both together do.
  const lastItem = state.items[state.items.length - 1]
  const tailSize = lastItem === undefined
    ? 0
    : lastItem.kind === 'assistant' ? lastItem.text.length
      : lastItem.kind === 'thinking' ? lastItem.text.length
        : 0
  const { stuck, scrollToBottom } = useStickToBottom(
    scrollRef,
    `${state.items.length}:${tailSize}:${state.pendingApproval?.requestId ?? ''}`,
  )

  const waiting = state.turnRunning && isQuiet(lastItem) &&
    !state.pendingApproval && !state.pendingQuestion

  return (
    <div class="transcript-wrap">
      <TodosCard todos={state.todos} />

      <div class="transcript" ref={scrollRef}>
        {state.items.length === 0 && !state.turnRunning
          ? <EmptyState />
          : state.items.map((item) => (
            <TranscriptRow key={item.id} item={item} onOpenFile={onOpenFile} />
          ))}

        {waiting && (
          <div class="row row-waiting">
            <span class="pulse-dot" aria-hidden="true" />
            <span>working…{state.currentStep ? ` step ${state.currentStep.step}` : ''}</span>
          </div>
        )}

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
      </div>

      {!stuck && (
        <button class="jump-latest" onClick={scrollToBottom}>
          {Icon.arrowDown()} latest
        </button>
      )}
    </div>
  )
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
      </div>
    </div>
  )
}

/** See the file header: the reference comparison on `item` is what keeps a streamed token
 * from re-rendering (and re-parsing) the entire transcript. `onOpenFile` is stable — it is
 * created once in `App.tsx` — so the default shallow comparison is enough. */
const TranscriptRow = memo(function TranscriptRow({
  item, onOpenFile,
}: {
  item: ChatItem
  onOpenFile: (path: string) => void
}): VNode {
  switch (item.kind) {
    case 'user':
      return (
        <div class="row row-user">
          <div class="user-bubble">{item.text}</div>
        </div>
      )

    case 'assistant':
      // lib/markdown.tsx tokenises with marked and maps every token to JSX itself -- there
      // is no HTML sink anywhere in that path, so model output gained formatting, never
      // markup execution.
      return (
        <div class="row row-assistant">
          <Markdown text={item.text} />
          {item.interrupted && <div class="interrupted">stopped by you</div>}
        </div>
      )

    case 'thinking':
      return <ReasoningBlock item={item} />

    case 'tool':
      return <ToolCard item={item} onOpenFile={onOpenFile} />

    case 'error':
      return (
        <div class="row row-error">
          <span class="row-error-icon">{Icon.alert()}</span>
          <span>{item.message}</span>
        </div>
      )

    case 'approval-record': {
      const allowed = item.decision.verdict === 'allow'
      const comment = item.decision.verdict === 'deny' ? item.decision.comment : undefined
      const remember = item.decision.verdict === 'allow' ? item.decision.remember : undefined
      return (
        <div class={`row row-record record-${item.decision.verdict}`}>
          <span class="record-icon">{allowed ? Icon.check() : Icon.x()}</span>
          <span class="record-text">
            <b>{item.tool}</b> {allowed ? 'allowed' : 'denied'} — {item.summary}
            {remember && <em> · always: {remember.rule} ({remember.layer})</em>}
            {comment && <em> · “{comment}”</em>}
          </span>
        </div>
      )
    }

    case 'question-record':
      return (
        <div class="row row-record">
          <span class="record-icon">{Icon.check()}</span>
          <span class="record-text">{item.question} — <b>{item.answer}</b></span>
        </div>
      )
  }
})

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

  // The timer lives HERE, not in the transcript: a clock passed down as a prop ticks every
  // row and defeats the memoisation the file header explains. Only a block that is still
  // being written has anything to count.
  useEffect(() => {
    if (item.done) return
    const id = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [item.done])

  const elapsed = item.done
    ? (item.endedAtMs !== null ? item.endedAtMs - item.startedAtMs : null)
    : now - item.startedAtMs

  return (
    <div class={`row reasoning ${item.done ? 'reasoning-done' : 'reasoning-live'}`}>
      <button class="reasoning-head" onClick={() => setOpen((o) => !o)}>
        <span class="reasoning-chevron">{open ? Icon.chevronDown() : Icon.chevronRight()}</span>
        <span class="reasoning-icon">{Icon.brain()}</span>
        <span class="reasoning-title">
          {item.done ? 'Thought' : 'Thinking'}
          {elapsed !== null && elapsed >= 0 && <> for {formatDuration(elapsed)}</>}
        </span>
        <span class="reasoning-meta">~{estimateTokens(item.text.length)} tokens</span>
      </button>
      {open && (
        <div class="reasoning-body">
          {item.text}
          {!item.done && <span class="caret" aria-hidden="true" />}
        </div>
      )}
    </div>
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

/** Whether a completed call's body is worth showing without asking. A diff is the point of
 * the card; a 400-line directory listing is not. */
function defaultOpen(kind: ToolKind, ok: boolean, content: string): boolean {
  if (!ok) return true
  if (kind === 'diff') return true
  if (kind === 'command') return content.split('\n').length <= 24
  return false
}

function ToolCard({
  item, onOpenFile,
}: {
  item: ChatItem & { kind: 'tool' }
  onOpenFile: (path: string) => void
}): VNode {
  const p = presentTool(item.name, item.args)
  const result = item.result
  const pending = result === undefined
  const content = result?.content ?? ''
  const [open, setOpen] = useState<boolean | null>(null)
  const isOpen = open ?? (result ? defaultOpen(p.kind, result.ok, content) : false)
  const stat = p.kind === 'diff' && result?.ok ? diffStat(content) : null

  return (
    <div class={`row tool-card tool-${pending ? 'pending' : result.ok ? 'ok' : 'fail'}`}>
      <div class="tool-head">
        <span class="tool-status">
          {pending
            ? <span class="pulse-dot" aria-hidden="true" />
            : result.ok ? Icon.check() : Icon.x()}
        </span>
        <span class="tool-icon">{KIND_ICON[p.kind]()}</span>
        <span class="tool-verb">{p.verb}</span>
        {p.path !== null
          ? (
            <button class="tool-target tool-target-link" onClick={() => onOpenFile(p.path as string)} title={p.target}>
              {p.target}
            </button>
            )
          : <span class="tool-target" title={p.target}>{p.target}</span>}
        {stat && <DiffStatBadge stat={stat} />}
        {!pending && (
          <button class="tool-toggle" onClick={() => setOpen(!isOpen)}>
            {isOpen ? Icon.chevronDown() : Icon.chevronRight()}
          </button>
        )}
      </div>

      {!pending && isOpen && (
        <div class="tool-body">
          {p.kind === 'diff' && result.ok
            ? <DiffView content={content} />
            : <pre class="tool-output">{content}</pre>}
        </div>
      )}
      {!pending && !isOpen && result.preview !== '' && (
        <div class="tool-preview">{result.preview}</div>
      )}
    </div>
  )
}
