import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import { Icon } from '../components/icons'
import type { SessionSwitch } from './sessions-rail'

/**
 * The workspace switcher — a switcher, not a form.
 *
 * It used to be a detour through Settings: pick a recent, then find and press «Open
 * workspace» further down a page that also offered the server URL and a folder editor.
 * The owner looked for switching on the Workspace tab and did not recognise Settings as
 * the answer. Here a recent IS a button: one click opens it. Browse (or a typed path on
 * the dev bridge) covers everything that is not recent.
 */
export function WorkspaceSwitch({
  client, isDevBridge, currentRoot, onClose, onSessionSwitched,
}: {
  client: ProtocolClient
  /** The native folder picker is a Tauri plugin; the dev bridge types a path instead. */
  isDevBridge: boolean
  currentRoot: string
  onClose: () => void
  onSessionSwitched: (
    info: SessionSwitch & { workspaceRoot: string; workspaceName: string; folderCount: number },
  ) => void
}): VNode {
  const [recents, setRecents] = useState<string[]>([])
  const [serverUrl, setServerUrl] = useState('http://127.0.0.1:8080')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)

  useEffect(() => {
    client.call('config.get', {})
      .then((r) => {
        setRecents(r.recentWorkspaces)
        if (r.serverUrl !== undefined) setServerUrl(r.serverUrl)
      })
      .catch(() => { /* recents are a convenience; Browse still works */ })
  }, [client])

  // Capture phase AND stopped, the same shape the palette uses. This listener and the
  // composer's Escape-to-abort are both on `window`, so a plain bubble-phase close let the
  // one keypress travel on and call `abort`: dismissing this dialog killed a running turn —
  // and this dialog is reachable, and never disabled, WHILE a turn or an unattended run is
  // streaming. Settings escapes that only because App passes `modalOpen` to the composer for
  // it; owning the key here means this dialog does not depend on being remembered there.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  // Same dialog behaviour Settings earned the hard way: focus moves in, Tab wraps,
  // the opener gets focus back on close.
  const modalRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    modalRef.current?.focus()
    return () => opener?.focus()
  }, [])
  function trapTab(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return
    const focusables = modalRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled])',
    )
    if (!focusables || focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    if (document.activeElement === modalRef.current) {
      e.preventDefault()
      ;(e.shiftKey ? last : first).focus()
      return
    }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  function open(root: string): void {
    const trimmed = root.trim()
    if (trimmed === '' || opening !== null) return
    setOpening(trimmed)
    setError(null)
    client.call('init', { workspaceRoot: trimmed, serverUrl, continueLast: true })
      .then((r) => {
        client.call('config.set', { serverUrl, recentWorkspace: trimmed }).catch(() => {})
        onSessionSwitched({
          sessionId: r.sessionId, mode: r.mode, contextLength: r.contextLength, title: r.title,
          problems: r.problems, items: r.items, workspaceRoot: trimmed,
          workspaceName: r.workspaceName, folderCount: r.folderCount,
          contextUsed: r.contextUsed,
        })
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        setOpening(null)
      })
  }

  async function browse(): Promise<void> {
    const { open: pick } = await import('@tauri-apps/plugin-dialog')
    const result = await pick({ directory: true, multiple: false })
    if (typeof result === 'string') open(result)
  }

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div
        class="modal modal-narrow"
        role="dialog"
        aria-modal="true"
        aria-label="Switch workspace"
        tabindex={-1}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div class="modal-head">
          <b>Switch workspace</b>
          <button class="icon-button" onClick={onClose} title="Close">{Icon.x()}</button>
        </div>

        {recents.length > 0 && (
          <>
            <div class="field-label">Recent — click to open</div>
            <div class="recent-list">
              {recents.map((w) => {
                const isCurrent = w.toLowerCase() === currentRoot.toLowerCase()
                return (
                  <button
                    key={w}
                    class={`recent-item ${isCurrent ? 'recent-item-active' : ''}`}
                    disabled={isCurrent || opening !== null}
                    title={isCurrent ? 'Already open' : w}
                    onClick={() => open(w)}
                  >
                    {opening === w ? 'Opening…' : w}
                    {isCurrent && <span class="tag">current</span>}
                  </button>
                )
              })}
            </div>
          </>
        )}

        {isDevBridge
          ? (
            <input
              class="input"
              value={typed}
              placeholder="paste a folder path — Enter opens it"
              disabled={opening !== null}
              onInput={(e) => setTyped(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') open(typed) }}
            />
            )
          : (
            <button class="btn" disabled={opening !== null} onClick={() => void browse()}>
              {Icon.folder()} Browse…
            </button>
            )}

        {error !== null && <div class="panel-error">{error}</div>}

        <div class="field-hint">
          Opening a workspace picks up its most recent session. The current one keeps its
          sessions and files.
        </div>
      </div>
    </div>
  )
}
