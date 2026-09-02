import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Download, Package, Puzzle, RefreshCw, Store } from 'lucide-preact'
import type { CatalogEntryView, PluginsCommandResult, PluginsListResult, PluginView } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { PanelEmpty, PanelError, PanelLoading, PanelNote, PanelRow } from '../components/panel'
import { CopyablePath, SettingHint, SettingLabel } from '../components/settings-bits'
import { Button } from '../ui/button'
import { Chip } from '../ui/chip'
import { Input } from '../ui/input'
import { Segmented } from '../ui/segmented'

/**
 * Plugins (docs/PLUGINS-2026-09.md, phase D): Claude Code's plugin system, with Claude
 * Code's commands behind every button.
 *
 * Three views. Installed — what this workspace has, on or off, and what each one adds.
 * Discover — the catalogs of the registered marketplaces, searchable, with an Install
 * button and a scope. Marketplaces — what is registered, what to add, and the two
 * catalogs worth one click. Every action runs the same `/plugin …` line the composer
 * accepts, and the host's report is shown verbatim: the tab is a front end to the
 * commands, not a second implementation of them, so a README written for Claude Code and
 * a click here do the same thing.
 */

type View = 'installed' | 'discover' | 'marketplaces'
type Scope = 'user' | 'project' | 'local'

type Run = (line: string) => Promise<PluginsCommandResult | null>

export function Plugins({ client }: { client: ProtocolClient }): VNode {
  const [view, setView] = useState<View>('installed')
  const [data, setData] = useState<PluginsListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [report, setReport] = useState<PluginsCommandResult | null>(null)
  const [scope, setScope] = useState<Scope>('user')

  const load = useCallback(() => {
    setError(null)
    client.call('plugins.list', {})
      .then(setData)
      .catch((e: Error) => setError(e.message))
  }, [client])
  useEffect(load, [load])

  const run = useCallback<Run>((line) => {
    setBusy(line)
    setReport(null)
    return client.call('plugins.command', { line })
      .then((r) => { setReport(r); load(); return r })
      .catch((e: Error) => { setReport({ ok: false, text: e.message, changed: false }); return null })
      .finally(() => setBusy(null))
  }, [client, load])

  if (error !== null) return <PanelError message={error} onRetry={load} />
  if (data === null) return <PanelLoading what="Reading the plugin store…" />

  const installedLabel = data.plugins.length > 0 ? `Installed (${data.plugins.length})` : 'Installed'
  return (
    <div data-plugins="" class="font-ui">
      <div class="flex items-center gap-2">
        <Segmented
          label="Plugins view"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'installed', label: installedLabel },
            { value: 'discover', label: 'Discover' },
            { value: 'marketplaces', label: 'Marketplaces' },
          ]}
        />
        <Button size="sm" variant="ghost" class="ml-auto" icon={<RefreshCw />} onClick={load} data-action="plugins-refresh">
          Refresh
        </Button>
      </div>

      {busy !== null && (
        <PanelNote class="mt-3" data-plugins-busy="">
          Running <code>{busy}</code>…
        </PanelNote>
      )}
      {report !== null && busy === null && (
        <PanelNote tone={report.ok ? 'good' : 'bad'} class="mt-3">
          <pre class="m-0 whitespace-pre-wrap font-mono text-[11.5px] leading-[1.5]" data-plugins-report="">{report.text}</pre>
        </PanelNote>
      )}

      {view === 'installed' && <Installed data={data} run={run} busy={busy !== null} />}
      {view === 'discover' && (
        <Discover client={client} data={data} run={run} busy={busy !== null} scope={scope} onScope={setScope} />
      )}
      {view === 'marketplaces' && <Marketplaces data={data} run={run} busy={busy !== null} />}

      <SettingLabel>The same commands as Claude Code</SettingLabel>
      <SettingHint>
        Every button here runs a <code>/plugin …</code> line you can also type in the composer:
        <code>/plugin marketplace add owner/repo</code>, <code>/plugin install name@marketplace</code>,
        <code>/plugin list</code>, <code>/reload-plugins</code>. A plugin's README written for Claude
        Code works as written. Plugins live in <code>{data.store}</code>.
      </SettingHint>
    </div>
  )
}

