import { useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Check, ChevronDown, ChevronRight, MessageSquare } from 'lucide-preact'
import type { DecisionInfo } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { PanelError } from '../components/panel'
import { Button } from '../ui/button'
import { Chip } from '../ui/chip'
import { Input } from '../ui/input'
import { Select } from '../ui/select'

/**
 * The questions the agent parked while nobody was watching.
 *
 * This lives in the transcript column, where approvals already are, and not in a tab —
 * because it is a TASK, not a reference. A tab would file it beside Jobs, which is where
 * things you are not doing live, and a night's questions would sit there unanswered.
 *
 * Answering an approval is where the queue pays for itself: the same rule-and-layer selects
 * the live card offers turn a night's worth of parked requests into a handful of permission
 * rules, so tomorrow's run does not stop on the same three things.
 *
 * What it deliberately does NOT do is re-run anything. The call was refused hours ago and
 * the agent moved on; this records an answer for next time. Offering "Allow" in a way that
 * implied the command would now execute would be the worst kind of lie for a security
 * surface.
 */

const LAYERS: { value: 'session' | 'local' | 'project' | 'user'; label: string }[] = [
  { value: 'session', label: 'this session' },
  { value: 'local', label: 'this project (just me)' },
  { value: 'project', label: 'this project (shared)' },
  { value: 'user', label: 'all my projects' },
]

function whenOf(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function OneDecision({
  decision, onResolve,
}: {
  decision: DecisionInfo
  onResolve: (params: {
    id: string
    verdict?: 'allow' | 'deny'
    rule?: { rule: string; layer: 'session' | 'local' | 'project' | 'user' }
    answer?: string
  }) => void
}): VNode {
  const rules = decision.suggestedRules ?? []
  const [rule, setRule] = useState(rules[0] ?? '')
  const [layer, setLayer] = useState<'session' | 'local' | 'project' | 'user'>('local')
  const [answer, setAnswer] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())

  const head = (title: string, tag?: string): VNode => (
    <div class="mb-1.5 flex items-baseline gap-2">
      <span class="shrink-0 text-[11.5px] tabular-nums text-dim">{whenOf(decision.at)}</span>
      <span class="min-w-0 flex-1 text-[12.5px] font-semibold text-fg">{title}</span>
      {tag !== undefined && <Chip mono>{tag}</Chip>}
    </div>
  )

  if (decision.kind === 'question') {
    const multi = decision.multiSelect === true
    const options = decision.options ?? []
    // Same shape as the live card: single-select answers on click, multi-select toggles
    // into `picked` and resolves through one button, options kept in the model's order.
    const combined = (): string => {
      const parts = options.filter((o) => picked.has(o))
      if (answer.trim() !== '') parts.push(answer.trim())
      return parts.join('; ')
    }
    return (
      <div data-decision="question" class="rounded-sm border border-border-soft bg-bg p-2.5 font-ui">
        {head(decision.question ?? '')}
        <div class="flex flex-wrap items-center gap-1.5">
          {options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={multi && picked.has(option) ? 'primary' : 'secondary'}
              aria-pressed={multi ? picked.has(option) : undefined}
              {...(multi && picked.has(option) ? { icon: <Check /> } : {})}
              onClick={() => {
                if (!multi) { onResolve({ id: decision.id, answer: option }); return }
                setPicked((prev) => {
                  const next = new Set(prev)
                  if (next.has(option)) next.delete(option)
                  else next.add(option)
                  return next
                })
              }}
            >
              {option}
            </Button>
          ))}
          <Input
            class="min-w-[140px] flex-1"
            value={answer}
            aria-label="Your own answer"
            onInput={(e) => setAnswer(e.currentTarget.value)}
            placeholder={multi ? 'add your own answer (optional)' : 'or type an answer'}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const full = multi ? combined() : answer.trim()
              if (full !== '') onResolve({ id: decision.id, answer: full })
            }}
          />
          {multi && (
            <Button size="sm" variant="primary" disabled={combined() === ''} onClick={() => onResolve({ id: decision.id, answer: combined() })}>
              Answer
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div data-decision="approval" class="rounded-sm border border-border-soft bg-bg p-2.5 font-ui">
      {head(decision.summary ?? '', decision.tool)}
      <pre class="m-0 mb-2 max-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-sm bg-raised px-2 py-1.5 font-mono text-[11.5px] leading-[1.4] text-dim">{decision.detail}</pre>
      <div class="flex flex-wrap items-center gap-1.5">
        {/* "Allow" here means "allow it NEXT time", and the note below says so. The call it
            came from is long gone. */}
        {rules.length > 0 && (
          <>
            <Select class="max-w-[260px] font-mono text-[12px]" value={rule} aria-label="The rule to remember" onChange={(e) => setRule(e.currentTarget.value)}>
              {rules.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
            <Select value={layer} aria-label="Where the rule applies" onChange={(e) => setLayer(e.currentTarget.value as typeof layer)}>
              {LAYERS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </Select>
            <Button size="sm" variant="primary" onClick={() => onResolve({ id: decision.id, verdict: 'allow', rule: { rule, layer } })}>
              Allow from now on
            </Button>
          </>
        )}
        <Button size="sm" onClick={() => onResolve({ id: decision.id, verdict: 'deny' })}>Dismiss</Button>
      </div>
    </div>
  )
}

export function DecisionsCard({
  client, pending, onChanged,
}: {
  client: ProtocolClient
  /** Count from the `decisions.changed` event, so the card appears without polling. */
  pending: number
  onChanged: () => void
}): VNode | null {
  const [open, setOpen] = useState(false)
  const [decisions, setDecisions] = useState<DecisionInfo[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    client.call('decisions.list', {})
      .then((r) => { setDecisions(r.decisions); setError(null) })
      .catch((e: Error) => setError(e.message))
  }, [client, open, pending])

  if (pending === 0) return null

  function resolve(params: Parameters<Parameters<typeof OneDecision>[0]['onResolve']>[0]): void {
    client.call('decisions.resolve', params)
      .then(() => {
        setDecisions((prev) => prev.filter((d) => d.id !== params.id))
        onChanged()
      })
      .catch((e: Error) => setError(e.message))
  }

  return (
    <div data-card="decisions" class="overflow-hidden rounded-md border border-accent bg-panel font-ui">
      <button
        type="button"
        aria-expanded={open}
        class="flex w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3 py-2.5 text-left font-ui text-[13px] text-fg transition-colors duration-(--duration-fast) hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
        onClick={() => setOpen(!open)}
      >
        <span class="inline-flex shrink-0 text-accent [&>svg]:size-4"><MessageSquare /></span>
        <span class="min-w-0 flex-1 font-medium">
          {pending} question{pending === 1 ? '' : 's'} {pending === 1 ? 'was' : 'were'} parked while you were away
        </span>
        <span class="inline-flex shrink-0 text-faint [&>svg]:size-4">{open ? <ChevronDown /> : <ChevronRight />}</span>
      </button>
      {!open && (
        <div class="px-3 pb-2.5 pl-[38px] text-[12px] text-faint">
          Answering them writes permission rules, so the next run does not stop on the same thing.
        </div>
      )}

      {open && (
        <div class="flex flex-col gap-2 px-3 pb-3">
          {error !== null && <PanelError message={error} />}
          {decisions.map((d) => <OneDecision key={d.id} decision={d} onResolve={resolve} />)}
          <div class="text-[12px] text-faint">
            These calls already came and went — the agent was told to do something else. What
            you choose here applies from now on.
          </div>
        </div>
      )}
    </div>
  )
}
