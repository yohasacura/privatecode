import { useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Check, ChevronDown, ChevronRight, MessageSquare, Play, ShieldCheck, X } from 'lucide-preact'
import type { ApprovalDecision, RememberLayer, TodoItem } from '@core/interaction'
import type { ProtocolClient } from '../lib/client'
import type { PendingApproval, PendingQuestion } from '../lib/state'
import { DiffView } from '../lib/diff'
import { FileRefText } from '../lib/file-refs'
import { Button, IconButton } from '../ui/button'
import { Chip } from '../ui/chip'
import { cn } from '../ui/cn'
import { Input } from '../ui/input'
import { Select } from '../ui/select'

/**
 * The two cards that pause a turn, plus the task-list card (docs/UI-REDESIGN-2026-09.md §5
 * "Cards").
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

const LAYERS: readonly { value: RememberLayer; label: string; where: string }[] = [
  { value: 'session', label: 'this session', where: 'kept in memory, gone when the session ends' },
  { value: 'local', label: 'this project (just me)', where: 'written to .privatecode/settings.local.json, not shared' },
  { value: 'project', label: 'this project (shared)', where: 'written to .privatecode/settings.json, checked in with the project' },
  { value: 'user', label: 'all my projects', where: 'written to your user settings, applies everywhere on this machine' },
]

/** The card's frame: the approval reads louder than the conversation around it — it is the
 * security surface — a question sits at the conversation's own weight. */
