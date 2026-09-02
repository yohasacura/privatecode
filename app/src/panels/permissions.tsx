import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Shield, TriangleAlert } from 'lucide-preact'
import type { AgentMode } from '@core/permissions/engine'
import type { PermissionLayerView, PermissionRuleView } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { PanelEmpty, PanelError, PanelLoading, PanelRow, PanelSection } from '../components/panel'
import { SettingHint, SettingLabel } from '../components/settings-bits'
import { Button } from '../ui/button'
import { Chip, type ChipTone } from '../ui/chip'
import { cn } from '../ui/cn'
import { Input } from '../ui/input'
import { Select } from '../ui/select'

/**
 * What the agent has standing permission to do, and how to take it back
 * (docs/UI-REDESIGN-2026-09.md §8 "Permissions").
 *
 * The window could GRANT a standing permission from two places — an approval card's "Allow
 * always" and the decision queue — and had nowhere to show what had been granted. So the one
 * subject a user most needs to audit, on a tool whose whole premise is that it runs on their
 * own machine, was the one thing the interface never displayed. You could open a door and
 * never see the list of open doors.
 *
 * Two things are shown, not one, because rules alone understate the answer badly: the MODE
 * grants far more than any rule does, and a screen that listed three `allow` entries while
 * autopilot was on would be describing a fraction of what is permitted.
 */

/** What each mode permits, in the terms the gate actually applies. Kept beside the list
 * because "you have granted 3 rules" and "the mode allows everything" are the same question
 * asked twice, and only one of them was ever answered. */
const MODE_SUMMARY: Record<AgentMode, { title: string; detail: string; tone?: 'warn' }> = {
  normal: {
    title: 'Asks before editing or running',
    detail: 'Reading is free. Every write and every command needs a decision from you, unless a rule below already covers it.',
  },
  plan: {
    title: 'Cannot change anything',
    detail: 'No editing tools are offered at all this session. The rules below are not consulted, because nothing they could permit is available.',
  },
  'auto-edit': {
    title: 'Edits freely, asks before running commands',
    detail: 'Writes inside the workspace go through without asking — unless a deny or ask rule below names them. Commands still stop for you.',
  },
  autopilot: {
    title: 'Acts without asking',
    detail: 'Writes and commands proceed unattended, inside the workspace. Deny and ask rules below STILL apply — a deny still blocks, an ask still parks a decision for you. Only the allow rules are redundant while this is on.',
    tone: 'warn',
  },
}

const SCOPE_LABEL: Record<PermissionLayerView['scope'], { title: string; detail: string }> = {
  user: { title: 'You', detail: 'Applies in every workspace on this machine.' },
  project: { title: 'This project', detail: 'Checked in with the project, so it applies for everyone who opens it.' },
  local: { title: 'This project, just you', detail: 'Your own overrides here; not shared.' },
}

const LIST_TONE: Record<PermissionRuleView['list'], { label: string; tone: ChipTone }> = {
  deny: { label: 'never', tone: 'red' },
  ask: { label: 'always ask', tone: 'yellow' },
  allow: { label: 'allowed', tone: 'green' },
}

