import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import type { McpServerInfo } from '@core/host/protocol'
import type { AgentMode } from '@core/permissions/engine'
import type { ChatState } from '../lib/state'
import { formatTokenCount } from '../lib/format'
import { Icon } from '../components/icons'
import type { SessionSwitch } from './sessions-rail'
import { Folders } from './folders'
import { Permissions } from './permissions'
import { McpEditor } from './mcp-editor'
import { Skills } from './skills'

/**
 * The status bar and the settings modal.
 *
 * The sessions drawer that used to live here moved to the left rail — a conversation list
 * is navigation, not a dialog. What is left is genuinely status: is the server answering,
 * how full is the context, how fast is it going.
 */

function compactionFlashText(c: ChatState['lastCompaction']): string | null {
  if (!c) return null
  switch (c.state) {
    case 'started': return 'compacting the conversation…'
    case 'ready': return 'compaction ready'
    case 'applied': return `compacted · ${c.droppedMessages ?? 0} earlier messages summarised`
    case 'postponed': return 'compaction postponed'
    case 'failed': return 'compaction failed'
    default: return null
  }
}

export function StatusBar({
  client, chatState,
}: {
  client: ProtocolClient
  chatState: ChatState
}): VNode {
  const [serverUp, setServerUp] = useState<boolean | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [contextLength, setContextLength] = useState<number | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const turnRunningRef = useRef(chatState.turnRunning)
  turnRunningRef.current = chatState.turnRunning

  // Polls `status` every 10s while IDLE and never during a turn: the server runs with a
  // single slot (`-np 1`), so a health probe fired mid-generation would be a second
  // concurrent request against a server that can only ever serve one.
  useEffect(() => {
    let cancelled = false
    function poll(): void {
      if (turnRunningRef.current) return
      client.call('status', {}).then((r) => {
        if (cancelled) return
        setServerUp(r.serverUp)
        setModel(r.model ?? null)
        setContextLength(r.contextLength ?? null)
      }).catch(() => { if (!cancelled) setServerUp(false) })
    }
    poll()
    const id = setInterval(poll, 10_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [client])

  // `seq`, not `state`, is the dependency: two 'postponed' events in a row carry the same
  // state string and must still re-flash.
  useEffect(() => {
    const text = compactionFlashText(chatState.lastCompaction)
    setFlash(text)
    if (text === null) return
    const id = setTimeout(() => setFlash(null), 5_000)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on seq, not the object
  }, [chatState.lastCompaction?.seq])

  const session = chatState.session
  const lastStep = chatState.lastStepDone
  const used = lastStep?.promptTokens
  const total = session?.contextLength ?? null
  const fillPct = used !== undefined && total !== null && total > 0
    ? Math.min(100, Math.round((used / total) * 100))
    : null

  return (
    <footer class="statusbar">
      <span
        class={`status-dot ${serverUp === null ? 'dot-unknown' : serverUp ? 'dot-up' : 'dot-down'}`}
        title={serverUp === null ? 'checking the model server…' : serverUp ? 'model server is answering' : 'model server is not answering'}
      />
      {/* Both come from the server's own /props, not from a constant this build carries.
          The window size is in the tooltip rather than the bar because it is the answer to
          a question you only ask once a session — "why is it compacting so often" — and a
          32k model answers it immediately where a 131k one never raises it. */}
      <span
        class="status-model"
        title={contextLength !== null
          ? `${model ?? 'no model'} — ${Math.round(contextLength / 1024)}k token context window`
          : 'the model server has not said what it is serving yet'}
      >
        {model ?? 'no model'}
      </span>

      {session && <span class={`status-mode mode-${session.mode}`}>{session.mode}</span>}

      {fillPct !== null && used !== undefined && total !== null && (
        <span
          class="status-context"
          title={lastStep?.estimated === true
            // Said out loud rather than shown as a reading: this is the transcript measured
            // here, not the count the server reported, and the two differ a little. True of
            // a freshly restored session AND of a just-compacted one — both are waiting on
            // the next step for the server's own number.
            ? 'context in use, estimated from the conversation — the exact figure arrives with the next step'
            : 'context used by the last step'}
        >
          <span class="ctx-bar"><span class={`ctx-fill ${fillPct >= 80 ? 'ctx-high' : ''}`} style={{ width: `${fillPct}%` }} /></span>
          {formatTokenCount(used)}/{formatTokenCount(total)}
        </span>
      )}

      {lastStep?.tokensPerSecond !== undefined && (
        <span class="status-item">{lastStep.tokensPerSecond.toFixed(1)} tok/s</span>
      )}
      {lastStep?.draftAcceptance !== undefined && (
        <span class="status-item" title="speculative-decoding draft acceptance">
          MTP {(lastStep.draftAcceptance * 100).toFixed(0)}%
        </span>
      )}

      {flash && <span class="status-flash">{flash}</span>}
      <span class="status-spacer" />
      <span class="status-item status-private" title="Nothing leaves this machine.">
        {Icon.shield()} offline
      </span>
    </footer>
  )
}

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
      .catch(() => { /* the modal's job is the workspace; this is extra */ })
    return () => { cancelled = true }
  }, [client])

  if (servers === null || servers.length === 0) return null // the editor below covers the empty case
  return (
    <>
      <div class="field-label">MCP servers</div>
      <div class="mcp-list">
        {servers.map((s) => (
          <div key={s.name} class={`mcp-item mcp-${s.state}`}>
            <div class="mcp-head">
              <span class="mcp-name">{s.name}</span>
              <span class="mcp-state">
                {s.state === 'connected' ? `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}` : 'failed'}
              </span>
            </div>
            {s.problem !== undefined && <pre class="mcp-problem">{s.problem}</pre>}
          </div>
        ))}
      </div>
      <div class="field-hint">
        Configured under "mcpServers" in .privatecode/settings.json. Their tools ask for
        approval like everything else.
      </div>
    </>
  )
}

