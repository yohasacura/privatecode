import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { BookOpen, Bot, Brain, FolderOpen, Pencil, Plus } from 'lucide-preact'
import type { AgentsListResult, MemoryListResult, SkillsListResult } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { PanelEmpty, PanelError, PanelLoading, PanelRow } from '../components/panel'
import { CopyablePath, SettingHint, SettingLabel } from '../components/settings-bits'
import { Button, IconButton } from '../ui/button'
import { Chip } from '../ui/chip'
import { Input, Textarea } from '../ui/input'
import { Segmented } from '../ui/segmented'
import { FileEditor } from './file-editor'

/**
 * The skills and agents this workspace offers the model (docs/UI-REDESIGN-2026-09.md §8),
 * and — since the owner's ruling that the window must do everything the console does —
 * where they are made and edited: a new skill or agent from a template, SKILL.md and the
 * scripts beside it in the window's editor, the folder in Explorer for anything else.
 *
 * What the filesystem cannot answer is still the first job: whether a folder was PICKED UP,
 * and if not, why. A skill that loaded is invisible (the model simply knows to reach for
 * it) and one that failed to load is invisible in the same way.
 *
 * Bundled skills and a plugin's are shown but not edited here: the bundled ones are
 * rewritten on every update, a plugin's on every `update`. Copy one into your own folder
 * under the same name and it takes precedence.
 */

type Scope = 'project' | 'user'

