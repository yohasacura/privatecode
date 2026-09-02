import { useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Folder, FolderOpen } from 'lucide-preact'
import type { ProtocolClient } from '../lib/client'
import { PanelError } from '../components/panel'
import { SettingHint, SettingLabel } from '../components/settings-bits'
import { Button } from '../ui/button'
import { Chip } from '../ui/chip'
import { cn } from '../ui/cn'
import { Dialog } from '../ui/dialog'
import { Input } from '../ui/input'
import type { SessionSwitch } from './sessions-rail'

/**
 * The workspace switcher — a switcher, not a form (docs/UI-REDESIGN-2026-09.md §8).
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
  const [missing, setMissing] = useState<string[]>([])
  const [serverUrl, setServerUrl] = useState('http://127.0.0.1:8080')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)

  useEffect(() => {
    client.call('config.get', {})
      .then((r) => {
        setRecents(r.recentWorkspaces)
        setMissing(r.missingWorkspaces ?? [])
        if (r.serverUrl !== undefined) setServerUrl(r.serverUrl)
      })
      .catch(() => { /* recents are a convenience; Browse still works */ })
  }, [client])

  function open(root: string): void {
    const trimmed = root.trim()
    if (trimmed === '' || opening !== null) return
    setOpening(trimmed)
    setError(null)
    client.call('init', { workspaceRoot: trimmed, serverUrl, continueLast: true })
      .then((r) => {
        client.call('config.set', { serverUrl, recentWorkspace: trimmed }).catch(() => {})
        onSessionSwitched({
          sessionId: r.sessionId, mode: r.mode, gateMode: r.gateMode, contextLength: r.contextLength, title: r.title,
          problems: r.problems, items: r.items, workspaceRoot: trimmed,
          workspaceName: r.workspaceName, folderCount: r.folderCount,
          contextUsed: r.contextUsed,
          // `session-switched` writes compactAt unguarded, so an undefined here would
          // replace a real trigger with the 80%-of-window fallback until the next step.done.
          ...(r.compactAt !== undefined ? { compactAt: r.compactAt } : {}),
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
    <Dialog
      open
      onClose={onClose}
      title="Switch workspace"
      description="Opening a workspace picks up its most recent session. The current one keeps its sessions and files."
      size="sm"
    >
      <div data-workspace-switch="" class="font-ui">
        {recents.length > 0 && (
          <>
            <SettingLabel>Recent — click to open</SettingLabel>
            <div class="flex flex-col gap-0.5" role="list">
              {recents.map((w) => {
                const isCurrent = w.toLowerCase() === currentRoot.toLowerCase()
                const gone = missing.includes(w)
                return (
                  <button
                    key={w}
                    type="button"
                    role="listitem"
                    data-recent={w}
                    disabled={isCurrent || gone || opening !== null}
                    title={isCurrent ? 'Already open' : gone ? 'This folder is no longer on disk' : w}
                    onClick={() => open(w)}
                    class={cn(
                      'flex w-full min-w-0 items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left font-mono text-[12px]',
                      'transition-colors duration-(--duration-fast)',
                      'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
                      isCurrent || gone ? 'cursor-default text-faint' : 'cursor-pointer text-fg hover:bg-hover',
                    )}
                  >
                    <span class="inline-flex shrink-0 text-faint [&>svg]:size-3.5">{isCurrent ? <FolderOpen /> : <Folder />}</span>
                    <span class="min-w-0 flex-1 truncate" dir="rtl"><span dir="ltr">{opening === w ? 'Opening…' : w}</span></span>
                    {isCurrent && <Chip tone="accent">current</Chip>}
                    {gone && <Chip tone="red">missing</Chip>}
                  </button>
                )
              })}
            </div>
          </>
        )}

        <div class="mt-4">
          {isDevBridge
            ? (
              <Input
                data-workspace-path=""
                class="font-mono text-[12px]"
                value={typed}
                placeholder="paste a folder path — Enter opens it"
                aria-label="Folder to open"
                disabled={opening !== null}
                onInput={(e) => setTyped(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') open(typed) }}
              />
              )
            : (
              <Button icon={<FolderOpen />} disabled={opening !== null} loading={opening !== null} onClick={() => void browse()}>
                Browse…
              </Button>
              )}
        </div>

        {error !== null && <PanelError message={error} />}

        <SettingHint>A workspace is a folder, or a few of them, that the agent may read and edit. Nothing outside it is touched.</SettingHint>
      </div>
    </Dialog>
  )
}
