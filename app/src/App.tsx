import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import {
  createClient, restartSidecar, sidecarStderr, withTimeout, wsUrlFromSearch,
  type ConnectionState, type ProtocolClient,
} from './lib/client'
import { useChatSession } from './lib/use-chat-session'
import { notify } from './lib/notify'
import {
  applyUpdate, checkForUpdate, describeProgress, formatBytes, onUpdateProgress, scheduleUpdateCheck,
  updatedFrom, type UpdateAvailable, type UpdateProgress,
} from './lib/update'
import { baseName } from './lib/format'
import { conversationAsMarkdown } from './lib/export'
import { MIN_CONTEXT, MIN_RAIL, fitColumns } from './lib/layout'
import { Icon } from './components/icons'
import { applyTheme, isThemeSetting, resolveTheme, systemPrefersDark, watchSystemTheme, type ThemeSetting } from './lib/theme'
import { Splitter } from './components/split'
import { collectChanges } from './panels/changes-tab'
import { Composer } from './panels/composer'
import { ContextPanel } from './panels/context-panel'
import { FileView } from './panels/file-view'
import { SessionsRail, type SessionSwitch } from './panels/sessions-rail'
import { StatusBar, SettingsModal } from './panels/status'
import { WorkspaceSwitch } from './panels/workspace-switch'
import { Palette, type PaletteAction } from './panels/palette'
import { Transcript } from './panels/transcript'
import './App.css'

/** One opened file, as a TAB beside the chat. The face — content or diff — is tab state,
 * so switching away and back lands where you were. */
interface EditorTab {
  path: string
  face: 'file' | 'diff'
}

/**
 * The shell: three columns — sessions, conversation, workspace context — plus a title bar
 * and a status bar.
 *
 * The previous shell gave the chat a third of the window between a file tree and a diff
 * list, which is an IDE's shape, not an agent's: the conversation IS the tool, and the
 * other two are reference material you consult occasionally. Here the centre column takes
 * everything the side columns do not, and both sides collapse to nothing (Ctrl+B / Ctrl+J)
 * and remember their width.
 *
 * The first-run flow is unchanged in substance and worth restating, because it was a real
 * bug: `status` answers `serverUp: false` by design before any `init`, so the original
 * header called it on boot and permanently reported "server unreachable" next to a working
 * server. Boot now reads the saved config, auto-connects to the last workspace if there is
 * one, and otherwise shows a welcome screen — `status` is only ever consulted after `init`.
 */

type Phase =
  | { kind: 'boot' }
  | { kind: 'welcome'; error: string | null }
  | { kind: 'initializing'; workspace: string }
  | { kind: 'ready'; workspace: string }
  /** The agent process is not answering at all -- distinct from `welcome` with an error,
   * which means the agent answered and refused. Nothing the welcome screen offers can help
   * here, so this screen offers the two things that can: what the agent printed on its way
   * out, and a restart. */
  | { kind: 'unreachable'; reason: string; stderr: string[] }

/** Tools whose result means the workspace on disk may have moved. See `workspaceMutations`. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'edit_file', 'write_file', 'move_file', 'delete_file', 'run_command', 'background_task',
])

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8080'
/** How long the first request may take before the agent counts as unreachable. Generous:
 * on a cold start Node has to load a 600 kB bundle and the process may be competing with
 * the model server for cores. */
const BOOT_TIMEOUT_MS = 12_000
const RAIL_DEFAULT = 232
/** Wide enough for all four tab names AND their badges at once. At 380 they did not fit,
 * and the bar fell back to icons for everything but the tab you were on. */
const CONTEXT_DEFAULT = 420

/**
 * Surfaces that answer Escape themselves and must keep it while a file tab is fronted.
 *
 * The `:not()` is the whole point. The chat face stays MOUNTED behind a file tab —
 * `.chat-face-hidden` is `display: none`, not an unmount — so a command picker left open by a
 * stray `/`, or a run-config card left open, still matched a bare `.command-picker` /
 * `.run-config` and made the Escape handler below bail. Esc then did nothing visible AND
 * travelled on to the composer's window listener, which aborts the running turn.
 */
const ESCAPE_OWNERS =
  '.modal-overlay, .chat-face:not(.chat-face-hidden) .command-picker,' +
  ' .chat-face:not(.chat-face-hidden) .run-config'

/**
 * Inline edit boxes elsewhere in the window that cancel THEMSELVES on Escape: the workspace
 * name, the add-folder path, a folder's rename box. The workspace column stays on screen
 * while a file tab is fronted, so the capture-phase handler below was stopping the key before
 * their own `onKeyDown` ever ran — the box stayed open with its draft in it and the window
 * jumped back to the Chat tab instead.
 *
 * Listed by hand rather than asking "is the target a text field", because those are different
 * questions: the terminal's input has no Escape of its own, and letting the key through there
 * would reach the composer's abort listener instead of doing nothing.
 */
const INLINE_EDITS =
  '.workspace-name-input, .workspace-add-input, .tree-mount-controls-open input'

/**
 * The recents list after opening `root` — newest first, no duplicate — mirroring what the
 * host writes into `ui.json`. The length cap lives on disk (`saveUiConfig`) and is re-read at
 * boot; this copy only has to be right for the welcome screen this run might reach.
 *
 * Case-insensitive, because Windows is the target and the two paths that arrive here come
 * from a person typing and from the folder picker: `D:\proj` and `d:\proj` are one folder,
 * and listing both would offer a stale entry that reopens the same place.
 */
export function withRecentFirst(recents: readonly string[], root: string): string[] {
  const lowered = root.toLowerCase()
  return [root, ...recents.filter((w) => w.toLowerCase() !== lowered)]
}

/** Column widths and collapse state live in localStorage: a layout you have to re-arrange
 * on every launch is one you stop arranging. */
function loadLayout<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`pc.layout.${key}`)
    return raw === null ? fallback : JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function saveLayout(key: string, value: unknown): void {
  try { localStorage.setItem(`pc.layout.${key}`, JSON.stringify(value)) } catch { /* private mode */ }
}