export function Skills({ client }: { client: ProtocolClient }): VNode {
  const [data, setData] = useState<SkillsListResult | null>(null)
  const [agents, setAgents] = useState<AgentsListResult | null>(null)
  const [memory, setMemory] = useState<MemoryListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [creating, setCreating] = useState<'skill' | 'agent' | null>(null)

  const load = useCallback(() => {
    setError(null)
    Promise.all([client.call('skills.list', {}), client.call('agents.list', {}), client.call('memory.list', {})])
      .then(([s, a, m]) => { setData(s); setAgents(a); setMemory(m) })
      .catch((e: Error) => setError(e.message))
  }, [client])
  useEffect(load, [load])

  function openFolder(path: string): void {
    client.call('fs.openExternal', { path }).catch((e: Error) => setError(e.message))
  }

  if (error !== null && data === null) return <PanelError message={error} onRetry={load} />
  if (data === null || agents === null) return <PanelLoading what="Reading the skills and agents folders…" />

  const editable = (scope: string): boolean => scope === 'project' || scope === 'user'
  const dirOf = (path: string): string => path.replace(/[\\/][^\\/]+$/, '')

  return (
    <div data-skills="" class="font-ui">
      {error !== null && <PanelError message={error} onRetry={load} />}

      <div class="mb-1.5 flex items-center gap-2">
        <SettingLabel>Skills</SettingLabel>
        <Button size="sm" variant="ghost" class="ml-auto" icon={<Plus />} onClick={() => setCreating(creating === 'skill' ? null : 'skill')} data-action="skill-new">
          New skill
        </Button>
      </div>
      {creating === 'skill' && (
        <CreateForm
          kind="skill"
          onCancel={() => setCreating(null)}
          onCreate={(name, scope, description) => client.call('skills.create', { name, scope, ...(description !== '' ? { description } : {}) })
            .then((r) => { setCreating(null); load(); setOpen(name); setEditing(r.path) })}
        />
      )}
      {data.skills.length === 0
        ? (
          <PanelEmpty
            icon={<Brain />}
            title="No skills yet"
            hint="A skill is a folder with a SKILL.md in it. New skill above writes one from a template, in either folder below."
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
            meta={<Chip>{s.plugin !== undefined ? `plugin · ${s.plugin}` : s.scope}</Chip>}
            actions={
              <>
                {editable(s.scope) && (
                  <IconButton size="sm" label="Edit SKILL.md" onClick={() => { setOpen(s.name); setEditing(s.path) }} data-action="skill-edit"><Pencil /></IconButton>
                )}
                <IconButton size="sm" label="Open the folder" onClick={() => openFolder(dirOf(s.path))} data-action="skill-folder"><FolderOpen /></IconButton>
              </>
            }
          >
            <div class="text-[12.5px] leading-[1.5] text-fg">{s.description}</div>
            <div class="mt-1.5"><CopyablePath path={s.path} /></div>
            {s.files.length > 0 && (
              <div class="mt-1 flex flex-wrap items-center gap-1 text-[11.5px] text-faint">
                <span>beside it:</span>
                {s.files.map((f) => editable(s.scope)
                  ? (
                    <button
                      key={f}
                      type="button"
                      class="rounded border border-border px-1 font-mono text-[11px] text-fg hover:bg-active"
                      title={`Edit ${f}`}
                      onClick={() => setEditing(`${dirOf(s.path)}\\${f}`)}
                      data-action="skill-file-edit"
                    >
                      {f}
                    </button>
                    )
                  : <code key={f}>{f}</code>)}
              </div>
            )}
            {!editable(s.scope) && (
              <div class="mt-1 text-[11.5px] text-faint">
                {s.scope === 'bundled' ? 'Ships with the app and is rewritten on update' : 'Belongs to its plugin and is rewritten on update'}; copy the folder into your own skills folder under the same name to change it.
              </div>
            )}
            {editing !== null && (editing === s.path || editing.startsWith(dirOf(s.path))) && (
              <FileEditor client={client} path={editing} onClose={() => setEditing(null)} onSaved={load} />
            )}
          </PanelRow>
        ))}
      {data.problems.map((p) => <PanelError key={p} message={p} />)}

      <div class="mb-1.5 mt-4 flex items-center gap-2">
        <SettingLabel>Agents</SettingLabel>
        <Button size="sm" variant="ghost" class="ml-auto" icon={<Plus />} onClick={() => setCreating(creating === 'agent' ? null : 'agent')} data-action="agent-new">
          New agent
        </Button>
      </div>
      {creating === 'agent' && (
        <CreateForm
          kind="agent"
          onCancel={() => setCreating(null)}
          onCreate={(name, scope, description) => client.call('agents.create', { name, scope, ...(description !== '' ? { description } : {}) })
            .then((r) => { setCreating(null); load(); setOpen(`agent:${name}`); setEditing(r.path) })}
        />
      )}
      {agents.agents.length === 0
        ? (
          <PanelEmpty
            icon={<Bot />}
            title="No agents of your own"
            hint="An agent is a markdown file with a description and a brief; the Agent tool offers it to the model by name. New agent above writes one from a template."
          />
        )
        : agents.agents.map((a) => (
          <PanelRow
            key={`${a.scope}/${a.name}`}
            open={open === `agent:${a.name}`}
            onToggle={() => setOpen(open === `agent:${a.name}` ? null : `agent:${a.name}`)}
            icon={<Bot />}
            label={a.name}
            mono
            meta={<Chip>{a.plugin !== undefined ? `plugin · ${a.plugin}` : a.scope}</Chip>}
            actions={a.path !== undefined && editable(a.scope)
              ? (
                <>
                  <IconButton size="sm" label="Edit the agent" onClick={() => { setOpen(`agent:${a.name}`); setEditing(a.path!) }} data-action="agent-edit"><Pencil /></IconButton>
                  <IconButton size="sm" label="Open the folder" onClick={() => openFolder(dirOf(a.path!))} data-action="agent-folder"><FolderOpen /></IconButton>
                </>
                )
              : undefined}
          >
            <div class="text-[12.5px] leading-[1.5] text-fg">{a.purpose}</div>
            {a.path !== undefined && <div class="mt-1.5"><CopyablePath path={a.path} /></div>}
            {editing !== null && editing === a.path && (
              <FileEditor client={client} path={editing} onClose={() => setEditing(null)} onSaved={load} />
            )}
          </PanelRow>
        ))}
      {agents.problems.map((p) => <PanelError key={p} message={p} />)}

      {/* The console's `/memory`: the AGENTS.md files and notes a session loads, editable
          here like everything else on this tab. */}
      <SettingLabel>Memory</SettingLabel>
      {memory === null || memory.layers.length === 0
        ? <div class="mb-2 text-[12px] text-faint" data-memory-empty="">No AGENTS.md or notes are loaded for this workspace. An <code>AGENTS.md</code> in the folder is read at the start of every session.</div>
        : memory.layers.map((l) => (
          <PanelRow
            key={l.path}
            open={open === `memory:${l.path}`}
            onToggle={() => setOpen(open === `memory:${l.path}` ? null : `memory:${l.path}`)}
            icon={<BookOpen />}
            label={l.path.replace(/^.*[\\/]/, '')}
            mono
            meta={<Chip>{l.scope}{l.truncated ? ' · truncated' : ''}</Chip>}
            actions={
              <>
                <IconButton size="sm" label="Edit" onClick={() => { setOpen(`memory:${l.path}`); setEditing(l.path) }} data-action="memory-edit"><Pencil /></IconButton>
                <IconButton size="sm" label="Open the folder" onClick={() => openFolder(dirOf(l.path))} data-action="memory-folder"><FolderOpen /></IconButton>
              </>
            }
          >
            <div class="text-[12px] text-faint">{l.bytes} bytes{l.truncated ? ' — longer than the budget for this scope; the model sees the first part' : ''}</div>
            <div class="mt-1.5"><CopyablePath path={l.path} /></div>
            {editing === l.path && <FileEditor client={client} path={editing} onClose={() => setEditing(null)} onSaved={load} />}
          </PanelRow>
        ))}

      <SettingLabel>Read from</SettingLabel>
      <div class="flex flex-col gap-1">
        {data.dirs.map((d) => <CopyablePath key={d.path} label={`skills · ${d.scope}`} path={d.path} />)}
        {agents.dirs.map((d) => <CopyablePath key={d.path} label={`agents · ${d.scope}`} path={d.path} />)}
      </div>
      <SettingHint>
        This is what is on disk now. The running session uses the catalogue it started with,
        so a NEW skill or agent — or a changed description — reaches the model on New session.
        A change to a skill's steps applies immediately, because the body is read each time it
        is used. The model can make and edit these too when asked: everything in
        <code>.privatecode</code> except <code>state</code> is open to it, and the settings
        file asks first. The bundled skills (skill-creator, grill-me, mermaid, pptx) ship with
        the app; a skill of the same name in your own folder replaces one. Every skill is also
        a slash command.
      </SettingHint>
    </div>
  )
}

