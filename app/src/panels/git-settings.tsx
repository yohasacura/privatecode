import type { VNode } from 'preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import { Pencil, Plus, Trash2 } from 'lucide-preact'
import type { GitConfigKey, GitConfigResult, GitRemote, GitRepoView } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { PanelError, PanelLoading, PanelNote } from '../components/panel'
import { SettingSection } from '../components/settings-bits'
import { Button, IconButton } from '../ui/button'
import { Dialog } from '../ui/dialog'
import { Field, Input } from '../ui/input'
import { Select } from '../ui/select'
import { toast } from '../ui/toast'
import { TextDialog } from './git-dialogs'

/**
 * Git settings — the page Visual Studio puts under Git › Settings: the name and email
 * commits are signed with (global, and per repository), prune on fetch, rebase on pull,
 * the default branch for new repositories, the repository's remotes, and its ignore and
 * attributes files. Every value is read from and written to git's own configuration; the
 * window keeps nothing of its own.
 */

const PRUNE: Array<{ value: string; label: string }> = [{ value: '', label: 'Unset (git\'s default: keep them)' }, { value: 'true', label: 'True — prune (recommended)' }, { value: 'false', label: 'False' }]
const REBASE: Array<{ value: string; label: string }> = [{ value: '', label: 'Unset (merge)' }, { value: 'true', label: 'True — rebase' }, { value: 'false', label: 'False — merge' }, { value: 'merges', label: 'Merges — rebase, keeping local merge commits' }]
const STARTER_IGNORES = ['.privatecode/state/', 'node_modules/', 'bin/', 'obj/', '.vs/', '*.user', '.DS_Store', 'Thumbs.db']

type Dialog =
  | { kind: 'remote-add' }
  | { kind: 'remote-url'; remote: GitRemote }
  | { kind: 'remote-rename'; remote: GitRemote }

