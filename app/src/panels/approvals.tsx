import { useState } from 'preact/hooks'
import type { ApprovalDecision, RememberLayer, TodoItem } from '@core/interaction'
import type { ProtocolClient } from '../lib/client'
import type { PendingApproval, PendingQuestion } from '../lib/state'

const LAYERS: readonly RememberLayer[] = ['session', 'local', 'project', 'user']

/**
 * Approval/question cards and the todo checklist (Plan 4 Task 6). Both cards render
 * ABOVE the input row in `chat.tsx` while the turn is genuinely paused -- `SessionHost`
 * is awaiting exactly this reply before the turn's next step runs (see host.ts's own
 * doc comment), so the caption below is not just decorative copy, it states a real
 * property: nothing is being billed while the card sits open.
 *
 * Each card's own state machine is pending -> answered, single-fire, enforced TWICE:
 * `answered` (component-local `useState`) disables every button the instant one is
 * clicked, before the RPC round-trip even starts; `onAnswered` also dispatches
 * `approval.answered`/`question.answered` into `lib/state.ts`'s reducer immediately,
 * which clears `pendingApproval`/`pendingQuestion` and unmounts this card from
 * `chat.tsx`'s tree on the very next render. The SERVER'S single-use requestId guarantee
 * (host.ts) is the real security boundary; both of these are defense in depth against a
 * confusing double-reply, not what makes a replay unable to authorize anything.
 */
export function ApprovalCard({
  client, approval, onAnswered,
}: {
  client: ProtocolClient
  approval: PendingApproval
  onAnswered: (decision: ApprovalDecision) => void
}) {
  const [showAlways, setShowAlways] = useState(false)
  const [selectedRule, setSelectedRule] = useState(approval.suggestedRules[0] ?? '')
  const [layer, setLayer] = useState<RememberLayer>('session')
  const [denyComment, setDenyComment] = useState('')
  const [answered, setAnswered] = useState(false)

  function reply(decision: ApprovalDecision): void {
    if (answered) return
    setAnswered(true)
    onAnswered(decision)
    client.call('approval.reply', { requestId: approval.requestId, decision }).catch(() => {
      // The transcript record (from onAnswered, already dispatched) shows what the user
      // chose regardless of whether this round-trip itself succeeded; nothing more to do
      // client-side for a reply the server may or may not have received.
    })
  }

  if (answered) return null

  return (
    <div class="approval-card">
      <div class="approval-caption">Turn paused — no tokens burn while you decide.</div>
      <div class="approval-summary"><b class="approval-tool">{approval.tool}</b>: {approval.summary}</div>
      <pre class="approval-detail">{approval.detail}</pre>
      <div class="approval-buttons">
        <button onClick={() => reply({ verdict: 'allow' })}>Allow once</button>
        {/* Rule-honesty contract: HIDDEN entirely (not just disabled) when there is
            nothing to remember -- an "Always…" button that opens to an empty list would
            promise a capability the engine cannot actually offer for this call. */}
        {approval.suggestedRules.length > 0 && (
          <button class="always-toggle" onClick={() => setShowAlways((s) => !s)}>Always…</button>
        )}
        <input
          class="deny-comment"
          value={denyComment}
          onInput={(e) => setDenyComment(e.currentTarget.value)}
          placeholder="tell the model what to do instead"
        />
        <button
          class="deny-button"
          onClick={() => reply({ verdict: 'deny', ...(denyComment.trim() !== '' ? { comment: denyComment.trim() } : {}) })}
        >
          Deny
        </button>
      </div>
      {showAlways && approval.suggestedRules.length > 0 && (
        <div class="always-panel">
          <select value={selectedRule} onChange={(e) => setSelectedRule(e.currentTarget.value)}>
            {approval.suggestedRules.map((rule) => <option key={rule} value={rule}>{rule}</option>)}
          </select>
          <select value={layer} onChange={(e) => setLayer(e.currentTarget.value as RememberLayer)}>
            {LAYERS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <button onClick={() => reply({ verdict: 'allow', remember: { rule: selectedRule, layer } })}>
            Confirm always-allow
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
}) {
  const [freeText, setFreeText] = useState('')
  const [answered, setAnswered] = useState(false)

  function reply(answer: string): void {
    if (answered || answer.trim() === '') return
    setAnswered(true)
    onAnswered(answer)
    client.call('question.reply', { requestId: question.requestId, answer }).catch(() => { /* see ApprovalCard's reply() */ })
  }

  if (answered) return null

  return (
    <div class="question-card">
      <div class="approval-caption">Turn paused — no tokens burn while you decide.</div>
      <div class="question-text">{question.question}</div>
      <div class="question-options">
        {/* The host always ALSO accepts free text (interaction.ts's own UserQuestion
            comment) -- these buttons are a shortcut for the common answers, not the only
            way to reply. */}
        {question.options.map((option) => (
          <button key={option} onClick={() => reply(option)}>{option}</button>
        ))}
      </div>
      <div class="question-freetext">
        <input
          value={freeText}
          onInput={(e) => setFreeText(e.currentTarget.value)}
          placeholder="or type your own answer"
        />
        <button onClick={() => reply(freeText)} disabled={freeText.trim() === ''}>Answer</button>
      </div>
    </div>
  )
}

const TODO_MARK: Record<TodoItem['status'], string> = {
  pending: '[ ]',
  in_progress: '[>]',
  completed: '[x]',
}

/** The compact checklist in the chat panel's header area -- renders nothing at all when
 * there are no todos, rather than an empty box, so a task that never calls todo_write
 * costs the layout nothing. */
export function TodosWidget({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null
  return (
    <div class="todos-widget">
      {todos.map((t, i) => (
        <div key={i} class={`todo-item todo-${t.status}`}>
          <span class="todo-mark">{TODO_MARK[t.status]}</span> {t.text}
        </div>
      ))}
    </div>
  )
}