const CARD = 'overflow-hidden rounded-md border bg-panel font-ui text-[13px] text-fg'
const HEAD = 'flex items-center gap-2.5 px-3 pt-2.5'
const NOTE = 'px-3 pb-2 pl-[38px] text-[12px] text-faint'
const ACTIONS = 'flex flex-wrap items-center gap-2 px-3 py-2.5'

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
  const deny = (): void => reply({ verdict: 'deny', ...(denyComment.trim() !== '' ? { comment: denyComment.trim() } : {}) })
  const chosen = LAYERS.find((l) => l.value === layer)

  return (
    <div
      data-card="approval"
      class={cn(CARD, 'border-accent-line shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_7%,transparent)]')}
      onKeyDown={(e) => {
        // Enter allows, but only from the card's own surface — not from the reason box,
        // where Enter denies with what was typed.
        if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); reply({ verdict: 'allow' }) }
      }}
    >
      <div class={HEAD}>
        <span class="inline-flex shrink-0 text-accent [&>svg]:size-4" aria-hidden="true"><ShieldCheck /></span>
        <span class="min-w-0 flex-1 font-medium">{approval.summary}</span>
        <Chip mono>{approval.tool}</Chip>
      </div>
      <div class={NOTE}>Paused, waiting for you. Nothing is generating while this is open.</div>

      <div class="mx-3 max-h-80 overflow-auto rounded-sm border border-border-soft bg-bg">
        {diff !== null
          ? <DiffView content={diff} dense />
          : <pre class="m-0 whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[12px] leading-[1.5] text-fg">{approval.detail}</pre>}
      </div>

      <div class={ACTIONS}>
        <Button variant="primary" icon={<Check />} onClick={() => reply({ verdict: 'allow' })} data-action="allow" title="Allow this once (Enter)">
          Allow
        </Button>
        {/* Hidden entirely, not disabled, when there is nothing to remember: an "Always"
            button opening onto an empty list would promise a capability the permission
            engine cannot offer for this call. */}
        {approval.suggestedRules.length > 0 && (
          <Button onClick={() => setShowAlways((s) => !s)} aria-expanded={showAlways} data-action="always">
            Always…
            <span class="ml-1 inline-flex [&>svg]:size-3.5">{showAlways ? <ChevronDown /> : <ChevronRight />}</span>
          </Button>
        )}
        <span class="flex-1" />
        <Input
          class="min-w-[180px] flex-1"
          value={denyComment}
          aria-label="What to do instead"
          onInput={(e) => setDenyComment(e.currentTarget.value)}
          placeholder="do what instead? (optional)"
          onKeyDown={(e) => { if (e.key === 'Enter') deny() }}
        />
        <Button variant="danger" icon={<X />} onClick={deny} data-action="deny">Deny</Button>
      </div>

      {showAlways && approval.suggestedRules.length > 0 && (
        <div data-always="" class="mx-3 mb-3 flex flex-col gap-2 rounded-sm border border-border-soft bg-raised px-2.5 py-2 text-[12.5px]">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-dim">Remember</span>
            <Select class="max-w-[280px] font-mono text-[12px]" value={selectedRule} aria-label="The rule to remember" onChange={(e) => setSelectedRule(e.currentTarget.value)}>
              {approval.suggestedRules.map((rule) => <option key={rule} value={rule}>{rule}</option>)}
            </Select>
            <span class="text-dim">for</span>
            <Select value={layer} aria-label="Where the rule applies" onChange={(e) => setLayer(e.currentTarget.value as RememberLayer)}>
              {LAYERS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </Select>
            <Button variant="primary" onClick={() => reply({ verdict: 'allow', remember: { rule: selectedRule, layer } })} data-action="allow-always">
              Allow always
            </Button>
          </div>
          {chosen !== undefined && <div class="text-[11.5px] text-faint">{chosen.where}.</div>}
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

  function pick(option: string): void {
    if (multi) toggle(option)
    else reply(option)
  }

  if (answered) return null

  return (
    <div
      data-card="question"
      class={cn(CARD, 'border-border')}
      onKeyDown={(e) => {
        // The digits pick options, from anywhere in the card but the text box.
        if (e.target instanceof HTMLInputElement) return
        const n = Number.parseInt(e.key, 10)
        if (Number.isNaN(n) || n < 1 || n > 9) return
        const option = question.options[n - 1]
        if (option !== undefined) { e.preventDefault(); pick(option) }
      }}
    >
      <div class={HEAD}>
        <span class="inline-flex shrink-0 text-faint [&>svg]:size-4" aria-hidden="true"><MessageSquare /></span>
        <span class="min-w-0 flex-1 font-medium">{question.question}</span>
      </div>
      <div class={NOTE}>
        {multi ? 'Paused, waiting for you. Pick any that apply.' : 'Paused, waiting for you.'}
        {question.options.length > 0 && question.options.length <= 9 && ' Keys 1–9 pick an option.'}
      </div>
      {question.options.length > 0 && (
        <div class="flex flex-wrap gap-2 px-3 pt-1" data-options="">
          {/* The host always accepts free text too (interaction.ts's `UserQuestion`) --
              these are shortcuts for the likely answers, not the only way to reply.
              Single-select answers on click; multi-select toggles and answers via the
              one button below, because "which several" is not known until they say so. */}
          {question.options.map((option, i) => (
            <Button
              key={option}
              variant={multi && picked.has(option) ? 'primary' : 'secondary'}
              aria-pressed={multi ? picked.has(option) : undefined}
              {...(multi && picked.has(option) ? { icon: <Check /> } : {})}
              onClick={() => pick(option)}
              title={i < 9 ? `${i + 1}` : undefined}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <div class={ACTIONS}>
        <Input
          class="min-w-[180px] flex-1"
          value={freeText}
          aria-label={multi ? 'Your own answer' : 'Your answer'}
          onInput={(e) => setFreeText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') reply(multi ? combined() : freeText) }}
          placeholder={multi ? 'add your own answer (optional)' : 'or answer in your own words'}
        />
        <Button
          variant="primary"
          onClick={() => reply(multi ? combined() : freeText)}
          disabled={multi ? combined() === '' : freeText.trim() === ''}
          data-action="answer"
        >
          Answer
        </Button>
      </div>
    </div>
  )
}

const TODO_TONE: Record<TodoItem['status'], string> = {
  pending: 'text-dim',
  in_progress: 'text-fg',
  completed: 'text-faint line-through',
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
    <div data-todos="" class="relative shrink-0 border-b border-border-soft bg-panel font-ui">
      <button
        type="button"
        aria-expanded={open}
        class="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent py-1.5 pl-3.5 pr-9 text-left font-ui text-[12.5px] text-fg transition-colors duration-(--duration-fast) hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
        onClick={() => setOpen((o) => !o)}
      >
        <span class="inline-flex shrink-0 text-faint [&>svg]:size-3.5">{open ? <ChevronDown /> : <ChevronRight />}</span>
        <span class="font-medium">Plan</span>
        <span class="font-mono text-[10.5px] tabular-nums text-faint">{done}/{todos.length}</span>
        {/* Inert here on purpose: this line lives inside the head's own `<button>`. */}
        {!open && current && <span class="min-w-0 truncate text-dim"><FileRefText text={current.text} /></span>}
        <span class="ml-auto h-[3px] w-[90px] shrink-0 overflow-hidden rounded-[2px] bg-active" aria-hidden="true">
          <span class="block h-full bg-accent transition-[width] duration-(--duration-slow)" style={{ width: `${(done / todos.length) * 100}%` }} />
        </span>
      </button>
      {/* The dismiss the finished-but-ungated task was missing: the harness retires the
          plan when the gate passes, this is the user's hand for every other ending. */}
      {onClear !== undefined && (
        <IconButton
          size="sm"
          class="absolute right-2 top-1"
          label="Close the plan — the list is cleared"
          onClick={(e) => { e.stopPropagation(); onClear() }}
        >
          <X />
        </IconButton>
      )}
      {open && (
        <ul class="m-0 list-none py-0 pb-2.5 pl-[30px] pr-3.5">
          {todos.map((t, i) => (
            <li key={i} data-todo={t.status} class={cn('flex items-center gap-2 py-px text-[12.5px]', TODO_TONE[t.status])}>
              <span class={cn('inline-flex w-3.5 shrink-0 [&>svg]:size-3.5', t.status === 'completed' ? 'text-green' : t.status === 'in_progress' ? 'text-accent' : 'text-faint')}>
                {t.status === 'completed' ? <Check /> : t.status === 'in_progress' ? <Play /> : null}
              </span>
              <span data-todo-text="" class="min-w-0">
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