export function GitSettings({ client }: { client: ProtocolClient }): VNode {
  const [repos, setRepos] = useState<GitRepoView[] | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [config, setConfig] = useState<GitConfigResult | null>(null)
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [failed, setFailed] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})

  useEffect(() => {
    client.call('git.status', {})
      .then((r) => { setRepos(r.repos); setRoot((current) => current ?? r.repos[0]?.root ?? null) })
      .catch((e: Error) => setFailed(e.message))
  }, [client])

  const load = useCallback(() => {
    if (root === null) return
    Promise.all([client.call('git.config', { root }), client.call('git.remotes', { root })])
      .then(([c, r]) => { setConfig(c); setRemotes(r.remotes); setDraft({}) })
      .catch((e: Error) => setFailed(e.message))
  }, [client, root])
  useEffect(() => { load() }, [load])

  if (failed !== null) return <PanelError message={failed} onRetry={load} />
  if (repos === null) return <PanelLoading what="reading git configuration…" />
  if (root === null || config === null) {
    return <PanelNote inset>No git repository is open in this workspace. Create one on the Git tab first.</PanelNote>
  }
  // Narrowed once for the closures below, which TypeScript cannot narrow through.
  const repoRoot: string = root

  const key = (scope: 'global' | 'local', k: GitConfigKey): string => `${scope}:${k}`
  const value = (scope: 'global' | 'local', k: GitConfigKey): string => draft[key(scope, k)] ?? config[scope][k] ?? ''
  const edit = (scope: 'global' | 'local', k: GitConfigKey, v: string): void => setDraft((d) => ({ ...d, [key(scope, k)]: v }))
  const dirty = (scope: 'global' | 'local', k: GitConfigKey): boolean => draft[key(scope, k)] !== undefined && draft[key(scope, k)] !== (config[scope][k] ?? '')

  async function save(scope: 'global' | 'local', k: GitConfigKey): Promise<void> {
    const v = value(scope, k)
    try {
      const r = await client.call('git.configSet', { root: repoRoot, scope, key: k, value: v === '' ? null : v })
      if (!r.ok) toast.push({ title: 'Git refused the setting', description: r.problem ?? '', tone: 'error' })
      else toast.push({ title: `${k} saved (${scope})`, tone: 'success' })
    } catch (e) {
      toast.push({ title: 'Could not save', description: (e as Error).message, tone: 'error' })
    } finally {
      load()
    }
  }
  async function remoteAction(label: string, call: () => Promise<{ ok: boolean; problem?: string }>): Promise<boolean> {
    try {
      const r = await call()
      if (!r.ok) { toast.push({ title: `${label} failed`, description: r.problem ?? '', tone: 'error' }); return false }
      toast.push({ title: label, tone: 'success' })
      return true
    } catch (e) {
      toast.push({ title: `${label} failed`, description: (e as Error).message, tone: 'error' })
      return false
    } finally {
      load()
    }
  }

  const textRow = (scope: 'global' | 'local', k: GitConfigKey, label: string, placeholder: string): VNode => (
    <div class="flex items-end gap-2" data-git-setting={key(scope, k)}>
      <div class="flex-1">
        <Field label={label} {...(scope === 'local' && config.global[k] !== undefined && config.local[k] === undefined ? { hint: `inherits "${config.global[k]}" from the global settings` } : {})}>
          <Input value={value(scope, k)} placeholder={placeholder} onInput={(e) => edit(scope, k, e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && dirty(scope, k)) void save(scope, k) }} />
        </Field>
      </div>
      <Button size="sm" disabled={!dirty(scope, k)} onClick={() => { void save(scope, k) }}>Save</Button>
    </div>
  )
  const choiceRow = (scope: 'global' | 'local', k: GitConfigKey, label: string, options: Array<{ value: string; label: string }>, hint: string): VNode => (
    <Field label={label} hint={hint}>
      <Select value={value(scope, k)} onChange={(e) => { edit(scope, k, e.currentTarget.value); void client.call('git.configSet', { root: repoRoot, scope, key: k, value: e.currentTarget.value === '' ? null : e.currentTarget.value }).then(load) }} data-git-setting={key(scope, k)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </Field>
  )

  return (
    <div class="flex flex-col" data-panel="git-settings">
      {repos.length > 1 && (
        <SettingSection title="Repository" description="The repository the per-repository settings below belong to.">
          <Select value={root} onChange={(e) => setRoot(e.currentTarget.value)}>
            {repos.map((r) => <option key={r.root} value={r.root}>{r.label}</option>)}
          </Select>
        </SettingSection>
      )}
      <SettingSection title="Git global settings" description="Apply to every repository on this machine — git's user-level configuration.">
        {textRow('global', 'user.name', 'User name', 'Your name, as it appears on commits')}
        {textRow('global', 'user.email', 'Email', 'you@example.com')}
        {textRow('global', 'init.defaultBranch', 'Default branch name', 'main')}
        {choiceRow('global', 'fetch.prune', 'Prune remote branches during fetch', PRUNE, 'Removes remote-tracking branches that no longer exist on the remote.')}
        {choiceRow('global', 'pull.rebase', 'Rebase local branch when pulling', REBASE, 'How a pull combines the remote\'s commits with yours.')}
      </SettingSection>
      <SettingSection title="Git repository settings" description={`Only for ${repos.find((r) => r.root === root)?.label ?? 'this repository'}. A value here overrides the global one.`}>
        {textRow('local', 'user.name', 'User name', config.global['user.name'] ?? 'inherits the global name')}
        {textRow('local', 'user.email', 'Email', config.global['user.email'] ?? 'inherits the global email')}
        {choiceRow('local', 'fetch.prune', 'Prune remote branches during fetch', PRUNE, 'Unset here means the global setting applies.')}
        {choiceRow('local', 'pull.rebase', 'Rebase local branch when pulling', REBASE, 'Unset here means the global setting applies.')}
      </SettingSection>
      <SettingSection title="Remotes" description="Where this repository fetches from and pushes to.">
        {remotes.length === 0 && <div class="text-[12px] text-faint">No remotes. Add one to push this repository anywhere.</div>}
        {remotes.map((r) => (
          <div key={r.name} class="flex items-center gap-2 rounded-md border border-border-soft px-2.5 py-1.5 text-[12.5px]" data-remote={r.name}>
            <span class="w-[90px] shrink-0 truncate font-medium" title={r.name}>{r.name}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-dim" title={r.pushUrl !== r.fetchUrl ? `fetch ${r.fetchUrl}\npush ${r.pushUrl}` : r.fetchUrl}>{r.fetchUrl}</span>
            <IconButton size="sm" label="Change URL" onClick={() => setDialog({ kind: 'remote-url', remote: r })}><Pencil /></IconButton>
            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'remote-rename', remote: r })}>Rename</Button>
            <IconButton size="sm" label="Remove remote" onClick={() => { void remoteAction(`Removed ${r.name}`, () => client.call('git.remoteRemove', { root: repoRoot, name: r.name })) }}><Trash2 /></IconButton>
          </div>
        ))}
        <div><Button size="sm" icon={<Plus />} onClick={() => setDialog({ kind: 'remote-add' })} data-action="remote-add">Add remote</Button></div>
      </SettingSection>
      <SettingSection title="Git files" description="The repository's ignore and attributes files, at its root.">
        <div class="flex items-center gap-2 text-[12.5px]">
          <span class="w-[130px]">.gitignore</span>
          {config.hasIgnoreFile
            ? <span class="text-faint">present — edit it from the file tree</span>
            : <Button size="sm" onClick={() => { void (async () => { for (const p of STARTER_IGNORES) await client.call('git.ignore', { root: repoRoot, pattern: p }); toast.push({ title: '.gitignore added', description: STARTER_IGNORES.join(', '), tone: 'success' }); load() })() }} data-action="add-gitignore">Add .gitignore</Button>}
        </div>
        <div class="flex items-center gap-2 text-[12.5px]">
          <span class="w-[130px]">.gitattributes</span>
          <span class="text-faint">{config.hasAttributesFile ? 'present — edit it from the file tree' : 'none — create one from the file tree when line endings or diff rules need it'}</span>
        </div>
      </SettingSection>

      {dialog?.kind === 'remote-add' && (
        <RemoteAddDialog onClose={() => setDialog(null)} onAdd={(name, url) => remoteAction(`Added ${name}`, () => client.call('git.remoteAdd', { root: repoRoot, name, url }))} />
      )}
      {dialog?.kind === 'remote-url' && (
        <TextDialog open onClose={() => setDialog(null)} title={`URL of ${dialog.remote.name}`} label="URL" initial={dialog.remote.fetchUrl} confirmLabel="Save" onSubmit={(url) => remoteAction(`${dialog.remote.name} re-pointed`, () => client.call('git.remoteSetUrl', { root: repoRoot, name: dialog.remote.name, url }))} />
      )}
      {dialog?.kind === 'remote-rename' && (
        <TextDialog open onClose={() => setDialog(null)} title={`Rename ${dialog.remote.name}`} label="New name" initial={dialog.remote.name} confirmLabel="Rename" onSubmit={(name) => remoteAction(`Renamed to ${name}`, () => client.call('git.remoteRename', { root: repoRoot, name: dialog.remote.name, newName: name }))} />
      )}
    </div>
  )
}

function RemoteAddDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (name: string, url: string) => Promise<boolean> }): VNode {
  const [name, setName] = useState('origin')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const valid = /^[\w.-]+$/.test(name) && url.trim() !== ''
  const submit = (): void => {
    if (!valid || busy) return
    setBusy(true)
    void onAdd(name, url.trim()).then((ok) => { if (ok) onClose() }).finally(() => setBusy(false))
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a remote"
      description="The name is what pushes and pulls refer to; origin is the convention for the main one."
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!valid} loading={busy} data-action="remote-add-submit">Add</Button>
        </>
      }
    >
      <div class="flex flex-col gap-3" data-dialog="remote-add">
        <Field label="Name">
          <Input value={name} data-autofocus onInput={(e) => setName(e.currentTarget.value)} />
        </Field>
        <Field label="URL">
          <Input value={url} placeholder="https://github.com/you/project.git" onInput={(e) => setUrl(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
        </Field>
      </div>
    </Dialog>
  )
}
