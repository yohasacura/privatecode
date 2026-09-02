import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Brain } from 'lucide-preact'
import type { SkillsListResult } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { PanelEmpty, PanelError, PanelLoading, PanelRow } from '../components/panel'
import { CopyablePath, SettingHint, SettingLabel } from '../components/settings-bits'
import { Chip } from '../ui/chip'

/**
 * The skills this workspace offers the model (docs/UI-REDESIGN-2026-09.md §8 "Skills").
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
  if (data === null) return <PanelLoading what="Reading the skills folders…" />

  return (
    <div data-skills="" class="font-ui">
      {data.skills.length === 0
        ? (
          <PanelEmpty
            icon={<Brain />}
            title="No skills yet"
            hint="A skill is a folder with a SKILL.md in it. Create one in either folder below."
          />
        )
        : data.skills.map((s) => (
          <PanelRow
            key={`${s.scope}/${s.name}`}
            open={open === s.name}
            onToggle={() => setOpen(open === s.name ? null : s.name)}
            icon={<Brain />}
            label={s.name}
            mono
            meta={<Chip>{s.scope}</Chip>}
          >
            <div class="text-[12.5px] leading-[1.5] text-fg">{s.description}</div>
            <div class="mt-1.5"><CopyablePath path={s.path} /></div>
            {s.files.length > 0 && (
              <div class="mt-1 text-[11.5px] text-faint">bundled: {s.files.join(', ')}</div>
            )}
          </PanelRow>
        ))}

      {data.problems.map((p) => <PanelError key={p} message={p} />)}

      <SettingLabel>Read from</SettingLabel>
      <div class="flex flex-col gap-1">
        {data.dirs.map((d) => <CopyablePath key={d.path} label={d.scope} path={d.path} />)}
      </div>
      <SettingHint>
        This is what is on disk now. The running session uses the catalogue it started with,
        so a NEW skill — or a changed description — reaches the model on New session. A
        change to a skill's steps applies immediately, because the body is read each time
        it is used. The user and project folders are local to this machine — <code>.privatecode</code> is
        git-ignored in full — so a skill you want on another machine has to be copied there.
        The bundled folder ships with the app (skill-creator, grill-me, mermaid, pptx); a
        skill of the same name in your own folder replaces it. Every skill is also a slash
        command: <code>/skill-creator</code>, <code>/grill-me</code>, <code>/mermaid</code>, <code>/pptx</code>.
      </SettingHint>
    </div>
  )
}
