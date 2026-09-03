import { useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Brain, Check, Database, Info, Palette, Plug, Puzzle, RefreshCw, Server, ShieldCheck } from 'lucide-preact'
import type { ProtocolClient } from '../lib/client'
import type { McpServerInfo } from '@core/host/protocol'
import type { AgentMode } from '@core/permissions/engine'
import type { MotionSetting, ThemeSetting } from '../lib/theme'
import type { SessionSwitch } from '../lib/session-switch'
import { PanelError, PanelNote } from '../components/panel'
import { SettingHint, SettingLabel, SettingSection } from '../components/settings-bits'
import { Button } from '../ui/button'
import { Chip } from '../ui/chip'
import { Dialog } from '../ui/dialog'
import { Input } from '../ui/input'
import { Segmented } from '../ui/segmented'
import { Switch } from '../ui/switch'
import { Tabs, tabPanelId, type TabItem } from '../ui/tabs'
import { Permissions } from './permissions'
import { McpEditor } from './mcp-editor'
import { EraseEverything } from './erase-data'
import { Skills } from './skills'
import { Plugins } from './plugins'

/**
 * Settings (docs/UI-REDESIGN-2026-09.md §8): a dialog with a tab list on the left and one
 * pane on the right. Tabs, because burial was measured: the permissions section existed at
 * the bottom of one long scroll, and the person it was built for reported not seeing it.
 * A section you have to already know about to find is not a section.
 */

export type SettingsTab = 'server' | 'appearance' | 'permissions' | 'skills' | 'plugins' | 'mcp' | 'data' | 'about'

export const SETTINGS_TABS: readonly TabItem<SettingsTab>[] = [
  { id: 'server', label: 'Server', icon: <Server /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette /> },
  { id: 'permissions', label: 'Permissions', icon: <ShieldCheck /> },
  { id: 'skills', label: 'Skills', icon: <Brain /> },
  { id: 'plugins', label: 'Plugins', icon: <Puzzle /> },
  { id: 'mcp', label: 'MCP servers', icon: <Plug /> },
  { id: 'data', label: 'Data', icon: <Database /> },
  { id: 'about', label: 'About', icon: <Info /> },
]

const GROUP = 'settings'

/**
 * The MCP servers this workspace configured, and what became of each.
 *
 * A server that silently contributes nothing is worse than one that fails loudly: the user
 * wrote it into a settings file and has every reason to believe its tools exist. The
 * failure reason is shown in full — it is usually a missing token or a command that is not
 * on PATH, both of which are one edit away from fixed once you can read them.
 *
 * Absent when nothing is configured, which is the normal case and deserves no chrome.
 */
function McpServers({ client }: { client: ProtocolClient }): VNode | null {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null)

  useEffect(() => {
    let cancelled = false
    client.call('status', {})
      .then((r) => { if (!cancelled) setServers(r.mcpServers ?? null) })
      .catch(() => { /* the dialog's job is the workspace; this is extra */ })
    return () => { cancelled = true }
  }, [client])

  if (servers === null || servers.length === 0) return null // the editor below covers the empty case
  return (
    <div data-mcp-servers="">
      <SettingLabel>MCP servers</SettingLabel>
      <div class="flex flex-col gap-1.5">
        {servers.map((s) => (
          <div key={s.name} class="rounded-md border border-border-soft bg-raised px-2.5 py-2 font-ui text-[12.5px]">
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate font-mono text-fg">{s.name}</span>
              <Chip tone={s.state === 'connected' ? 'green' : 'red'}>
                {s.state === 'connected' ? `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}` : 'failed'}
              </Chip>
            </div>
            {s.problem !== undefined && (
              <pre class="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-red-line bg-red-soft px-2 py-1.5 font-mono text-[11.5px] text-red">{s.problem}</pre>
            )}
          </div>
        ))}
      </div>
      <SettingHint>
        Configured under "mcpServers" in .privatecode/settings.json. Their tools ask for
        approval like everything else.
      </SettingHint>
    </div>
  )
}

type Probe =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'ok'; model: string | undefined; contextLength: number | undefined }
  | { kind: 'bad'; reason: string }

/** What is inside, for the About tab: the things a person may want to know they are running. */
const CREDITS: readonly { name: string; what: string; licence: string }[] = [
  { name: 'llama.cpp', what: 'runs the model, on this machine', licence: 'MIT' },
  { name: 'Git for Windows', what: 'bash and the coreutils the Bash tool runs', licence: 'GPL-3.0 / LGPL-3.0' },
  { name: 'Preact', what: 'the window', licence: 'MIT' },
  { name: 'Tailwind CSS', what: 'the styles', licence: 'MIT' },
  { name: 'Tauri', what: 'the shell', licence: 'MIT / Apache-2.0' },
  { name: 'Lucide', what: 'the icons', licence: 'ISC' },
  { name: 'marked', what: 'Markdown in the transcript', licence: 'MIT' },
  { name: 'Inter and JetBrains Mono', what: 'the two faces', licence: 'OFL-1.1' },
]