export function SettingsModal({
  client, isDevBridge, onClose, onSessionSwitched, liveMode,
}: {
  client: ProtocolClient
  /** Dev-bridge mode (a `?ws=` URL) has no Tauri window behind it to own a native folder
   * dialog, so it gets a plain text field instead. */
  isDevBridge: boolean
  /** See Permissions.liveMode. */
  liveMode?: AgentMode
  onClose: () => void
  /** Opening a workspace is the one moment its name and folder count can change, so they
   * ride this callback rather than every session switch. */
  onSessionSwitched: (
    info: SessionSwitch & { workspaceRoot: string; workspaceName: string; folderCount: number },
  ) => void
}): VNode {
  const [serverUrl, setServerUrl] = useState('http://127.0.0.1:8080')
  const [workspace, setWorkspace] = useState('')
  const [recent, setRecent] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [tab, setTab] = useState<'workspace' | 'permissions' | 'skills' | 'mcp'>('workspace')

  useEffect(() => {
    client.call('config.get', {})
      .then((r) => {
        if (r.serverUrl !== undefined) setServerUrl(r.serverUrl)
        setRecent(r.recentWorkspaces)
        if (r.recentWorkspaces[0]) setWorkspace(r.recentWorkspaces[0])
      })
      .catch(() => { /* host-side defaults already cover this */ })
  }, [client])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Dialog behaviour, not just dialog looks. Without these, focus stayed BEHIND the
  // overlay: a keyboard user tabbed through the invisible composer and rail before ever
  // reaching the dialog, and Enter pressed "blind" in the covered composer sent a real
  // message to the agent while Settings was on screen. Focus moves in on mount, Tab wraps
  // at the edges, and the opener gets focus back on close.
  const modalRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    modalRef.current?.focus()
    return () => opener?.focus()
  }, [])
  function trapTab(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return
    const focusables = modalRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    if (!focusables || focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    // Focus starts on the CONTAINER (tabindex=-1), which is neither first nor last — an
    // immediate Shift+Tab from there escaped behind the overlay into the covered composer.
    if (document.activeElement === modalRef.current) {
      e.preventDefault()
      ;(e.shiftKey ? last : first).focus()
      return
    }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  async function pickWorkspaceDialog(): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({ directory: true, multiple: false })
    if (typeof result === 'string') setWorkspace(result)
  }

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
          sessionId: r.sessionId, mode: r.mode, contextLength: r.contextLength, title: r.title,
          problems: r.problems, items: r.items, workspaceRoot: root,
          workspaceName: r.workspaceName, folderCount: r.folderCount,
          contextUsed: r.contextUsed,
        })
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setConnecting(false))
  }

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabindex={-1}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div class="modal-head">
          <b>Settings</b>
          <button class="icon-button" onClick={onClose} title="Close">{Icon.x()}</button>
        </div>

        {/* Tabs, because burial was measured: the permissions section existed, at the
            bottom of one long scroll, and the person it was built for reported not seeing
            it. A section you have to already know about to find is not a section. */}
        <div class="modal-tabs" role="tablist">
          {([
            ['workspace', 'Workspace'],
            ['permissions', 'Permissions'],
            ['skills', 'Skills'],
            ['mcp', 'MCP servers'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              class={`modal-tab ${tab === id ? 'modal-tab-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'workspace' && (
          <>
            <label class="field-label" for="set-url">Model server</label>
            <input
              id="set-url"
              class="input"
              value={serverUrl}
              onInput={(e) => setServerUrl(e.currentTarget.value)}
              placeholder="http://127.0.0.1:8080"
            />
            <div class="field-hint">Your llama.cpp server. Nothing is ever sent anywhere else.</div>

            <label class="field-label" for="set-ws">Workspace</label>
            <div class="field-row">
              <input
                id="set-ws"
                class="input"
                value={workspace}
                readOnly={!isDevBridge}
                onInput={(e) => setWorkspace(e.currentTarget.value)}
                placeholder={isDevBridge ? 'C:/path/to/project' : '(none picked)'}
              />
              {!isDevBridge && <button class="btn" onClick={() => void pickWorkspaceDialog()}>Browse…</button>}
            </div>
            <div class="field-hint">Everything the agent may read or change is bounded by this folder.</div>

            {recent.length > 0 && (
              <>
                <div class="field-label">Recent</div>
                <div class="recent-list">
                  {recent.map((w) => (
                    <button key={w} class={`recent-item ${w === workspace ? 'recent-item-active' : ''}`} onClick={() => setWorkspace(w)}>
                      {w}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div class="field-label">Folders</div>
            <Folders
              client={client}
              isDevBridge={isDevBridge}
              onChanged={() => connect()}
            />

            {error && <div class="panel-error">{error}</div>}

            <button
              class="btn btn-primary modal-primary"
              disabled={connecting || workspace.trim() === '' || serverUrl.trim() === ''}
              onClick={connect}
            >
              {connecting ? 'Opening…' : 'Open workspace'}
            </button>
            <div class="field-hint">
              Opening a workspace picks up its most recent session. New session starts a clean one.
            </div>
          </>
        )}

        {tab === 'permissions' && (
          <Permissions client={client} {...(liveMode !== undefined ? { liveMode } : {})} />
        )}

        {tab === 'skills' && <Skills client={client} />}

        {tab === 'mcp' && (
          <>
            <McpServers client={client} />
            <McpEditor client={client} onApply={() => connect()} />
          </>
        )}
      </div>
    </div>
  )
}