/**
 * The agent-unreachable screen: what went wrong, what the agent printed on its way out, and
 * a way back. This replaces the state the app was actually in the first time it was run for
 * real — "starting the agent…" forever, with no error, no diagnostics and no recovery.
 */
/**
 * Minimize, maximize/restore, close — drawn by the window because the OS frame is off. Each
 * reaches the Tauri window API lazily and swallows its absence: in the browser dev bridge
 * there is no window to control, and the controls are not rendered there at all.
 */
function WindowControls(): VNode {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let gone = false
    let unlisten: (() => void) | undefined
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const w = getCurrentWindow()
        setMaximized(await w.isMaximized())
        const off = await w.onResized(() => {
          void w.isMaximized().then((m) => { if (!gone) setMaximized(m) })
        })
        if (gone) off()
        else unlisten = off
      } catch {
        // Not inside Tauri.
      }
    })()
    return () => { gone = true; unlisten?.() }
  }, [])
  const act = (what: 'minimize' | 'toggle' | 'close'): void => {
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const w = getCurrentWindow()
        if (what === 'minimize') await w.minimize()
        else if (what === 'toggle') await w.toggleMaximize()
        else await w.close()
      } catch {
        // Not inside Tauri.
      }
    })()
  }
  return (
    <div class="win-controls">
      <button class="win-btn" onClick={() => act('minimize')} title="Minimize" aria-label="Minimize">
        {Icon.winMin()}
      </button>
      <button
        class="win-btn"
        onClick={() => act('toggle')}
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? Icon.winRestore() : Icon.winMax()}
      </button>
      <button class="win-btn win-btn-close" onClick={() => act('close')} title="Close" aria-label="Close">
        {Icon.winClose()}
      </button>
    </div>
  )
}

function AgentDown({
  phase, isDevBridge,
}: {
  phase: { kind: 'unreachable'; reason: string; stderr: string[] }
  isDevBridge: boolean
}): VNode {
  const [restarting, setRestarting] = useState(false)

  function restart(): void {
    setRestarting(true)
    // A fresh sidecar means a fresh SessionHost; reloading is the honest way to get this
    // window's own state back in step with it rather than patching around a half-live one.
    restartSidecar()
      .then(() => window.location.reload())
      .catch(() => setRestarting(false))
  }

  return (
    <div class="welcome">
      <div class="welcome-card">
        <div class="welcome-logo welcome-logo-bad" aria-hidden="true">{Icon.alert()}</div>
        <h1>The agent isn’t running</h1>
        <p class="welcome-sub">{phase.reason}.</p>

        {phase.stderr.length > 0
          ? (
            <>
              <div class="field-label">What it printed</div>
              <pre class="agent-stderr">{phase.stderr.slice(-40).join('\n')}</pre>
            </>
            )
          : (
            <p class="field-hint">
              It left no output, which usually means the process was killed rather than that
              it failed on its own.
            </p>
            )}

        {isDevBridge
          ? (
            <p class="field-hint">
              This window is running against the dev bridge. Restart it with
              {' '}<code>npm run host:dev</code> and reload.
            </p>
            )
          : (
            <button class="btn btn-primary welcome-connect" disabled={restarting} onClick={restart}>
              {restarting ? 'Restarting…' : 'Restart the agent'}
            </button>
            )}
      </div>
    </div>
  )
}