export function SettingsModal({
  client, onClose, onSessionSwitched, liveMode, themeSetting, onThemeChange,
  motionSetting, onMotionChange, ligatures, onLigaturesChange, initialTab = 'server', version, onCheckForUpdates,
}: {
  client: ProtocolClient
  /** See Permissions.liveMode. */
  liveMode?: AgentMode
  /** The window's theme setting and the way to change it; App owns the state. */
  themeSetting: ThemeSetting
  onThemeChange: (setting: ThemeSetting) => void
  motionSetting: MotionSetting
  onMotionChange: (setting: MotionSetting) => void
  ligatures: boolean
  onLigaturesChange: (on: boolean) => void
  /** Which tab to open on; the palette can ask for one by name. */
  initialTab?: SettingsTab
  /** The running version, or null when the shell has not said yet. */
  version: string | null
  onCheckForUpdates: () => void
  onClose: () => void
  /** Opening a workspace is the one moment its name and folder count can change, so they
   * ride this callback rather than every session switch. */
  onSessionSwitched: (
    info: SessionSwitch & { workspaceRoot: string; workspaceName: string; folderCount: number },
  ) => void
}): VNode {
  const [serverUrl, setServerUrl] = useState('http://127.0.0.1:8080')
  /** The CURRENT workspace, held invisibly: applying a server change re-opens it, and
   * the most recent entry is by definition the one that is open. */
  const [workspace, setWorkspace] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [probe, setProbe] = useState<Probe>({ kind: 'idle' })

  useEffect(() => {
    client.call('config.get', {})
      .then((r) => {
        if (r.serverUrl !== undefined) setServerUrl(r.serverUrl)
        if (r.recentWorkspaces[0]) setWorkspace(r.recentWorkspaces[0])
      })
      .catch(() => { /* host-side defaults already cover this */ })
  }, [client])

  // The live probe: what is at that URL, asked a moment after the typing stops.
  useEffect(() => {
    const url = serverUrl.trim()
    if (url === '') { setProbe({ kind: 'idle' }); return }
    let cancelled = false
    setProbe({ kind: 'probing' })
    const id = setTimeout(() => {
      client.call('server.probe', { serverUrl: url })
        .then((r) => {
          if (cancelled) return
          setProbe(r.reachable
            ? { kind: 'ok', model: r.model, contextLength: r.contextLength }
            : { kind: 'bad', reason: r.reason ?? 'nothing answered at that address' })
        })
        .catch((e: unknown) => { if (!cancelled) setProbe({ kind: 'bad', reason: e instanceof Error ? e.message : String(e) }) })
    }, 400)
    return () => { cancelled = true; clearTimeout(id) }
  }, [client, serverUrl])

  function connect(): void {
    const root = workspace.trim()
    const url = serverUrl.trim()
    if (root === '' || url === '') return
    setConnecting(true)
    setError(null)
    client.call('init', { workspaceRoot: root, serverUrl: url, continueLast: true })
      .then((r) => {
        client.call('config.set', { serverUrl: url, recentWorkspace: root }).catch(() => {})
        onSessionSwitched({
          sessionId: r.sessionId, mode: r.mode, gateMode: r.gateMode, contextLength: r.contextLength, title: r.title,
          problems: r.problems, items: r.items, workspaceRoot: root,
          workspaceName: r.workspaceName, folderCount: r.folderCount,
          contextUsed: r.contextUsed,
          // `session-switched` writes compactAt unguarded, so an undefined here would
          // replace a real trigger with the 80%-of-window fallback until the next step.done.
          ...(r.compactAt !== undefined ? { compactAt: r.compactAt } : {}),
        })
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setConnecting(false))
  }

  return (
    <Dialog open onClose={onClose} title="Settings" size="lg" class="h-[600px]">
      <div class="flex h-full min-h-0 gap-5">
        <Tabs
          group={GROUP}
          orientation="vertical"
          tabs={SETTINGS_TABS}
          active={tab}
          onChange={setTab}
          label="Settings sections"
          class="w-40 shrink-0"
        />
        <div
          role="tabpanel"
          id={tabPanelId(GROUP, tab)}
          aria-labelledby={`${GROUP}-tab-${tab}`}
          class="min-w-0 flex-1 overflow-auto pb-2 pr-1"
          data-settings-pane={tab}
        >
          {tab === 'server' && (
            <>
              <SettingLabel htmlFor="set-url">Model server</SettingLabel>
              <Input
                id="set-url"
                class="font-mono"
                value={serverUrl}
                onInput={(e) => setServerUrl(e.currentTarget.value)}
                placeholder="http://127.0.0.1:8080"
              />
              <div class="mt-1.5 flex items-center gap-2 font-ui text-[12px]" data-probe={probe.kind} aria-live="polite">
                {probe.kind === 'probing' && <span class="text-faint motion-safe:animate-pulse">asking…</span>}
                {probe.kind === 'ok' && (
                  <>
                    <Chip tone="green" icon={<Check />}>reachable</Chip>
                    <span class="min-w-0 truncate text-dim">
                      {probe.model ?? 'a model'}{probe.contextLength !== undefined ? ` · ${probe.contextLength.toLocaleString()} tokens of context` : ''}
                    </span>
                  </>
                )}
                {probe.kind === 'bad' && (
                  <>
                    <Chip tone="red">not reachable</Chip>
                    <span class="min-w-0 truncate text-dim" title={probe.reason}>{probe.reason}</span>
                  </>
                )}
              </div>
              <SettingHint>Your llama.cpp server. Nothing is ever sent anywhere else.</SettingHint>

              {error !== null && <PanelError message={error} />}

              <div class="mt-4">
                <Button
                  variant="primary"
                  disabled={connecting || workspace.trim() === '' || serverUrl.trim() === ''}
                  loading={connecting}
                  onClick={connect}
                  data-action="apply-server"
                >
                  Apply — re-open the workspace
                </Button>
                <SettingHint>
                  Changing the server means re-opening the workspace against it; the current
                  session is picked back up.
                </SettingHint>
              </div>
            </>
          )}

          {tab === 'appearance' && (
            <div data-appearance="">
              <SettingSection title="Theme" description="Dark and light, following Windows or your own choice.">
                <Segmented
                  label="Theme"
                  options={[
                    { value: 'system', label: 'System', hint: 'Follows Windows, and changes when Windows does' },
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' },
                  ]}
                  value={themeSetting}
                  onChange={onThemeChange}
                />
                <SettingHint class="mt-0">
                  {themeSetting === 'system'
                    ? 'Follows Windows, and changes when Windows does.'
                    : 'Stays this way whatever Windows is set to.'}
                </SettingHint>
              </SettingSection>

              <SettingSection title="Density" description="How much air the rows and the transcript get.">
                <Segmented
                  label="Density"
                  options={[
                    { value: 'comfortable', label: 'Comfortable' },
                    { value: 'compact', label: 'Compact', disabled: true, hint: 'Coming in a later release' },
                  ]}
                  value="comfortable"
                  onChange={() => {}}
                />
                <SettingHint class="mt-0">Compact comes later; comfortable is the one every screen was drawn in.</SettingHint>
              </SettingSection>

              <SettingSection title="Motion" description="Transitions and the small entrances overlays make.">
                <Segmented
                  label="Motion"
                  options={[
                    { value: 'system', label: 'Follow system', hint: 'Windows’ “show animations” setting decides' },
                    { value: 'reduce', label: 'Reduce', hint: 'No transitions, no entrances' },
                    { value: 'full', label: 'Full', hint: 'Animate even when Windows asks not to' },
                  ]}
                  value={motionSetting}
                  onChange={onMotionChange}
                />
                <SettingHint class="mt-0">
                  {motionSetting === 'system'
                    ? 'Follows the “show animations in Windows” setting.'
                    : motionSetting === 'reduce' ? 'Nothing moves; state changes are instant.' : 'Everything animates, whatever Windows asks.'}
                </SettingHint>
              </SettingSection>

              <SettingSection title="Code font" description="JetBrains Mono, in the transcript, the file tabs and the terminal.">
                <Switch
                  label={ligatures ? 'Ligatures on' : 'Ligatures off'}
                  hint="Joins => and != and the like into single glyphs"
                  checked={ligatures}
                  onChange={onLigaturesChange}
                />
              </SettingSection>
            </div>
          )}

          {tab === 'permissions' && (
            <Permissions client={client} {...(liveMode !== undefined ? { liveMode } : {})} />
          )}

          {tab === 'skills' && <Skills client={client} />}

          {tab === 'plugins' && <Plugins client={client} />}

          {tab === 'mcp' && (
            <>
              <McpServers client={client} />
              <McpEditor client={client} onApply={() => connect()} />
            </>
          )}

          {tab === 'data' && <EraseEverything />}

          {tab === 'about' && (
            <div data-about="" class="font-ui">
              <div class="flex items-center gap-3">
                <div>
                  <div class="text-[15px] font-semibold text-fg-strong">PrivateCode</div>
                  <div class="text-[12.5px] text-dim">{version !== null ? `Version ${version}` : 'Version not reported by the shell'}</div>
                </div>
                <Button size="sm" class="ml-auto" icon={<RefreshCw />} onClick={onCheckForUpdates} data-action="check-updates">
                  Check for updates
                </Button>
              </div>
              <PanelNote inset class="mt-4">
                A coding agent that runs on this machine, against a model on this machine. Nothing it
                reads or writes leaves the computer unless a tool you allowed sends it.
              </PanelNote>
              <SettingLabel>What is inside</SettingLabel>
              <ul class="m-0 list-none p-0">
                {CREDITS.map((c) => (
                  <li key={c.name} class="flex items-baseline gap-2 border-b border-border-soft py-1.5 text-[12.5px] last:border-b-0">
                    <span class="w-48 shrink-0 font-medium text-fg">{c.name}</span>
                    <span class="min-w-0 flex-1 text-dim">{c.what}</span>
                    <span class="shrink-0 font-mono text-[11px] text-faint">{c.licence}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}
