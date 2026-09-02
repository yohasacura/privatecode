import type { VNode } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { ChevronDown, Minus, PanelLeft, PanelRight, Square, X } from 'lucide-preact'
import { Icon } from '../components/icons'
import type { ConnectionState } from '../lib/client'
import { IconButton } from '../ui/button'
import { cn } from '../ui/cn'
import { Tooltip } from '../ui/tooltip'

/**
 * The window's top edge, and the frame the OS no longer draws (docs/UI-REDESIGN-2026-09.md §2).
 *
 * Left: the mark and the name, then the workspace as a button — its name, "+2" when there
 * are more folders, a chevron — that opens the switcher. Centre: the session title. Right:
 * the connection dot with the process's state, the two panel toggles, and the three window
 * controls at the size Windows draws them. The whole bar is the drag region; the buttons
 * are not, which is what makes them clickable.
 *
 * The dev bridge is a browser tab: no window, no controls, and the right padding comes back.
 */
export function TitleBar({
  isDevBridge, ready, workspaceName, workspaceRoot, folders, sessionTitle, connState,
  railShown, railOpen, onToggleRail, contextShown, contextOpen, onToggleContext, onSwitchWorkspace,
}: {
  isDevBridge: boolean
  ready: boolean
  workspaceName: string
  workspaceRoot: string
  folders: number
  sessionTitle: string | null
  connState: ConnectionState
  railShown: boolean
  railOpen: boolean
  onToggleRail: () => void
  contextShown: boolean
  contextOpen: boolean
  onToggleContext: () => void
  onSwitchWorkspace: () => void
}): VNode {
  const railBlocked = !railShown && railOpen
  const contextBlocked = !contextShown && contextOpen
  return (
    <header
      class={cn(
        'flex h-[38px] items-center gap-2 overflow-hidden border-b border-border-soft bg-panel pl-3 select-none font-ui',
        isDevBridge && 'pr-2',
      )}
      data-tauri-drag-region
    >
      <span class="flex shrink-0 items-center gap-1.5 text-[12.5px] font-semibold text-fg" data-tauri-drag-region>
        <span class="flex text-accent" aria-hidden="true">{Icon.shield()}</span>
        PrivateCode
      </span>

      {ready && (
        <Tooltip text={folders > 1 ? `${folders} folders · main: ${workspaceRoot}` : workspaceRoot} side="bottom">
          <button
            type="button"
            onClick={onSwitchWorkspace}
            class={cn(
              'flex min-w-0 max-w-[320px] shrink items-center gap-1 h-6 rounded-sm border-0 bg-raised px-2 text-[12.5px] font-medium text-dim',
              'cursor-pointer transition-colors duration-(--duration-fast) hover:bg-hover hover:text-fg',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
            )}
          >
            <span class="truncate">{workspaceName}</span>
            {folders > 1 && <span class="shrink-0 rounded-[4px] bg-active px-1 text-[10.5px] text-faint">+{folders - 1}</span>}
            <ChevronDown class="size-3 shrink-0 text-faint" aria-hidden="true" />
          </button>
        </Tooltip>
      )}

      {sessionTitle !== null && sessionTitle !== '' && (
        <span class="min-w-0 max-w-[360px] shrink truncate text-[12.5px] text-faint" title={sessionTitle}>
          {sessionTitle}
        </span>
      )}

      <span class="h-full flex-1" data-tauri-drag-region />

      <Tooltip text={CONN_TEXT[connState]} side="bottom">
        <span
          class={cn('mx-1 inline-block size-[7px] shrink-0 rounded-full', CONN_DOT[connState])}
          role="img"
          aria-label={`agent process: ${connState}`}
        />
      </Tooltip>

      {/* Reflects what is SHOWN, and is disabled when the window has no room for the
          panel: a toggle that flips a preference nothing can act on reads as broken. */}
      <IconButton
        label={railBlocked ? 'The window is too narrow for the sessions rail' : 'Sessions (Ctrl+B)'}
        active={railShown}
        disabled={railBlocked}
        onClick={onToggleRail}
      >
        <PanelLeft />
      </IconButton>
      <IconButton
        label={contextBlocked ? 'The window is too narrow for the workspace panel' : 'Workspace panel (Ctrl+J)'}
        active={contextShown}
        disabled={contextBlocked}
        onClick={onToggleContext}
      >
        <PanelRight />
      </IconButton>

      {!isDevBridge && <WindowControls />}
    </header>
  )
}

const CONN_DOT: Record<ConnectionState, string> = {
  open: 'bg-green',
  connecting: 'bg-yellow',
  closed: 'bg-red',
}
const CONN_TEXT: Record<ConnectionState, string> = {
  open: 'The agent process is running.',
  connecting: 'Starting the agent process…',
  closed: 'The agent process is not running — restart it from the welcome screen.',
}

/**
 * Minimize, maximize/restore, close — drawn by the window because the OS frame is off. Each
 * reaches the Tauri window API lazily and swallows its absence: in the browser dev bridge
 * there is no window to control, and the controls are not rendered there at all.
 */
export function WindowControls(): VNode {
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
  const base =
    'inline-flex h-full w-[46px] shrink-0 items-center justify-center border-0 bg-transparent text-dim ' +
    'transition-colors duration-(--duration-fast) hover:bg-hover hover:text-fg active:bg-active [&>svg]:size-[10px]'
  return (
    <div class="ml-0.5 flex h-full shrink-0 self-stretch" data-window-controls>
      <button type="button" class={base} onClick={() => act('minimize')} title="Minimize" aria-label="Minimize">
        <Minus />
      </button>
      <button
        type="button"
        class={base}
        onClick={() => act('toggle')}
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? Icon.winRestore() : <Square />}
      </button>
      <button
        type="button"
        class={cn(base, 'hover:bg-(--danger-strong) hover:text-(--on-danger-strong) active:bg-(--danger-strong-active)')}
        onClick={() => act('close')}
        title="Close"
        aria-label="Close"
      >
        <X />
      </button>
    </div>
  )
}
