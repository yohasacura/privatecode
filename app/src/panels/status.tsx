import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import type { McpServerInfo } from '@core/host/protocol'
import type { AgentMode } from '@core/permissions/engine'
import type { ChatState } from '../lib/state'
import { formatTokenCount } from '../lib/format'
import { Icon } from '../components/icons'
import type { ThemeSetting } from '../lib/theme'
import type { SessionSwitch } from './sessions-rail'
import { Permissions } from './permissions'
import { McpEditor } from './mcp-editor'
import { EraseEverything } from './erase-data'
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
    // `turnRunning` is in the deps so the effect re-runs at BOTH edges of a turn, which is
    // what makes the poll above fire the moment one ends. Without it the dependency list was
    // `[client]` alone: a turn begun before the server was ready suppressed every tick for
    // its whole length — minutes — and then waited up to ten seconds more, with the readout
    // absent the entire time because `status` is the app's only route to the window size.
    // Re-running on the leading edge costs one call that returns immediately at the guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, chatState.turnRunning])

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
  const used = lastStep?.contextUsed ?? lastStep?.promptTokens
  /**
   * The window size, freshest first.
   *
   * There are two copies. The session's is captured once, when the session is built, from
   * whatever `/props` said at that moment, and NOTHING in the app ever rewrites it — there is
   * no protocol event for a window change. The polled one is refreshed every ten seconds.
   *
   * This line first read only the session's copy, so starting the app while the server was
   * down left it null forever and the entire readout — bar and figures alike — was never
   * rendered. Reported as "the context bar has disappeared".
   *
   * Then it preferred the session's copy, on the reasoning that it was the number compaction
   * was calibrated against. That reasoning was wrong, and an audit caught it: when the server
   * comes back with a different `-c`, `refreshServerProps` re-calibrates the LIVE core session
   * (host.ts, `setContextLength`) and the app's frozen copy is the only thing still holding
   * the dead number. Preferring it meant dividing by a window that no longer exists — reading
   * "150.0k/131.1k", pinned red, while the engine sat at 57%.
   *
   * So: whichever was learned most recently, which is the polled one whenever it exists.
   */
  const total = contextLength ?? session?.contextLength ?? null
  /** Where compaction will actually fire, when the core has said. */
  const compactAt = lastStep?.compactAt
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
        // `formatTokenCount`, not a hand-rolled /1024: the tooltip said "256k" while the bar
        // two items along said "262.1k" for the same integer, which reads as two different
        // numbers for the same thing and is the sort of small inconsistency that makes a
        // person stop trusting a readout.
        title={contextLength !== null
          ? `${model ?? 'no model'} — ${formatTokenCount(contextLength)} token context window`
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
          {/* The warning is keyed to where compaction ACTUALLY fires, not to a share of the
              window. The default absolute trigger is 140k, which on this machine's 262k
              window is 53% — so a bar that only went yellow at 80% never warned at all, and
              the conversation compacted underneath a readout that said half full and calm.
              80% of the window stays the fallback for a core too old to send `compactAt`. */}
          <span class="ctx-bar">
            <span
              class={`ctx-fill ${used >= (compactAt ?? total * 0.8) * 0.9 ? 'ctx-high' : ''}`}
              style={{ width: `${Math.max(fillPct, used > 0 ? 2 : 0)}%` }}
            />
          </span>
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
  client, onClose, onSessionSwitched, liveMode, themeSetting, onThemeChange,
}: {
  client: ProtocolClient
  /** See Permissions.liveMode. */
  liveMode?: AgentMode
  /** The window's theme setting and the way to change it; App owns the state. */
  themeSetting: ThemeSetting
  onThemeChange: (setting: ThemeSetting) => void
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
  const [tab, setTab] = useState<'server' | 'appearance' | 'permissions' | 'skills' | 'mcp' | 'data'>('server')

  useEffect(() => {
    client.call('config.get', {})
      .then((r) => {
        if (r.serverUrl !== undefined) setServerUrl(r.serverUrl)
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
          // The five other constructions of this object carry it and these two did
          // not. `session-switched` writes compactAt unguarded, so an undefined here
          // replaces a real trigger with the 80%-of-window fallback: on a 262k window
          // the bar then warns at 188k instead of at the 140k trigger, and stays calm
          // and grey for exactly the stretch you would consult it. The next step.done
          // merges it back, i.e. it is wrong until the next turn answers.
          ...(r.compactAt !== undefined ? { compactAt: r.compactAt } : {}),
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
            ['server', 'Server'],
            ['appearance', 'Appearance'],
            ['permissions', 'Permissions'],
            ['skills', 'Skills'],
            ['mcp', 'MCP servers'],
            ['data', 'Data'],
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

        {/* Only the SERVER lives here now. Everything about the workspace — its folders,
            its name, switching to another one — moved to the Workspace tab, which is
            where the owner went looking for all of it. */}
        {tab === 'server' && (
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

            {error && <div class="panel-error">{error}</div>}

            <button
              class="btn btn-primary modal-primary"
              disabled={connecting || workspace.trim() === '' || serverUrl.trim() === ''}
              onClick={connect}
            >
              {connecting ? 'Applying…' : 'Apply — re-open the workspace'}
            </button>
            <div class="field-hint">
              Changing the server means re-opening the workspace against it; the current
              session is picked back up.
            </div>
          </>
        )}

        {tab === 'appearance' && (
          <div class="appearance">
            <label class="field-label">Theme</label>
            <div class="choice-group" role="radiogroup" aria-label="Theme">
              {([['system', 'System'], ['dark', 'Dark'], ['light', 'Light']] as const).map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={themeSetting === value}
                  class={`choice ${themeSetting === value ? 'choice-on' : ''}`}
                  onClick={() => onThemeChange(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div class="field-hint">
              {themeSetting === 'system'
                ? 'Follows Windows, and changes when Windows does.'
                : 'Stays this way whatever Windows is set to.'}
            </div>
          </div>
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

        {tab === 'data' && <EraseEverything />}
      </div>
    </div>
  )
}
