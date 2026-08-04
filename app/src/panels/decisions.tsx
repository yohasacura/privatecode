import { useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { DecisionInfo } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { Icon } from '../components/icons'

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

  if (decision.kind === 'question') {
    return (
      <div class="decision">
        <div class="decision-head">
          <span class="decision-when">{whenOf(decision.at)}</span>
          <span class="decision-title">{decision.question}</span>
        </div>
        <div class="decision-actions">
          {(decision.options ?? []).map((option) => (
            <button key={option} class="btn" onClick={() => onResolve({ id: decision.id, answer: option })}>
              {option}
            </button>
          ))}
          <input
            class="input"
            value={answer}
            onInput={(e) => setAnswer(e.currentTarget.value)}
            placeholder="or type an answer"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && answer.trim() !== '') {
                onResolve({ id: decision.id, answer: answer.trim() })
              }
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div class="decision">
      <div class="decision-head">
        <span class="decision-when">{whenOf(decision.at)}</span>
        <span class="decision-title">{decision.summary}</span>
        <span class="card-tag">{decision.tool}</span>
      </div>
      <pre class="decision-detail">{decision.detail}</pre>
      <div class="decision-actions">
        {/* "Allow" here means "allow it NEXT time", and the note below says so. The call it
            came from is long gone. */}
        {rules.length > 0 && (
          <>
            <select class="select" value={rule} onChange={(e) => setRule(e.currentTarget.value)}>
              {rules.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select
              class="select"
              value={layer}
              onChange={(e) => setLayer(e.currentTarget.value as typeof layer)}
            >
              {LAYERS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
            <button
              class="btn btn-primary"
              onClick={() => onResolve({ id: decision.id, verdict: 'allow', rule: { rule, layer } })}
            >
              Allow from now on
            </button>
          </>
        )}
        <button class="btn" onClick={() => onResolve({ id: decision.id, verdict: 'deny' })}>Dismiss</button>
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
    <div class="card card-decisions">
      <button class="card-head decisions-head" onClick={() => setOpen(!open)}>
        <span class="card-icon card-icon-warn">{Icon.chat()}</span>
        <span class="card-title">
          {pending} question{pending === 1 ? '' : 's'} {pending === 1 ? 'was' : 'were'} parked while you were away
        </span>
        <span class="tool-toggle">{open ? Icon.chevronDown() : Icon.chevronRight()}</span>
      </button>
      {!open && (
        <div class="card-note">
          Answering them writes permission rules, so the next run does not stop on the same
          thing.
        </div>
      )}

      {open && (
        <div class="decisions-body">
          {error !== null && <div class="panel-error">{error}</div>}
          {decisions.map((d) => <OneDecision key={d.id} decision={d} onResolve={resolve} />)}
          <div class="card-note">
            These calls already came and went — the agent was told to do something else. What
            you choose here applies from now on.
          </div>
        </div>
      )}
    </div>
  )
}