function CreateForm({ kind, onCancel, onCreate }: {
  kind: 'skill' | 'agent'
  onCancel: () => void
  onCreate: (name: string, scope: Scope, description: string) => Promise<void>
}): VNode {
  const [name, setName] = useState('')
  const [scope, setScope] = useState<Scope>('project')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)

  function submit(): void {
    if (!valid) return
    setBusy(true)
    setError(null)
    onCreate(name, scope, description.trim())
      .catch((e: Error) => { setError(e.message); setBusy(false) })
  }

  return (
    <div data-create={kind} class="mb-2 flex flex-col gap-2 rounded-md border border-border bg-panel p-2.5">
      <div class="flex flex-wrap items-center gap-2">
        <Input
          class="min-w-[180px] flex-1 font-mono"
          placeholder={kind === 'skill' ? 'skill-name' : 'agent-name'}
          value={name}
          onInput={(e) => setName(e.currentTarget.value.trim().toLowerCase())}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          aria-label={`${kind} name`}
        />
        <Segmented
          size="sm"
          label="Where it lives"
          options={[
            { value: 'project', label: 'This project', hint: '.privatecode/ of this workspace' },
            { value: 'user', label: 'Every workspace', hint: 'your PrivateCode folder under AppData' },
          ]}
          value={scope}
          onChange={(v) => setScope(v as Scope)}
        />
      </div>
      <Textarea
        class="min-h-[52px] text-[12.5px]"
        placeholder={kind === 'skill' ? 'One or two sentences: what it is for and when the model should use it' : 'One line: what this agent is for'}
        value={description}
        onInput={(e) => setDescription(e.currentTarget.value)}
        aria-label={`${kind} description`}
      />
      {error !== null && <PanelError message={error} />}
      <div class="flex items-center gap-2">
        <span class="min-w-0 flex-1 text-[11.5px] text-faint">
          {name !== '' && !valid ? 'lowercase letters, digits and dashes; starts with a letter or digit' : ''}
        </span>
        <Button size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!valid || busy} loading={busy} onClick={submit} data-action={`${kind}-create`}>
          Create and edit
        </Button>
      </div>
    </div>
  )
}
