import { useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ApprovalDecision, RememberLayer, TodoItem } from '@core/interaction'
import type { ProtocolClient } from '../lib/client'
import type { PendingApproval, PendingQuestion } from '../lib/state'
import { DiffView } from '../lib/diff'
import { FileRefText } from '../lib/file-refs'
import { Icon } from '../components/icons'

/**
 * The two cards that pause a turn, plus the task-list card.
 *
 * They render INLINE in the transcript, at the point in the conversation where the agent
 * asked — not pinned to the bottom of the window as a separate strip. An approval is part
 * of the conversation ("may I do this?" / "no, do that instead") and reads as one; it also
 * means the transcript record that replaces the card afterwards appears in exactly the
 * place the card was.
 *
 * Each card's pending → answered transition is single-fire, enforced twice: `answered`
 * disables the buttons before the RPC round-trip starts, and `onAnswered` clears the
 * pending state in the reducer immediately, unmounting the card. The host's single-use
 * requestId is the actual security boundary (`core/src/host/host.ts`); both of these are
 * defence in depth against a confusing double-click, not what makes a replay harmless.
 */

const LAYERS: readonly { value: RememberLayer; label: string }[] = [
  { value: 'session', label: 'this session' },
  { value: 'local', label: 'this project (just me)' },
  { value: 'project', label: 'this project (shared)' },
  { value: 'user', label: 'all my projects' },
]

/**
 * `edit_file`'s approval detail is a SEARCH/REPLACE block (see its `approvalPreview`).
 * Shown verbatim it is a wall of markers; the two halves are exactly a before and an after,
 * so they turn into a real coloured diff with no information invented. Returns `null` for
 * any detail that is not that shape, and the caller falls back to plain text.
 */
function searchReplaceToDiff(detail: string): string | null {
  const m = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/.exec(detail)
  const before = m?.[1]
  const after = m?.[2]
  if (before === undefined || after === undefined) return null
  const removed = before.split('\n').map((l) => `-${l}`)
  const added = after.split('\n').map((l) => `+${l}`)
  return [...removed, ...added].join('\n')
}

export function ApprovalCard({
  client, approval, onAnswered,
}: {
  client: ProtocolClient
  approval: PendingApproval
  onAnswered: (decision: ApprovalDecision) => void
}): VNode | null {
  const [showAlways, setShowAlways] = useState(false)
  const [selectedRule, setSelectedRule] = useState(approval.suggestedRules[0] ?? '')
  // 'local', matching the parked DecisionsCard's default: the button says ALWAYS, and a
  // rule that silently died with the session made tomorrow's run stop on the very approval
  // the user believed they had answered for good. The select still offers 'session' for
  // someone who genuinely wants a one-session grant.
  const [layer, setLayer] = useState<RememberLayer>('local')
  const [denyComment, setDenyComment] = useState('')
  const [answered, setAnswered] = useState(false)

  function reply(decision: ApprovalDecision): void {
    if (answered) return
    setAnswered(true)
    onAnswered(decision)
    client.call('approval.reply', { requestId: approval.requestId, decision }).catch(() => {
      // The transcript record (already dispatched by onAnswered) shows what was chosen
      // regardless of whether this round-trip landed; nothing more to do client-side.
    })
  }

  if (answered) return null

  const diff = searchReplaceToDiff(approval.detail)

  return (
    <div class="card card-approval">
      <div class="card-head">
        <span class="card-icon card-icon-warn">{Icon.shield()}</span>
        <span class="card-title">{approval.summary}</span>
        <span class="card-tag">{approval.tool}</span>
      </div>
      <div class="card-note">Paused, waiting for you. Nothing is generating while this is open.</div>

      <div class="card-detail">
        {diff !== null ? <DiffView content={diff} dense /> : <pre class="card-detail-pre">{approval.detail}</pre>}
      </div>

      <div class="card-actions">
        <button class="btn btn-primary" onClick={() => reply({ verdict: 'allow' })}>Allow</button>
        {/* Hidden entirely, not disabled, when there is nothing to remember: an "Always"
            button opening onto an empty list would promise a capability the permission
            engine cannot offer for this call. */}
        {approval.suggestedRules.length > 0 && (
          <button class="btn" onClick={() => setShowAlways((s) => !s)}>
            Always… {showAlways ? Icon.chevronDown() : Icon.chevronRight()}
          </button>
        )}
        <span class="card-actions-gap" />
        <input
          class="input deny-comment"
          value={denyComment}
          onInput={(e) => setDenyComment(e.currentTarget.value)}
          placeholder="do what instead? (optional)"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              reply({ verdict: 'deny', ...(denyComment.trim() !== '' ? { comment: denyComment.trim() } : {}) })
            }
          }}
        />
        <button
          class="btn btn-danger"
          onClick={() => reply({ verdict: 'deny', ...(denyComment.trim() !== '' ? { comment: denyComment.trim() } : {}) })}
        >
          Deny
        </button>
      </div>

      {showAlways && approval.suggestedRules.length > 0 && (
        <div class="always-panel">
          <label>Remember</label>
          <select class="select" value={selectedRule} onChange={(e) => setSelectedRule(e.currentTarget.value)}>
            {approval.suggestedRules.map((rule) => <option key={rule} value={rule}>{rule}</option>)}
          </select>
          <label>for</label>
          <select class="select" value={layer} onChange={(e) => setLayer(e.currentTarget.value as RememberLayer)}>
            {LAYERS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
          <button class="btn btn-primary" onClick={() => reply({ verdict: 'allow', remember: { rule: selectedRule, layer } })}>
            Allow always
          </button>
        </div>
      )}
    </div>
  )
}

