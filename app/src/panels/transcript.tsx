import { useEffect, useRef, useState } from 'preact/hooks'
import { memo } from 'preact/compat'
import type { ComponentChildren, VNode } from 'preact'
import type { StoppedBecause } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import type { ChatAction, ChatItem, ChatState } from '../lib/state'
import { Markdown } from '../lib/markdown'
import { DiffStatBadge, DiffView, diffStat } from '../lib/diff'
import { presentTool, screenshotPathOf, type ToolKind } from '../lib/tools'
import { formatDuration } from '../lib/format'
import { useStickToBottom } from '../lib/sticky-scroll'
import { Icon } from '../components/icons'
import { ApprovalCard, QuestionCard, TodosCard } from './approvals'
import { DecisionsCard } from './decisions'

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
  client, state, dispatch, onOpenFile, onBackToLive,
}: {
  client: ProtocolClient
  state: ChatState
  dispatch: (action: ChatAction) => void
  onOpenFile: (path: string) => void
  /** Stop reading an earlier session and go back to the one that works. */
  onBackToLive: () => void
}): VNode {
  const scrollRef = useRef<HTMLDivElement>(null)

  const lastItem = state.items[state.items.length - 1]
  // No signal to compute: the hook watches the container itself, which is the only thing
  // that knows about a tool result arriving, a card being expanded, or "show more lines".
  const { stuck, scrollToBottom } = useStickToBottom(scrollRef)

  // Sending always returns you to the bottom. If you were reading back through the
  // transcript and then typed, you want to watch the answer, not stay where you were.
  const lastUserId = [...state.items].reverse().find((i) => i.kind === 'user')?.id ?? 0
  useEffect(() => {
    if (lastUserId !== 0) scrollToBottom()
  }, [lastUserId, scrollToBottom])

  const waiting = state.turnRunning && isQuiet(lastItem) &&
    !state.pendingApproval && !state.pendingQuestion

  // While an approval is open, the call it is asking about is already announced -- in more
  // detail, with the diff or the command text -- by the card itself. Rendering the bare
  // pending stub above it says the same thing twice. It comes back the moment the decision
  // is made, carrying the outcome.
  const suppressedId = state.pendingApproval !== null && lastItem?.kind === 'tool' && lastItem.result === undefined
    ? lastItem.id
    : null

  // Reading an earlier session shows ITS conversation; the live one keeps accumulating into
  // `state.items` behind this view, so going back shows everything that happened meanwhile.
  const viewing = state.viewing
  const shown = viewing === null ? state.items : viewing.items

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

      {viewing === null && <TodosCard todos={state.todos} />}

      <div class="transcript" ref={scrollRef}>
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
            <div class="row-body">
              working{state.currentStep ? ` · step ${state.currentStep.step}` : ''}
            </div>
          </div>
        )}

        {/* Wrapped in a Row like everything else: a card that ignored the gutter sat 28px
            left of the whole conversation, which is exactly the sort of thing that makes a
            UI look assembled rather than designed. */}
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
  const freed = item.beforeTokens > 0
    ? Math.round((1 - item.afterTokens / item.beforeTokens) * 100)
    : 0
  return (
    <Row kind="record record-compaction" marker={Icon.chat()}>
      <button class="compaction-head" onClick={() => setOpen((o) => !o)}>
        <span class="record-text">
          compacted — <b>{tokens(item.beforeTokens)} → {tokens(item.afterTokens)}</b> ({freed}% freed),
          {' '}{item.droppedMessages} message{item.droppedMessages === 1 ? '' : 's'} replaced by a briefing,
          {' '}{item.keptMessages} kept as they were
        </span>
        <span class="compaction-toggle">{open ? 'hide the briefing' : 'what it kept'}</span>
      </button>
      {open && (
        <div class="compaction-body">
          <div class="compaction-note">
            From here on the model reads this instead of the conversation above it.
          </div>
          <pre class="compaction-summary">{item.summary}</pre>
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
      return (
        <Row kind="user" marker={<span class="marker-caret">›</span>}>
          <div class="user-text">{item.text}</div>
        </Row>
      )

    case 'assistant':
      // lib/markdown.tsx tokenises with marked and maps every token to JSX itself -- there
      // is no HTML sink anywhere in that path, so model output gained formatting, never
      // markup execution.
      return (
        <Row kind="assistant">
          <Markdown text={item.text} />
          {item.interrupted && <div class="interrupted">stopped by you</div>}
        </Row>
      )

    case 'thinking':
      return <ReasoningBlock item={item} />

    case 'tool':
      return <ToolCard item={item} onOpenFile={onOpenFile} client={client} />

    case 'error':
      return (
        <Row kind="error" marker={Icon.alert()}>
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
            verified with <b>{item.command}</b> — {item.detail}
          </span>
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
        <div class="reasoning-body">
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

  if (state.kind === 'loading') return <div class="tool-preview">loading {path}…</div>
  if (state.kind === 'error') return <div class="tool-preview">could not show {path}: {state.why}</div>
  return (
    <figure class="shot">
      <img src={state.url} alt={`Browser screenshot, ${path}`} />
      <figcaption>{path} — the model cannot see this; you can</figcaption>
    </figure>
  )
}

function ToolCard({
  item, onOpenFile, client,
}: {
  item: ChatItem & { kind: 'tool' }
  onOpenFile: (path: string) => void
  client: ProtocolClient
}): VNode {
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
      kind={`tool tool-${pending ? 'pending' : result.ok ? 'ok' : 'fail'}`}
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