function whatItAdds(p: { skills: string[]; commands: string[]; agents: string[]; hooks: string[]; mcpServers: string[] }): string {
  const parts: string[] = []
  const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`
  if (p.skills.length > 0) parts.push(n(p.skills.length, 'skill'))
  if (p.commands.length > 0) parts.push(n(p.commands.length, 'command'))
  if (p.agents.length > 0) parts.push(n(p.agents.length, 'agent'))
  if (p.hooks.length > 0) parts.push(n(p.hooks.length, 'hook event'))
  if (p.mcpServers.length > 0) parts.push(n(p.mcpServers.length, 'MCP server'))
  return parts.length === 0 ? 'nothing PrivateCode can use' : parts.join(', ')
}

function Installed({ data, run, busy }: { data: PluginsListResult; run: Run; busy: boolean }): VNode {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div class="mt-3" data-plugins-installed="">
      {data.plugins.length === 0
        ? (
          <PanelEmpty
            icon={<Puzzle />}
            title="No plugins installed"
            hint="Discover lists what the registered marketplaces offer. Or type /plugin install name@marketplace in the composer."
          />
        )
        : data.plugins.map((p) => (
          <PluginRow key={p.id} plugin={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} run={run} busy={busy} />
        ))}

      {data.declared.map((d) => (
        <PanelNote key={d.id} tone="warn" class="mt-2">
          <div class="font-medium">{d.id} is enabled but not installed</div>
          <div class="text-[12px]">Named in <code>{d.from}</code>.</div>
          <div class="mt-1.5">
            <Button size="sm" icon={<Download />} disabled={busy} onClick={() => void run(`/plugin install ${d.id}`)} data-action="plugins-install-declared">
              Install {d.id}
            </Button>
          </div>
        </PanelNote>
      ))}

      {data.problems.length > 0 && (
        <>
          <SettingLabel>Problems</SettingLabel>
          <div class="flex flex-col gap-1" data-plugins-problems="">
            {data.problems.map((p) => <PanelError key={p} message={p} />)}
          </div>
        </>
      )}
    </div>
  )
}

function PluginRow({ plugin: p, open, onToggle, run, busy }: {
  plugin: PluginView; open: boolean; onToggle: () => void; run: Run; busy: boolean
}): VNode {
  return (
    <PanelRow
      open={open}
      onToggle={onToggle}
      icon={<Package />}
      label={p.id}
      mono
      {...(p.problems.length > 0 ? { tone: 'bad' as const } : {})}
      meta={(
        <>
          <Chip>{p.version}</Chip>
          <Chip>{p.enabled ? 'enabled' : 'disabled'}</Chip>
          {p.scopes.map((s) => <Chip key={s}>{s}</Chip>)}
        </>
      )}
      actions={(
        <>
          <Button size="sm" disabled={busy} onClick={() => void run(`/plugin ${p.enabled ? 'disable' : 'enable'} ${p.id}`)} data-action={p.enabled ? 'plugin-disable' : 'plugin-enable'}>
            {p.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(`/plugin update ${p.id}`)} data-action="plugin-update">
            Update
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(`/plugin uninstall ${p.id}`)} data-action="plugin-uninstall">
            Uninstall
          </Button>
        </>
      )}
    >
      {p.description !== undefined && <div class="text-[12.5px] leading-[1.5] text-fg">{p.description}</div>}
      <div class="mt-1.5 text-[12px] text-dim">Adds {whatItAdds(p)}.</div>
      {p.skills.length > 0 && <div class="mt-1 text-[11.5px] text-faint">skills: {p.skills.map((s) => `/${p.name}:${s}`).join(', ')}</div>}
      {p.commands.length > 0 && <div class="mt-1 text-[11.5px] text-faint">commands: {p.commands.map((c) => `/${p.name}:${c}`).join(', ')}</div>}
      {p.agents.length > 0 && <div class="mt-1 text-[11.5px] text-faint">agents: {p.agents.map((a) => `${p.name}:${a}`).join(', ')}</div>}
      {p.hooks.length > 0 && <div class="mt-1 text-[11.5px] text-faint">hooks: {p.hooks.join(', ')} — these run commands on this machine</div>}
      {p.mcpServers.length > 0 && <div class="mt-1 text-[11.5px] text-faint">MCP servers: {p.mcpServers.join(', ')} — these are processes on this machine</div>}
      <div class="mt-1.5"><CopyablePath path={p.installPath} /></div>
      {p.decidedBy !== null && <div class="mt-1 text-[11.5px] text-faint">enabled state from {p.decidedBy}</div>}
      {p.problems.map((problem) => <PanelError key={problem} message={problem} />)}
    </PanelRow>
  )
}

function Discover({ client, data, run, busy, scope, onScope }: {
  client: ProtocolClient; data: PluginsListResult; run: Run; busy: boolean; scope: Scope; onScope: (s: Scope) => void
}): VNode {
  const [entries, setEntries] = useState<CatalogEntryView[] | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [marketplace, setMarketplace] = useState<string>('all')
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback((refresh = false) => {
    setError(null)
    setEntries(null)
    client.call('plugins.catalog', refresh ? { refresh: true } : {})
      .then((r) => { setEntries(r.entries); setProblems(r.problems) })
      .catch((e: Error) => setError(e.message))
  }, [client])
  useEffect(() => { load() }, [load, data.plugins.length])

  const installed = useMemo(() => new Map(data.plugins.map((p) => [p.id, p])), [data.plugins])
  const shown = useMemo(() => {
    if (entries === null) return []
    const q = query.trim().toLowerCase()
    return entries.filter((e) => (marketplace === 'all' || e.marketplace === marketplace) &&
      (q === '' || `${e.id} ${e.description} ${e.category ?? ''} ${e.keywords.join(' ')}`.toLowerCase().includes(q)))
  }, [entries, query, marketplace])

  return (
    <div class="mt-3" data-plugins-discover="">
      <div class="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search plugins"
          value={query}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          class="min-w-[180px] flex-1"
          data-plugins-search=""
        />
        <Segmented
          label="Install scope"
          size="sm"
          value={scope}
          onChange={onScope}
          options={[
            { value: 'user', label: 'User', hint: 'Every workspace on this machine' },
            { value: 'project', label: 'Project', hint: 'This workspace, in .privatecode/settings.json' },
            { value: 'local', label: 'Local', hint: 'This workspace, in settings.local.json' },
          ]}
        />
        <Button size="sm" variant="ghost" icon={<RefreshCw />} disabled={busy} onClick={() => load(true)} data-action="plugins-catalog-refresh">
          Refresh catalogs
        </Button>
      </div>
      {data.marketplaces.length > 1 && (
        <div class="mt-2 flex flex-wrap gap-1" data-plugins-marketplace-filter="">
          {['all', ...data.marketplaces.map((m) => m.name)].map((name) => (
            <button
              key={name}
              type="button"
              class={`rounded-md border px-2 py-0.5 text-[11.5px] ${marketplace === name ? 'border-accent text-accent' : 'border-border text-dim hover:text-fg'}`}
              aria-pressed={marketplace === name}
              onClick={() => setMarketplace(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {error !== null && <PanelError message={error} onRetry={() => load()} />}
      {error === null && entries === null && <PanelLoading what="Fetching the catalogs — the bundled ones are cloned on first use…" />}
      {entries !== null && shown.length === 0 && (
        <PanelEmpty icon={<Store />} title={entries.length === 0 ? 'No catalog fetched yet' : 'Nothing matches'} hint={entries.length === 0 ? 'Add a marketplace, or refresh.' : 'Try another word.'} />
      )}
      {shown.slice(0, 200).map((e) => {
        const have = installed.get(e.id)
        return (
          <PanelRow
            key={e.id}
            open={open === e.id}
            onToggle={() => setOpen(open === e.id ? null : e.id)}
            icon={<Package />}
            label={e.id}
            mono
            meta={(
              <>
                {e.version !== undefined && <Chip>{e.version}</Chip>}
                {e.category !== undefined && <Chip>{e.category}</Chip>}
                {have !== undefined && <Chip>{have.enabled ? 'installed · enabled' : 'installed · disabled'}</Chip>}
              </>
            )}
            actions={have === undefined
              ? (
                <Button size="sm" icon={<Download />} disabled={busy} onClick={() => void run(`/plugin install ${e.id} --scope ${scope}`)} data-action="plugin-install">
                  Install
                </Button>
              )
              : (
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(`/plugin uninstall ${e.id}`)} data-action="plugin-uninstall">
                  Uninstall
                </Button>
              )}
          >
            <div class="text-[12.5px] leading-[1.5] text-fg">{e.description === '' ? 'No description in the catalog.' : e.description}</div>
            <div class="mt-1 text-[11.5px] text-faint">
              from {e.source}{e.author !== undefined ? ` · by ${e.author}` : ''}{e.keywords.length > 0 ? ` · ${e.keywords.join(', ')}` : ''}
            </div>
          </PanelRow>
        )
      })}
      {shown.length > 200 && <SettingHint>{shown.length - 200} more — narrow the search.</SettingHint>}
      {problems.map((p) => <PanelError key={p} message={p} />)}
    </div>
  )
}

function Marketplaces({ data, run, busy }: { data: PluginsListResult; run: Run; busy: boolean }): VNode {
  const [source, setSource] = useState('')
  const add = (): void => {
    const text = source.trim()
    if (text === '') return
    void run(`/plugin marketplace add ${text}`).then((r) => { if (r?.ok === true) setSource('') })
  }
  return (
    <div class="mt-3" data-plugins-marketplaces="">
      <div class="flex items-center gap-2">
        <Input
          placeholder="owner/repo, a git URL, a marketplace.json URL, or a folder"
          value={source}
          onInput={(e) => setSource((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          class="flex-1"
          data-plugins-add-marketplace=""
        />
        <Button size="sm" variant="primary" disabled={busy || source.trim() === ''} onClick={add} data-action="marketplace-add">
          Add marketplace
        </Button>
      </div>

      <SettingLabel>Registered</SettingLabel>
      {data.marketplaces.length === 0 && <PanelEmpty icon={<Store />} title="No marketplaces" hint="Add one above." />}
      {data.marketplaces.map((m) => (
        <PanelRow
          key={m.name}
          icon={<Store />}
          label={m.name}
          mono
          meta={(
            <>
              {m.bundled && <Chip>bundled</Chip>}
              <Chip>{m.fetched ? `${m.plugins ?? 0} plugins` : 'not fetched yet'}</Chip>
            </>
          )}
          actions={(
            <>
              <Button size="sm" variant="ghost" icon={<RefreshCw />} disabled={busy} onClick={() => void run(`/plugin marketplace update ${m.name}`)} data-action="marketplace-update">
                {m.fetched ? 'Update' : 'Fetch'}
              </Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(`/plugin marketplace remove ${m.name}`)} data-action="marketplace-remove">
                Remove
              </Button>
            </>
          )}
          title={m.source}
        >
          <div class="text-[11.5px] text-faint">{m.source}{m.lastUpdated !== undefined ? ` · updated ${m.lastUpdated.slice(0, 10)}` : ''}</div>
        </PanelRow>
      ))}

      {data.suggested.length > 0 && (
        <>
          <SettingLabel>Worth adding</SettingLabel>
          {data.suggested.map((s) => (
            <PanelRow
              key={s.name}
              icon={<Store />}
              label={s.name}
              mono
              meta={<Chip>{s.source}</Chip>}
              actions={(
                <Button size="sm" icon={<Download />} disabled={busy} onClick={() => void run(`/plugin marketplace add ${s.source}`)} data-action="marketplace-add-suggested">
                  Add
                </Button>
              )}
            >
              <div class="text-[12px] text-dim">{s.why}</div>
            </PanelRow>
          ))}
          <SettingHint>
            Third-party catalogs, however popular, are never registered unasked. Anthropic's own four are
            registered for you and fetched the first time Discover opens.
          </SettingHint>
        </>
      )}
    </div>
  )
}