export function Permissions({ client, liveMode }: {
  client: ProtocolClient
  /** The mode as the WINDOW knows it, which updates the moment it is switched — including
   * from the Ctrl+K palette while this dialog is open. The fetched mode is a snapshot from
   * when the panel mounted, and the palette renders over the dialog, so the snapshot can go
   * stale while the block built to describe the mode is on screen. */
  liveMode?: AgentMode
}): VNode {
  const [layers, setLayers] = useState<PermissionLayerView[] | null>(null)
  const [mode, setMode] = useState<AgentMode>('normal')
  const [problems, setProblems] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  /** The rule currently being withdrawn, so its own row can say so rather than the whole
   * list flickering through a loading state for one click. */
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    client.call('permissions.list', {})
      .then((r) => { setLayers(r.layers); setMode(r.mode); setProblems(r.problems) })
      .catch((e: Error) => setError(e.message))
  }, [client])

  useEffect(load, [load])

  function revoke(layer: PermissionLayerView, rule: PermissionRuleView): void {
    const key = `${layer.scope}:${rule.list}:${rule.rule}`
    setBusy(key)
    client.call('permissions.remove', { scope: layer.scope, list: rule.list, rule: rule.rule })
      .then((r) => {
        // A rule that was already gone is not an error, but it is not nothing either: the
        // file was edited by hand or by another window, so the list on screen is stale and
        // re-reading is the honest response to that, not a silent tick.
        if (!r.removed) setError('That rule was already gone — the settings file changed underneath this list.')
        load()
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null))
  }

  /** The add-rule form. Rules could be granted from an approval card and revoked from this
   * list, and never simply WRITTEN — which is the thing "configuring permissions" means.
   * The written rule reaches the live engine in the same call (`engine.adopt`), so a deny
   * typed here protects the session it was typed into, not the next one. */
  const [newRule, setNewRule] = useState('')
  const [newList, setNewList] = useState<'allow' | 'ask' | 'deny'>('deny')
  const [newScope, setNewScope] = useState<'user' | 'project' | 'local'>('project')
  const [adding, setAdding] = useState(false)

  function addRule(): void {
    const rule = newRule.trim()
    if (rule === '') return
    setAdding(true)
    setError(null)
    client.call('permissions.add', { scope: newScope, list: newList, rule })
      .then((r) => {
        if (r.problem !== null) { setError(r.problem); return }
        setNewRule('')
        load()
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setAdding(false))
  }

  const summary = MODE_SUMMARY[liveMode ?? mode]
  const total = (layers ?? []).reduce((n, l) => n + l.rules.length, 0)

  return (
    <div data-permissions="" class="font-ui">
      <div
        data-mode-summary=""
        class={cn(
          'flex items-start gap-2.5 rounded-md border px-3 py-2.5',
          summary.tone === 'warn' ? 'border-red-line bg-red-soft' : 'border-border-soft bg-raised',
        )}
      >
        <span class={cn('mt-0.5 inline-flex shrink-0 [&>svg]:size-4', summary.tone === 'warn' ? 'text-red' : 'text-accent')} aria-hidden="true">
          {summary.tone === 'warn' ? <TriangleAlert /> : <Shield />}
        </span>
        <div class="min-w-0">
          <div class="text-[13px] font-semibold text-fg">{summary.title}</div>
          <div class="mt-0.5 text-[12px] leading-[1.5] text-dim">{summary.detail}</div>
        </div>
      </div>

      {problems.map((p) => <PanelError key={p} message={p} />)}
      {error !== null && <PanelError message={error} onRetry={load} />}

      {layers === null
        ? <PanelLoading what="Reading the settings files…" />
        : total === 0
        ? (
          <PanelEmpty
            icon={<Shield />}
            title="Nothing has been granted standing permission"
            hint="Choosing “Allow always” on a request, or answering one in the decision queue, adds a rule here."
          />
          )
        : layers.filter((l) => l.rules.length > 0).map((layer) => (
          <PanelSection key={layer.scope} title={SCOPE_LABEL[layer.scope].title} subtitle={layer.path}>
            <div class="px-2.5 pb-1 text-[11.5px] text-faint">{SCOPE_LABEL[layer.scope].detail}</div>
            {layer.rules.map((rule) => {
              const key = `${layer.scope}:${rule.list}:${rule.rule}`
              return (
                <PanelRow
                  key={key}
                  mono
                  label={rule.rule}
                  title={rule.rule}
                  meta={<Chip tone={LIST_TONE[rule.list].tone}>{LIST_TONE[rule.list].label}</Chip>}
                  actions={
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === key}
                      loading={busy === key}
                      onClick={() => revoke(layer, rule)}
                      data-action="revoke"
                      title={rule.list === 'deny' ? 'Lift this restriction' : 'Withdraw this permission'}
                    >
                      {rule.list === 'deny' ? 'Lift' : 'Revoke'}
                    </Button>
                  }
                />
              )
            })}
          </PanelSection>
        ))}

      <SettingLabel>Add a rule</SettingLabel>
      <div class="flex flex-wrap items-center gap-1.5" data-add-rule="">
        <Select
          class="h-7"
          value={newList}
          aria-label="What the rule does"
          onChange={(e) => setNewList(e.currentTarget.value as 'allow' | 'ask' | 'deny')}
          title="never = the agent may not do this, in any mode. always ask = stops for you every time. allowed = goes through without asking."
        >
          <option value="deny">never</option>
          <option value="ask">always ask</option>
          <option value="allow">allowed</option>
        </Select>
        <Input
          class="min-w-[200px] flex-1 font-mono text-[12px]"
          placeholder="run_command(npm publish:*) · edit_file(src/**)"
          aria-label="The rule"
          value={newRule}
          onInput={(e) => setNewRule(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addRule() }}
        />
        <Select
          class="h-7"
          value={newScope}
          aria-label="Which settings file it is written to"
          onChange={(e) => setNewScope(e.currentTarget.value as 'user' | 'project' | 'local')}
          title="Which settings file it is written to"
        >
          <option value="project">this project</option>
          <option value="local">project, just me</option>
          <option value="user">everywhere</option>
        </Select>
        <Button size="sm" disabled={adding || newRule.trim() === ''} loading={adding} onClick={addRule} data-action="add-rule">
          Add
        </Button>
      </div>
      <SettingHint>
        A rule is a tool name with an optional pattern: commands match by prefix
        (<code>run_command(git push:*)</code>), paths by glob (<code>edit_file(src/**)</code>).
        It applies immediately, this session included.
      </SettingHint>
    </div>
  )
}
