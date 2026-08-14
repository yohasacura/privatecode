import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { SkillsListResult } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { PanelEmpty, PanelError, PanelRow } from '../components/panel'
import { Icon } from '../components/icons'

/**
 * The skills this workspace offers the model.
 *
 * Read-only on purpose: a skill is a folder with a markdown file in it, and the thing that
 * edits markdown well is already on this machine. What the window owes is the answer the
 * filesystem cannot give — whether the folder was PICKED UP, and if not, why. A skill that
 * loaded is invisible (the model simply knows to reach for it) and a skill that failed to
 * load is invisible in exactly the same way, which is the whole reason this screen exists.
 *
 * The same gap `/memory` fills in the REPL, and the reason the empty state prints both
 * folder paths rather than a sentence about where skills live.
 */

export function Skills({ client }: { client: ProtocolClient }): VNode {
  const [data, setData] = useState<SkillsListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    client.call('skills.list', {})
      .then(setData)
      .catch((e: Error) => setError(e.message))
  }, [client])
  useEffect(load, [load])

  if (error !== null) return <PanelError message={error} onRetry={load} />
  // The same phrasing and the same class the Permissions tab uses while it reads its files:
  // two screens in one modal answering "am I waiting or is it empty" differently would be a
  // difference with no reason behind it.
  if (data === null) return <div class="field-hint">Reading the skills folders…</div>

  return (
    <div class="skills">
      {data.skills.length === 0
        ? (
          <PanelEmpty
            icon={Icon.brain()}
            title="No skills yet"
            hint="A skill is a folder with a SKILL.md in it. Create one in either folder below."
          />
        )
        : data.skills.map((s) => (
          <PanelRow
            key={`${s.scope}/${s.name}`}
            open={open === s.name}
            onToggle={() => setOpen(open === s.name ? null : s.name)}
            icon={Icon.brain()}
            label={s.name}
            mono
            meta={<span class="skills-scope">{s.scope}</span>}
          >
            <div class="skills-description">{s.description}</div>
            <div class="skills-path" title={s.path}>{s.path}</div>
            {s.files.length > 0 && (
              <div class="skills-files">bundled: {s.files.join(', ')}</div>
            )}
          </PanelRow>
        ))}

      {data.problems.map((p) => <div key={p} class="panel-error">{p}</div>)}

      <div class="field-label">Read from</div>
      {data.dirs.map((d) => (
        <div key={d.path} class="skills-dir">
          <span class="skills-scope">{d.scope}</span>
          <span class="skills-path" title={d.path}>{d.path}</span>
        </div>
      ))}
      <div class="field-hint">
        This is what is on disk now. The running session uses the catalogue it started with,
        so a NEW skill — or a changed description — reaches the model on New session. A
        change to a skill's steps applies immediately, because the body is read each time
        it is used. Both folders are local to this machine — <code>.privatecode</code> is
        git-ignored in full — so a skill you want on another machine has to be copied there.
      </div>
    </div>
  )
}