export default function App() {
  const [client, setClient] = useState<ProtocolClient | null>(null)
  const [connState, setConnState] = useState<ConnectionState>('connecting')
  const [phase, setPhase] = useState<Phase>({ kind: 'boot' })
  const [workspaceInput, setWorkspaceInput] = useState('')
  const [serverInput, setServerInput] = useState(DEFAULT_SERVER_URL)
  const [recents, setRecents] = useState<string[]>([])
  /** Files opened as tabs beside the chat, and which tab is fronted (`null` = Chat).
   * The owner's ruling: files and diffs are siblings of the conversation, not an overlay
   * squeezed into the 420px side panel. */
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  // Asked once, twenty seconds after launch, and silent about every kind of failure -- see
  // lib/update.ts. An offline tool must not be able to look broken because a check nobody
  // asked for could not reach GitHub.
  const [update, setUpdate] = useState<UpdateAvailable | null>(null)
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  /** "Not now" means this version, for this run of the window: the automatic check comes
   * back twice a day and must not re-offer what was just declined. A newer release than the
   * declined one is still offered, and a check asked for by name always is. */
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const dismissedRef = useRef<string | null>(null)
  dismissedRef.current = dismissedVersion
  useEffect(() => scheduleUpdateCheck((u) => {
    if (u.newVersion !== dismissedRef.current) setUpdate(u)
  }), [])
  /** Where a running update has got to — the shell's last word on it. Null until the button
   * is pressed. The banner reads this instead of saying "Downloading…" for two minutes. */
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null)
  useEffect(() => {
    let gone = false
    let unlisten: (() => void) | undefined
    void onUpdateProgress(setUpdateProgress).then((u) => { if (gone) u(); else unlisten = u })
    return () => { gone = true; unlisten?.() }
  }, [])
  /** "Updated to 0.3.0 from 0.2.0" — the one thing an update should say afterwards. The shell
   * leaves itself a note before restarting and consumes it on the way back up, so the second
   * launch says nothing. A strip rather than a chat row, because a chat row only exists once
   * a workspace is open and the relaunch may well land on the welcome screen. */
  const [updatedNote, setUpdatedNote] = useState<{ current: string; from: string } | null>(null)
  useEffect(() => {
    void updatedFrom().then((info) => {
      if (info?.updatedFrom) setUpdatedNote({ current: info.currentVersion, from: info.updatedFrom })
    })
  }, [])
  function startUpdate(): void {
    setUpdateError(null)
    setUpdateProgress(null)
    setUpdating(true)
    void applyUpdate().then((err) => {
      // Only returns on failure -- success replaces the process.
      setUpdateError(err)
      setUpdating(false)
    })
  }
  const [settingsOpen, setSettingsOpen] = useState(false)

  /** The theme: `system` until `config.get` says otherwise, applied here and followed while
   * it is `system`. `main.tsx` stamps the OS preference before the first paint. */
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>('system')
  useEffect(() => {
    applyTheme(resolveTheme(themeSetting, systemPrefersDark()))
    if (themeSetting !== 'system') return
    return watchSystemTheme((dark) => applyTheme(resolveTheme('system', dark)))
  }, [themeSetting])
  const [switchOpen, setSwitchOpen] = useState(false)
  /** What this workspace is called and how many folders it spans. Kept beside `phase`
   * rather than inside it because it survives a session switch unchanged. */
  const [workspaceLabel, setWorkspaceLabel] = useState<{ name: string; folders: number }>({ name: '', folders: 1 })
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sessionsKey, setSessionsKey] = useState(0)
  const [chatState, dispatch] = useChatSession(client)

  /** Reviewed watermarks (path → last-write id the review covered) live HERE because two
   * surfaces act on them now: the tree dims badges, and a diff tab's Reviewed button sets
   * them. A per-session judgement — reset when the session changes. */
  const [reviewed, setReviewed] = useState<ReadonlyMap<string, number>>(new Map())
  /** Bumped by a Put back so git status re-reads itself: the revert changed the disk. */
  const [reverts, setReverts] = useState(0)
  /**
   * Bumped when this window regains focus, because the disk is not ours alone.
   *
   * Everything the workspace panel shows — branch, staged and dirty sets, the file tree —
   * was read once and then only ever re-read after WE changed something: a write tool, a
   * Put back, a stage or a commit. Switch branch in VS Code, stash from a terminal, pull:
   * PrivateCode kept showing the old branch and the old file list until the app was
   * restarted, because no timer, no watcher and no manual refresh existed anywhere in the
   * codebase to notice.
   *
   * Focus is the trigger rather than a poll for two reasons. It is exactly when staleness
   * starts to matter — you cannot act on this panel without focusing the window first —
   * and it costs nothing while you work in another app, where a poll would be spawning git
   * every few seconds to redraw a panel nobody is looking at.
   */
  const [externalChanges, setExternalChanges] = useState(0)
  useEffect(() => {
    const bump = (): void => setExternalChanges((n) => n + 1)
    // Both, deliberately. `focus` covers alt-tab between windows; `visibilitychange` covers
    // the window being restored from minimised or its virtual desktop being switched back,
    // which does not always raise `focus`.
    const onVisible = (): void => { if (!document.hidden) bump() }
    window.addEventListener('focus', bump)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', bump)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  const liveSessionId = chatState.session?.sessionId ?? ''
  useEffect(() => { setReviewed(new Map()) }, [liveSessionId])

  // `items` is a new array on every streamed token, so memoising on it directly would
  // never hit. The change list can only move when an item is ADDED or when a tool call
  // gets its result — neither of which a token does — so those two counts are an exact
  // key, and they cost a loop instead of a JSON.parse per write call per token.
  const resolvedTools = chatState.items.reduce(
    (n, i) => n + (i.kind === 'tool' && i.result !== undefined ? 1 : 0), 0)
  /**
   * The same signal, narrowed to tools that can actually have CHANGED the workspace.
   *
   * `resolvedTools` counts every resolved call, reads and `todo_write` included, and it was
   * driving the Workspace tab's reload key — so a turn that only read files re-ran
   * `describeFolder` plus `discoverRepos` for every mount on every step: git process spawns
   * and two uncached recursive directory walks, on the same laptop running the agent's own
   * tools, to refresh a listing that cannot have moved. The file tree next door already does
   * the filtered version of this. `run_command` and `background_task` are in the list because
   * a build or a script genuinely does change the tree; nothing else here can.
   */
  const workspaceMutations = chatState.items.reduce(
    (n, i) => n + (i.kind === 'tool' && i.result !== undefined && MUTATING_TOOLS.has(i.name) ? 1 : 0), 0)
  const changes = useMemo(
    () => collectChanges(chatState.items),
    // The session id is part of the key: a switch REPLACES items, and if the old and new
    // sessions happen to have equal counts the two-count key would keep the previous
    // session's list — now feeding a destructive consumer (Put back in a diff tab).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the counts + session
    [chatState.items.length, resolvedTools, liveSessionId],
  )
  const changesByPath = useMemo(
    () => new Map(changes.map((c) => [c.openPath, c])), [changes])

  /** Open a file as a tab (or re-front its existing tab) on the requested face. */
  const openTab = useCallback((path: string, face: 'file' | 'diff' = 'file') => {
    setTabs((prev) => (prev.some((t) => t.path === path)
      ? prev.map((t) => (t.path === path ? { ...t, face } : t))
      : [...prev, { path, face }]))
    setActiveTab(path)
  }, [])

  function closeTab(path: string): void {
    const idx = tabs.findIndex((t) => t.path === path)
    const next = tabs.filter((t) => t.path !== path)
    setTabs(next)
    // Closing the fronted tab lands on its left neighbour, then Chat — the way editors do.
    if (activeTab === path) setActiveTab(next[Math.max(0, idx - 1)]?.path ?? null)
  }

  function setTabFace(path: string, face: 'file' | 'diff'): void {
    setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, face } : t)))
  }

  // Esc on a file tab returns to the chat — it does NOT close the tab, and (capture
  // phase, same trick as everywhere) it must not fall through to the composer's abort
  // listener and silently stop a running turn. Modals keep their own Esc.
  //
  // Both guards are narrower than "is one of these anywhere in the document": see
  // ESCAPE_OWNERS for why a picker in the hidden composer must not count, and INLINE_EDITS
  // for the edit boxes whose own Escape this handler was eating. Capture phase is what makes
  // the second guard a bail rather than a stop — stopping in capture means the event never
  // reaches the target at all, so there is no way to both claim the key and let the box have
  // it.
  useEffect(() => {
    if (activeTab === null) return
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      if (document.querySelector(ESCAPE_OWNERS) !== null) return
      if (e.target instanceof Element && e.target.closest(INLINE_EDITS) !== null) return
      e.stopPropagation()
      setActiveTab(null)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [activeTab])

  const [railOpen, setRailOpen] = useState(() => loadLayout('railOpen', true))
  const [contextOpen, setContextOpen] = useState(() => loadLayout('contextOpen', true))
  const [railWidth, setRailWidth] = useState(() => loadLayout('railWidth', RAIL_DEFAULT))
  const [contextWidth, setContextWidth] = useState(() => loadLayout('contextWidth', CONTEXT_DEFAULT))

  const isDevBridge = wsUrlFromSearch(window.location.search) !== undefined
  const bootStarted = useRef(false)

  useEffect(() => { saveLayout('railOpen', railOpen) }, [railOpen])
  useEffect(() => { saveLayout('contextOpen', contextOpen) }, [contextOpen])
  useEffect(() => { saveLayout('railWidth', railWidth) }, [railWidth])
  useEffect(() => { saveLayout('contextWidth', contextWidth) }, [contextWidth])

  // Widths persist, window sizes do not. What the user asked for and what fits right now
  // are different facts and only the first is stored: the previous version squeezed the
  // saved numbers themselves on every resize, so docking to a small screen once shrank the
  // layout you had set up on the big one -- permanently, because it was written to disk.
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    function onResize(): void { setWindowWidth(window.innerWidth) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const columns = fitColumns({ windowWidth, railOpen, contextOpen, railWidth, contextWidth })
  const railShown = columns.rail > 0
  const contextShown = columns.context > 0

  useEffect(() => {
    const c: ProtocolClient = createClient(wsUrlFromSearch(window.location.search))
    setClient(c)
    const unsubState = c.onStateChange(setConnState)
    // Debug convenience only: any script in this WebView could reach the same object
    // anyway, so exposing it grants nothing new.
    ;(window as unknown as { __pcClient?: ProtocolClient }).__pcClient = c
    return () => { unsubState(); c.close() }
  }, [])

  const connect = useCallback(async (c: ProtocolClient, workspace: string, serverUrl: string): Promise<void> => {
    setPhase({ kind: 'initializing', workspace })
    // Tab paths are workspace-addressed; a different (or re-opened) workspace makes
    // every one of them a stranger.
    setTabs([])
    setActiveTab(null)
    try {
      // `continueLast`: opening a workspace picks up where it was left, rather than
      // discarding the conversation you were in the middle of when you closed the window.
      // Starting clean is the New session button, one click away.
      // The shell's own version, so every session records which build it ran under and
      // `doctor` can attribute a failure pattern to one. Imported lazily and allowed to
      // fail: the dev bridge is a plain browser tab with no Tauri IPC, and a diagnosis
      // missing a version number is worth more than a boot that crashed getting it.
      let appVersion: string | undefined
      try {
        appVersion = await (await import('@tauri-apps/api/app')).getVersion()
      } catch { /* not running under Tauri */ }
      const init = await c.call('init', {
        workspaceRoot: workspace, serverUrl, continueLast: true,
        ...(appVersion !== undefined ? { appVersion } : {}),
      })
      setWorkspaceLabel({ name: init.workspaceName, folders: init.folderCount })
      dispatch({
        type: 'session-switched',
        sessionId: init.sessionId,
        mode: init.mode,
        contextLength: init.contextLength,
        title: init.title,
        gateMode: init.gateMode,
        contextUsed: init.contextUsed, ...(init.compactAt !== undefined ? { compactAt: init.compactAt } : {}),
      })
      // AFTER session-switched, never before: that action resets the transcript, and the
      // host emits its `settings.problem` events while BUILDING the session -- i.e. before
      // the reply above resolves -- so anything appended earlier is wiped microseconds
      // later. The reducer dedupes on exact text, so the double delivery costs nothing.
      if (init.items.length > 0) dispatch({ type: 'transcript-restored', entries: init.items })
      for (const text of init.problems) dispatch({ type: 'settings-problem', text })
      // Remember what worked; the next launch auto-connects with exactly this.
      c.call('config.set', { serverUrl, recentWorkspace: workspace }).catch(() => {})
      // Seed the parked-decision count for THE case the queue exists for: questions parked
      // by last night's run, app reopened this morning. Boot lands here, not in
      // onSessionSwitched, and the host only announces changes.
      c.call('decisions.list', {})
        .then((r) => dispatch({ type: 'decisions.changed', pending: r.decisions.length }))
        .catch(() => { /* the next decisions.changed event corrects it */ })
      setPhase({ kind: 'ready', workspace })
      setSessionsKey((k) => k + 1)
    } catch (e) {
      setPhase({
        kind: 'welcome',
        error: `Could not open that folder: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }, [dispatch])

  /**
   * Re-open the workspace that is already open, after a folder edit (rename, add a folder,
   * toggle a folder's access) asked for it.
   *
   * The server URL is read from the HOST rather than from this component's `serverInput`,
   * which is only ever written at boot and by the welcome form. Settings keeps its own copy
   * of the URL, applies it with its own `init` + `config.set`, and never tells App — so a
   * reopen used the URL from launch and `connect` then persisted that back over the one the
   * user had just chosen: an unrelated folder edit silently undid the server change.
   */
  const reopenWorkspace = useCallback(async (c: ProtocolClient, workspace: string): Promise<void> => {
    const saved = await c.call('config.get', {})
      .then((cfg) => cfg.serverUrl ?? '')
      // The reopen still has to happen; falling back to what this window last knew is the
      // same answer it would have given anyway.
      .catch(() => '')
    const serverUrl = saved.trim() || serverInput.trim() || DEFAULT_SERVER_URL
    setServerInput(serverUrl)
    await connect(c, workspace, serverUrl)
  }, [connect, serverInput])

  /**
   * A workspace opened by some OTHER surface — the switcher, or Settings applying a server
   * change — adopted here.
   *
   * The session half is obvious; the other half is that this window's own memory of where it
   * is (`workspaceInput`, `recents`) used to be written only at boot and by the welcome form.
   * So: launch in A, switch to B, press Close workspace → the welcome screen came back with
   * A's path in the folder field and A's recents, and Open workspace reopened A and wrote it
   * back as the workspace to auto-connect to next launch. The user believes they are
   * reopening the workspace they just closed.
   */
  function onWorkspaceOpened(
    info: SessionSwitch & { workspaceRoot: string; workspaceName: string; folderCount: number },
  ): void {
    dispatch({ type: 'session-switched', ...info })
    if (info.items.length > 0) dispatch({ type: 'transcript-restored', entries: info.items })
    for (const text of info.problems) dispatch({ type: 'settings-problem', text })
    setPhase({ kind: 'ready', workspace: info.workspaceRoot })
    setWorkspaceLabel({ name: info.workspaceName, folders: info.folderCount })
    setWorkspaceInput(info.workspaceRoot)
    setRecents((r) => withRecentFirst(r, info.workspaceRoot))
    setTabs([])
    setActiveTab(null)
    setSessionsKey((k) => k + 1)
  }

  // Boot: learn the saved config, then auto-connect or show the welcome screen. The
  // timeout is what makes "the agent died" a screen you can act on instead of a spinner
  // that never resolves -- see `withTimeout`'s comment for why every failure looks the same
  // from here.
  useEffect(() => {
    if (!client || bootStarted.current) return
    bootStarted.current = true
    withTimeout(
      client.call('config.get', {}),
      BOOT_TIMEOUT_MS,
      'the agent process did not answer within 12 seconds',
    )
      .then((cfg) => {
        const savedUrl = cfg.serverUrl ?? DEFAULT_SERVER_URL
        setServerInput(savedUrl)
        setRecents(cfg.recentWorkspaces)
        if (isThemeSetting(cfg.theme)) setThemeSetting(cfg.theme)
        const last = cfg.recentWorkspaces[0]
        if (last) {
          setWorkspaceInput(last)
          void connect(client, last, savedUrl)
        } else {
          setPhase({ kind: 'welcome', error: null })
        }
      })
      .catch((e: unknown) => {
        const reason = e instanceof Error ? e.message : String(e)
        void sidecarStderr().then((stderr) => setPhase({ kind: 'unreachable', reason, stderr }))
      })
  }, [client, connect])

  // The agent dying MID-SESSION is the same dead end as it dying at boot, and it is
  // reported by exactly one signal: the transport going 'closed'. (At boot that signal is
  // unreliable -- a Tauri event fired before the WebView registered its listener is lost --
  // which is what the boot timeout above is for.)
  useEffect(() => {
    if (connState !== 'closed') return
    setPhase((current) => (current.kind === 'unreachable' ? current : { kind: 'unreachable', reason: 'the agent process stopped', stderr: [] }))
    // The one walk-away ending that never announced itself: every other terminal event
    // notifies (turn done, run ended, question parked), but the agent DYING at 2am during
    // an overnight run was silent — hours of expected work quietly not happening, found
    // only by coming back to the dead screen. `notify` already declines while focused.
    void notify(
      'PrivateCode stopped',
      chatState.run !== null
        ? 'The agent process died during an unattended run.'
        : 'The agent process died.',
    )
    void sidecarStderr().then((stderr) => {
      if (stderr.length > 0) {
        setPhase((current) => (current.kind === 'unreachable' ? { ...current, stderr } : current))
      }
    })
  }, [connState])

  // A finished turn may have written the session title, so the rail is refreshed then --
  // there is no protocol event for "a session's metadata changed".
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !chatState.turnRunning) setSessionsKey((k) => k + 1)
    wasRunning.current = chatState.turnRunning
  }, [chatState.turnRunning])

  // A ref, so the handler can see the CURRENT dialog state from its []-deps closure:
  // Ctrl+K under an open Settings dialog opened the palette invisibly BENEATH the settings
  // overlay (both are .modal-overlay; Settings mounts later and paints on top) and its
  // autofocused input silently stole every subsequent keystroke from the settings form.
  //
  // The Switch-workspace dialog is the SAME surface and was not covered: it is also a
  // .modal-overlay at the same z-index, and the palette renders first, so the switcher
  // paints over a live palette whose autofocused input owns the keyboard. Enter then fires
  // whatever the palette had highlighted. Escape cannot even untangle it — the palette
  // declines Escape while a .modal is up, so Escape closes the switcher and leaves the
  // palette behind. Tracked as one "is a dialog up" fact rather than two flags, so the next
  // modal added does not have to remember to come here.
  const modalOpen = settingsOpen || switchOpen
  const anyModalOpenRef = useRef(modalOpen)
  anyModalOpenRef.current = modalOpen
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!e.ctrlKey || e.altKey) return
      if (e.key === 'b' || e.key === 'B') { e.preventDefault(); setRailOpen((v) => !v) }
      if (e.key === 'j' || e.key === 'J') { e.preventDefault(); setContextOpen((v) => !v) }
      if ((e.key === 'k' || e.key === 'K') && !anyModalOpenRef.current) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function pickWorkspaceDialog(): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({ directory: true, multiple: false })
    if (typeof result === 'string') setWorkspaceInput(result)
  }

  /**
   * Read a stored session without becoming it: the live one keeps running, and its events
   * keep folding into the state behind this view.
   *
   * Clicking the session that IS live simply ends the reading and shows it again.
   */
  function viewSession(c: ProtocolClient, id: string): void {
    if (id === chatState.session?.sessionId) { dispatch({ type: 'viewing-ended' }); return }
    c.call('sessions.read', { id })
      .then((r) => dispatch({
        type: 'viewing-started', sessionId: r.sessionId, title: r.title, entries: r.items,
      }))
      // A note, never send-failed: reading happens WHILE a turn streams (that is the
      // feature), and send-failed would flip the composer to Send mid-stream and drop the
      // real turn.done at the turnRunning guard.
      .catch((e: Error) => dispatch({ type: 'error-note', message: e.message }))
  }

  /** Become the session being read. Called from the composer, on send, and nowhere else. */
  async function adoptViewed(): Promise<void> {
    const id = chatState.viewing?.sessionId
    if (client === null || id === undefined) return
    const r = await client.call('sessions.resume', { id })
    onSessionSwitched({
      sessionId: r.sessionId, mode: r.mode, contextLength: r.contextLength, title: r.title,
      gateMode: r.gateMode, problems: r.problems, items: r.items, contextUsed: r.contextUsed, ...(r.compactAt !== undefined ? { compactAt: r.compactAt } : {}),
    })
    setSessionsKey((k) => k + 1)
  }

  function onSessionSwitched(info: SessionSwitch): void {
    dispatch({ type: 'session-switched', ...info })
    if (info.items.length > 0) dispatch({ type: 'transcript-restored', entries: info.items })
    for (const text of info.problems) dispatch({ type: 'settings-problem', text })
    // File tabs survive a session switch — the files are the workspace's, not the
    // session's. A diff tab whose session entry vanished falls back to the git diff.
    // Re-seed the parked-decision count: 'session-switched' resets it to zero, and the
    // host only announces CHANGES — so questions parked by last night's run were invisible
    // the next morning until some unrelated park or resolve happened to fire the event.
    // The queue is file-backed per workspace; opening the app is exactly when it matters.
    client?.call('decisions.list', {})
      .then((r) => dispatch({ type: 'decisions.changed', pending: r.decisions.length }))
      .catch(() => { /* the next decisions.changed event corrects it */ })
  }

  // Stable by construction, and it has to be: `TranscriptRow` is memoised on its props, so
  // an inline arrow recreated on every render would make every row look changed on every
  // streamed token and defeat the memoisation entirely (see transcript.tsx's header).
  const openFileFromTranscript = useCallback((path: string) => {
    openTab(path, 'file')
  }, [openTab])

  /**
   * What a palette choice does. Every branch is something the window already does; the
   * palette is a second way in, not a second implementation.
   */
  function runPaletteAction(c: ProtocolClient, action: PaletteAction): void {
    switch (action.kind) {
      case 'session':
        c.call('sessions.resume', { id: action.id })
          .then((r) => onSessionSwitched({
            sessionId: r.sessionId, mode: r.mode, contextLength: r.contextLength,
            title: r.title, gateMode: r.gateMode, problems: r.problems, items: r.items,
            contextUsed: r.contextUsed,
            ...(r.compactAt !== undefined ? { compactAt: r.compactAt } : {}),
          }))
          .catch((e: Error) => dispatch({ type: 'error-note', message: e.message }))
        return
      case 'file':
        openFileFromTranscript(action.path)
        return
      case 'mode':
        dispatch({ type: 'mode-changed', mode: action.mode })
        c.call('setMode', { mode: action.mode })
          .catch((e: Error) => dispatch({ type: 'error-note', message: e.message }))
        return
      case 'command':
        if (action.id === 'settings') { setSettingsOpen(true); return }
        if (action.id === 'check-updates') {
          // Asked by name, so every outcome is said — the automatic check is the silent one.
          void checkForUpdate().then((r) => {
            switch (r.kind) {
              case 'available': setUpdateError(null); setUpdate(r.update); return
              case 'latest': dispatch({ type: 'error-note', tone: 'info', message: `PrivateCode ${r.currentVersion} is the latest version.` }); return
              case 'failed': dispatch({ type: 'error-note', message: `Could not check for updates: ${r.reason}` }); return
              case 'unavailable': dispatch({ type: 'error-note', tone: 'info', message: 'Updates are only available in the desktop app.' }); return
            }
          })
          return
        }
        if (action.id === 'copy-conversation') {
          // The conversation on SCREEN, which is the viewed session when one is open: what
          // you are reading is what "copy" means.
          const source = chatState.viewing ?? { items: chatState.items, title: chatState.session?.title ?? '' }
          const text = conversationAsMarkdown(source.items, source.title)
          navigator.clipboard.writeText(text).catch(() => { /* platform surface */ })
          return
        }
        c.call('sessions.new', {})
          .then((r) => onSessionSwitched({
            sessionId: r.sessionId, mode: r.mode, contextLength: r.contextLength,
            title: r.title, gateMode: r.gateMode, problems: r.problems, items: r.items,
            contextUsed: r.contextUsed,
            ...(r.compactAt !== undefined ? { compactAt: r.compactAt } : {}),
          }))
          .catch((e: Error) => dispatch({ type: 'error-note', message: e.message }))
    }
  }

  const ready = phase.kind === 'ready'
  const workspaceRoot = phase.kind === 'ready' ? phase.workspace : ''

  return (
    <div class="shell">
      <header class={`titlebar ${isDevBridge ? 'titlebar-no-controls' : ''}`} data-tauri-drag-region>
        <span class="brand" data-tauri-drag-region>
          <span class="brand-mark" aria-hidden="true">{Icon.shield()}</span>
          PrivateCode
        </span>
        {ready && (
          // The NAME, not the folder: a multi-folder workspace whose titlebar showed only
          // its primary folder would be describing a fifth of what the agent can reach.
          <span
            class="titlebar-workspace"
            title={workspaceLabel.folders > 1
              ? `${workspaceLabel.folders} folders · main: ${workspaceRoot}`
              : workspaceRoot}
          >
            {workspaceLabel.name || baseName(workspaceRoot)}
            {workspaceLabel.folders > 1 && (
              <span class="titlebar-folders">+{workspaceLabel.folders - 1}</span>
            )}
          </span>
        )}
        {chatState.session?.title && (
          <span class="titlebar-session" title={chatState.session.title}>{chatState.session.title}</span>
        )}
        <span class="titlebar-spacer" data-tauri-drag-region />
        <span class={`conn-dot conn-${connState}`} title={`agent process: ${connState}`} />
        {/* Reflects what is SHOWN, and is disabled when the window has no room for the
            panel: a toggle that flips a preference nothing can act on reads as broken. */}
        <button
          class={`icon-button ${railShown ? 'icon-button-on' : ''}`}
          onClick={() => setRailOpen((v) => !v)}
          disabled={!railShown && railOpen}
          title={!railShown && railOpen ? 'The window is too narrow for the sessions rail' : 'Sessions (Ctrl+B)'}
        >
          {Icon.sidebar()}
        </button>
        <button
          class={`icon-button ${contextShown ? 'icon-button-on' : ''}`}
          onClick={() => setContextOpen((v) => !v)}
          disabled={!contextShown && contextOpen}
          title={!contextShown && contextOpen ? 'The window is too narrow for the workspace panel' : 'Workspace panel (Ctrl+J)'}
        >
          {Icon.panelRight()}
        </button>
        {!isDevBridge && <WindowControls />}
      </header>

      {/* One grid item, because `.shell` declares exactly three rows and a fourth child would
          land the status bar in an implicit row it was never sized for. Everything that fills
          the middle of the window goes in here. */}
      <div class="stage">
      {/* Above the phase branch, deliberately, so it exists in every one of them.
          It used to live inside the chat pane, which only renders once a workspace is open:
          launching the app and not opening a folder meant never being told an update
          existed — and before starting work is exactly when taking one costs nothing. Found
          by running the real 0.1.0 → 0.1.1 update and looking for the banner that was not
          there. It also belongs on the `unreachable` screen, where a newer build may be the
          fix for whatever is broken. */}
      {updatedNote !== null && update === null && (
        <div class="problem-strip update-strip updated-strip">
          <span class="problem-icon">{Icon.check()}</span>
          <div class="problem-list">
            <div>Updated to PrivateCode {updatedNote.current} from {updatedNote.from}.</div>
          </div>
          <button class="icon-button" onClick={() => setUpdatedNote(null)} title="Dismiss">
            {Icon.x()}
          </button>
        </div>
      )}
      {update !== null && (() => {
        // What the strip says, in the order a person meets it: the offer, then the running
        // update phase by phase, then a failure with the button back so it can be tried again.
        const progress = updating && updateProgress !== null ? describeProgress(updateProgress) : null
        const busy = chatState.turnRunning
        return (
          <div class="problem-strip update-strip">
            <span class="problem-icon">{Icon.check()}</span>
            <div class="problem-list">
              {updateError !== null
                ? <div>Update failed: {updateError}</div>
                : updating
                  ? <div>
                      <div>
                        Updating to PrivateCode {update.newVersion} — {progress?.text ?? 'starting…'}
                      </div>
                      {progress?.fraction !== null && progress?.fraction !== undefined && (
                        <div
                          class="update-progress"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(progress.fraction * 100)}
                        >
                          <div class="update-progress-bar" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
                        </div>
                      )}
                    </div>
                  : <div>
                      PrivateCode {update.newVersion} is available — {formatBytes(update.downloadBytes)} to download.{' '}
                      {busy ? 'It can restart once this turn is over.' : 'The app restarts when it is done.'}
                    </div>}
            </div>
            {!updating && (
              <button
                class="icon-button"
                disabled={busy}
                onClick={startUpdate}
                title={busy
                  ? 'A turn is running — the update can start once it is over'
                  : updateError !== null
                    ? 'Try again'
                    : `Download ${formatBytes(update.downloadBytes)} and restart on ${update.newVersion}`}
              >
                {Icon.check()}
              </button>
            )}
            {/* Not while it runs: closing the strip would not stop the update, and a window
                that then vanishes with no strip on screen is the "out of nowhere" this whole
                feature was rebuilt to remove. */}
            {!updating && (
              <button
                class="icon-button"
                onClick={() => { setDismissedVersion(update.newVersion); setUpdate(null); setUpdateError(null) }}
                title="Not now"
              >
                {Icon.x()}
              </button>
            )}
          </div>
        )
      })()}

      {phase.kind === 'unreachable'
        ? <AgentDown phase={phase} isDevBridge={isDevBridge} />
        : ready && client
        ? (
          <div class="body">
            {railShown && (
              <>
                <aside class="column column-rail" style={{ width: `${columns.rail}px` }}>
                  <SessionsRail
                    client={client}
                    activeSessionId={chatState.session?.sessionId ?? null}
                    viewingSessionId={chatState.viewing?.sessionId ?? null}
                    turnRunning={chatState.turnRunning}
                    onSessionSwitched={onSessionSwitched}
                    onView={(id) => viewSession(client, id)}
                    onOpenSettings={() => setSettingsOpen(true)}
                    reloadKey={sessionsKey}
                  />
                </aside>
                <Splitter side="left" min={MIN_RAIL} max={420} current={columns.rail} onResize={setRailWidth} />
              </>
            )}

            <main class="column column-chat">
              {/* The editor strip appears only once something is open — a permanent
                  one-tab bar would be chrome with no decision behind it. The chat is
                  the first tab and never closes; it keeps streaming while hidden. */}
              {tabs.length > 0 && (
                <div class="editor-tabs" role="tablist">
                  <button
                    class={`editor-tab ${activeTab === null ? 'editor-tab-active' : ''}`}
                    onClick={() => setActiveTab(null)}
                    role="tab"
                    aria-selected={activeTab === null}
                    title="The conversation (Esc)"
                  >
                    {Icon.chat()}
                    <span class="editor-tab-name">Chat</span>
                  </button>
                  {tabs.map((t) => (
                    <button
                      key={t.path}
                      class={`editor-tab ${activeTab === t.path ? 'editor-tab-active' : ''}`}
                      onClick={() => setActiveTab(t.path)}
                      onAuxClick={(e) => { if (e.button === 1) closeTab(t.path) }}
                      role="tab"
                      aria-selected={activeTab === t.path}
                      title={t.path}
                    >
                      {t.face === 'diff' ? Icon.diff() : Icon.file()}
                      <span class="editor-tab-name">{baseName(t.path)}</span>
                      <span
                        class="editor-tab-close"
                        role="button"
                        title="Close"
                        onClick={(e) => { e.stopPropagation(); closeTab(t.path) }}
                      >
                        {Icon.x()}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div class={`chat-face ${activeTab !== null ? 'chat-face-hidden' : ''}`}>
                <Transcript
                  client={client}
                  state={chatState}
                  dispatch={dispatch}
                  onOpenFile={openFileFromTranscript}
                  onBackToLive={() => dispatch({ type: 'viewing-ended' })}
                  // `.chat-face-hidden` is display:none, and an element with no layout box
                  // has no scroll offset to keep — the transcript needs to know it is about
                  // to lose one so it can put it back.
                  offscreen={activeTab !== null}
                />
                {chatState.problems.length > 0 && (
                  <div class="problem-strip">
                    <span class="problem-icon">{Icon.alert()}</span>
                    <div class="problem-list">
                      {chatState.problems.map((p) => <div key={p}>{p}</div>)}
                    </div>
                    <button
                      class="icon-button"
                      onClick={() => dispatch({ type: 'problems-dismissed' })}
                      title="Dismiss"
                    >
                      {Icon.x()}
                    </button>
                  </div>
                )}
                <Composer
                  client={client}
                  state={chatState}
                  dispatch={dispatch}
                  // Every dialog that owns Escape, not just Settings: the composer's
                  // Escape-to-abort is on `window` too, so a dialog this flag forgets is a
                  // dialog you cannot dismiss without killing the running turn. The switcher
                  // stops its own Escape as well; this is the guard the composer documents.
                  modalOpen={modalOpen}
                  onAdoptViewed={adoptViewed}
                  // A send during an update would start a turn the restart then kills.
                  // Spread, not `locked={... : undefined}`: an explicit undefined is not the
                  // same as absent under exactOptionalPropertyTypes.
                  {...(updating ? { locked: 'An update is in progress — the app restarts when it is done' } : {})}
                />
              </div>
              {tabs.map((t) => (activeTab === t.path
                ? (
                  <FileView
                    key={t.path}
                    client={client}
                    path={t.path}
                    face={t.face}
                    onFaceChange={(face) => setTabFace(t.path, face)}
                    entry={changesByPath.get(t.path)}
                    reviewed={(() => {
                      const entry = changesByPath.get(t.path)
                      const mark = reviewed.get(entry?.path ?? t.path)
                      return entry !== undefined && mark !== undefined && entry.id <= mark
                    })()}
                    onMarkReviewed={(entry) => setReviewed((m) => new Map(m).set(entry.path, entry.id))}
                    onReverted={() => setReverts((n) => n + 1)}
                  />
                  )
                : null))}
            </main>

            {contextShown && (
              <>
                <Splitter side="right" min={MIN_CONTEXT} max={720} current={columns.context} onResize={setContextWidth} />
                <aside class="column column-context" style={{ width: `${columns.context}px` }}>
                  <ContextPanel
                    client={client}
                    items={chatState.items}
                    changes={changes}
                    reloadKey={workspaceMutations + reverts + externalChanges}
                    onOpenFile={openTab}
                    hasSession={chatState.session !== null}
                    workspaceRoot={workspaceRoot}
                    workspaceName={workspaceLabel.name || baseName(workspaceRoot)}
                    folderCount={workspaceLabel.folders}
                    isDevBridge={isDevBridge}
                    onReopenWorkspace={() => { if (client) void reopenWorkspace(client, workspaceRoot) }}
                    onSwitchWorkspace={() => setSwitchOpen(true)}
                    // Back to the start screen; nothing on disk is touched, and boot's
                    // auto-connect still remembers this workspace for next launch.
                    onCloseWorkspace={() => {
                      setTabs([])
                      setActiveTab(null)
                      setPhase({ kind: 'welcome', error: null })
                    }}
                    sessionKey={liveSessionId}
                    reviewed={reviewed}
                    onMarkReviewed={(entries) => setReviewed((m) => {
                      const next = new Map(m)
                      for (const entry of entries) next.set(entry.path, entry.id)
                      return next
                    })}
                  />
                </aside>
              </>
            )}
          </div>
          )
        : (
          <div class="welcome">
            <div class="welcome-card">
              <div class="welcome-logo" aria-hidden="true">{Icon.shield()}</div>
              <h1>PrivateCode</h1>
              <p class="welcome-sub">A coding agent that runs entirely on your machine.</p>

              {phase.kind === 'boot' && <p class="welcome-wait">starting the agent…</p>}
              {phase.kind === 'initializing' && (
                <p class="welcome-wait">opening {baseName(phase.workspace)}…</p>
              )}

              {phase.kind === 'welcome' && client && (
                <>
                  {phase.error && <div class="panel-error">{phase.error}</div>}

                  <label class="field-label" for="ws-input">Project folder</label>
                  <div class="field-row">
                    <input
                      id="ws-input"
                      class="input"
                      placeholder={isDevBridge ? 'D:\\Projects\\my-app' : 'pick a folder…'}
                      value={workspaceInput}
                      onInput={(e) => setWorkspaceInput((e.target as HTMLInputElement).value)}
                    />
                    {!isDevBridge && (
                      <button class="btn" onClick={() => void pickWorkspaceDialog()}>Browse…</button>
                    )}
                  </div>

                  {recents.length > 0 && (
                    <div class="recent-list">
                      {recents.slice(0, 5).map((r) => (
                        <button key={r} class="recent-item" title={r} onClick={() => setWorkspaceInput(r)}>
                          {baseName(r)}
                        </button>
                      ))}
                    </div>
                  )}

                  <label class="field-label" for="srv-input">Model server</label>
                  <input
                    id="srv-input"
                    class="input"
                    value={serverInput}
                    onInput={(e) => setServerInput((e.target as HTMLInputElement).value)}
                  />

                  <button
                    class="btn btn-primary welcome-connect"
                    disabled={workspaceInput.trim() === '' || serverInput.trim() === ''}
                    onClick={() => void connect(client, workspaceInput.trim(), serverInput.trim())}
                  >
                    Open workspace
                  </button>
                </>
              )}
            </div>
          </div>
          )}
      </div>

      {client && ready && phase.kind === 'ready' && <StatusBar client={client} chatState={chatState} />}

      {paletteOpen && client && ready && (
        <Palette
          client={client}
          onClose={() => setPaletteOpen(false)}
          onPick={(action) => runPaletteAction(client, action)}
        />
      )}

      {switchOpen && client && (
        <WorkspaceSwitch
          client={client}
          isDevBridge={isDevBridge}
          currentRoot={workspaceRoot}
          onClose={() => setSwitchOpen(false)}
          onSessionSwitched={(info) => { onWorkspaceOpened(info); setSwitchOpen(false) }}
        />
      )}

      {settingsOpen && client && (
        <SettingsModal
          client={client}
          themeSetting={themeSetting}
          onThemeChange={(setting) => {
            setThemeSetting(setting)
            client.call('config.set', { theme: setting }).catch(() => { /* applied for this run anyway */ })
          }}
          {...(chatState.session !== null ? { liveMode: chatState.session.mode } : {})}
          onClose={() => setSettingsOpen(false)}
          onSessionSwitched={(info) => { onWorkspaceOpened(info); setSettingsOpen(false) }}
        />
      )}
    </div>
  )
}