export function QuestionCard({
  client, question, onAnswered,
}: {
  client: ProtocolClient
  question: PendingQuestion
  onAnswered: (answer: string) => void
}): VNode | null {
  const [freeText, setFreeText] = useState('')
  const [answered, setAnswered] = useState(false)
  // Multi-select only. A Set, keyed by option text (options are validated distinct).
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const multi = question.multiSelect === true

  function reply(answer: string): void {
    if (answered || answer.trim() === '') return
    setAnswered(true)
    onAnswered(answer)
    client.call('question.reply', { requestId: question.requestId, answer }).catch(() => { /* see ApprovalCard */ })
  }

  /** The combined multi-select answer: picked options in their ORIGINAL order (the model
   * wrote them in a deliberate order; click order is noise), free text appended last. */
  function combined(): string {
    const parts = question.options.filter((o) => picked.has(o))
    if (freeText.trim() !== '') parts.push(freeText.trim())
    return parts.join('; ')
  }

  function toggle(option: string): void {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(option)) next.delete(option)
      else next.add(option)
      return next
    })
  }

  if (answered) return null

  return (
    <div class="card card-question">
      <div class="card-head">
        <span class="card-icon">{Icon.chat()}</span>
        <span class="card-title">{question.question}</span>
      </div>
      <div class="card-note">{multi ? 'Paused, waiting for you. Pick any that apply.' : 'Paused, waiting for you.'}</div>
      {question.options.length > 0 && (
        <div class="question-options">
          {/* The host always accepts free text too (interaction.ts's `UserQuestion`) --
              these are shortcuts for the likely answers, not the only way to reply.
              Single-select answers on click; multi-select toggles and answers via the
              one button below, because "which several" is not known until they say so. */}
          {question.options.map((option) => (
            <button
              key={option}
              class={multi && picked.has(option) ? 'btn btn-toggled' : 'btn'}
              aria-pressed={multi ? picked.has(option) : undefined}
              onClick={() => { if (multi) toggle(option); else reply(option) }}
            >
              {multi ? `${picked.has(option) ? '☑' : '☐'} ${option}` : option}
            </button>
          ))}
        </div>
      )}
      <div class="card-actions">
        <input
          class="input"
          value={freeText}
          onInput={(e) => setFreeText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') reply(multi ? combined() : freeText) }}
          placeholder={multi ? 'add your own answer (optional)' : 'or answer in your own words'}
        />
        <button
          class="btn btn-primary"
          onClick={() => reply(multi ? combined() : freeText)}
          disabled={multi ? combined() === '' : freeText.trim() === ''}
        >
          Answer
        </button>
      </div>
    </div>
  )
}

/**
 * The current task list, pinned above the transcript. Renders nothing at all when the model
 * never called `todo_write`, so a one-shot question costs no layout.
 */
export function TodosCard(
  { todos, onClear, onOpenFile }: {
    todos: TodoItem[]
    onClear?: () => void
    /** Absent renders the paths marked but inert — see `FileRefText`. */
    onOpenFile?: (path: string) => void
  },
): VNode | null {
  const [open, setOpen] = useState(true)
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')

  return (
    <div class="todos">
      <button class="todos-head" onClick={() => setOpen((o) => !o)}>
        <span class="todos-chevron">{open ? Icon.chevronDown() : Icon.chevronRight()}</span>
        <span class="todos-title">Plan</span>
        <span class="todos-count">{done}/{todos.length}</span>
        {/* Inert here on purpose: this line lives inside the head's own `<button>`. */}
        {!open && current && <span class="todos-current"><FileRefText text={current.text} /></span>}
        <span class="todos-bar"><span class="todos-bar-fill" style={{ width: `${(done / todos.length) * 100}%` }} /></span>
      </button>
      {/* The dismiss the finished-but-ungated task was missing: the harness retires the
          plan when the gate passes, this is the user's hand for every other ending. */}
      {onClear !== undefined && (
        <button
          class="todos-clear"
          title="Close the plan — the list is cleared"
          onClick={(e) => { e.stopPropagation(); onClear() }}
        >
          {Icon.x()}
        </button>
      )}
      {open && (
        <ul class="todos-list">
          {todos.map((t, i) => (
            <li key={i} class={`todo todo-${t.status}`}>
              <span class="todo-mark">
                {t.status === 'completed' ? Icon.check() : t.status === 'in_progress' ? Icon.play() : null}
              </span>
              <span class="todo-text">
                {onOpenFile === undefined
                  ? <FileRefText text={t.text} />
                  : <FileRefText text={t.text} onOpenFile={onOpenFile} />}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
