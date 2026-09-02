import type { VNode } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { FolderOpen, RefreshCw, X } from 'lucide-preact'
import type { ServerProbeResult } from '@core/host/protocol'
import { Icon } from '../components/icons'
import type { ProtocolClient } from '../lib/client'
import { baseName, formatTokenCount } from '../lib/format'
import { Button, IconButton, Spinner } from '../ui/button'
import { cn } from '../ui/cn'
import { Field, Input } from '../ui/input'

/**
 * The first screen (docs/UI-REDESIGN-2026-09.md §3): the two things the app needs — a
 * project folder and a model server — each with its own sentence for each way it can be
 * wrong, and an Open button that is enabled only when both are known to be good.
 *
 * The server is probed while the person types (debounced), so "nothing is listening at
 * :8080" is on screen before the click rather than after it. A recent folder that no
 * longer exists says so on its row and can be forgotten from there.
 */
export type WelcomePhase =
  | { kind: 'boot' }
  | { kind: 'initializing'; workspace: string }
  | { kind: 'welcome'; error: string | null }

export interface WelcomeProps {
  client: ProtocolClient | null
  phase: WelcomePhase
  isDevBridge: boolean
  version: string | null
  recents: string[]
  missing: string[]
  workspace: string
  onWorkspaceChange: (value: string) => void
  server: string
  onServerChange: (value: string) => void
  onBrowse: () => void
  onForget: (path: string) => void
  onOpen: (workspace: string, server: string) => void
  onCheckForUpdates?: () => void
}

type Probe =
  | { state: 'idle' }
  | { state: 'probing' }
  | { state: 'done'; result: ServerProbeResult }

export function Welcome(props: WelcomeProps): VNode {
  const { client, phase, isDevBridge, version, recents, missing, workspace, server } = props
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })
  const probeSeq = useRef(0)

  // Ask the host about the server 400 ms after the last keystroke; a stale answer (typing
  // continued) is dropped by the sequence number.
  useEffect(() => {
    if (client === null || phase.kind !== 'welcome') return
    const url = server.trim()
    const seq = ++probeSeq.current
    if (url === '') { setProbe({ state: 'idle' }); return }
    setProbe({ state: 'probing' })
    const timer = setTimeout(() => {
      client.call('server.probe', { serverUrl: url })
        .then((result) => { if (probeSeq.current === seq) setProbe({ state: 'done', result }) })
        .catch((e: unknown) => {
          if (probeSeq.current !== seq) return
          setProbe({ state: 'done', result: { reachable: false, reason: e instanceof Error ? e.message : String(e) } })
        })
    }, 400)
    return () => clearTimeout(timer)
  }, [client, phase.kind, server])

  const folderMissing = workspace.trim() !== '' && missing.includes(workspace.trim())
  const serverOk = probe.state === 'done' && probe.result.reachable
  const canOpen = phase.kind === 'welcome' && client !== null && workspace.trim() !== '' && !folderMissing && serverOk

  return (
    <div class="flex h-full items-center justify-center overflow-auto p-6 font-ui">
      <div data-screen="welcome" class="flex w-[480px] max-w-full flex-col gap-5 rounded-lg border border-border bg-panel p-6 shadow-(--shadow-sm)">
        <div class="flex items-center gap-3">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent [&>svg]:size-5" aria-hidden="true">
            {Icon.shield()}
          </span>
          <div class="min-w-0">
            <h1 class="m-0 text-[17px] font-semibold leading-tight text-fg-strong">PrivateCode</h1>
            <p class="m-0 mt-0.5 text-[13px] text-dim">A coding agent that runs entirely on your machine.</p>
          </div>
        </div>

        {phase.kind === 'boot' && <Waiting>starting the agent…</Waiting>}
        {phase.kind === 'initializing' && <Waiting>opening {baseName(phase.workspace)}…</Waiting>}

        {phase.kind === 'welcome' && (
          <>
            {phase.error !== null && (
              <div role="alert" class="rounded-sm border border-red-line bg-red-soft px-3 py-2 text-[12.5px] text-red">
                {phase.error}
              </div>
            )}

            <Field
              label="Project folder"
              htmlFor="ws-input"
              {...(folderMissing ? { error: 'This folder no longer exists — pick another, or forget it below.' } : {})}
            >
              <div class="flex gap-2">
                <Input
                  id="ws-input"
                  class="font-mono"
                  placeholder={isDevBridge ? 'D:\\Projects\\my-app' : 'pick a folder…'}
                  value={workspace}
                  invalid={folderMissing}
                  onInput={(e) => props.onWorkspaceChange((e.target as HTMLInputElement).value)}
                />
                {!isDevBridge && (
                  <Button icon={<FolderOpen />} onClick={props.onBrowse}>Browse…</Button>
                )}
              </div>
            </Field>

            {recents.length > 0 && (
              <ul class="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="Recent folders">
                {recents.slice(0, 5).map((r) => {
                  const gone = missing.includes(r)
                  return (
                    <li key={r} class="flex items-center gap-1">
                      <button
                        type="button"
                        title={gone ? `${r} — not found` : r}
                        onClick={() => props.onWorkspaceChange(r)}
                        class={cn(
                          'flex min-w-0 flex-1 items-center gap-2 h-8 rounded-sm border-0 bg-transparent px-2 text-left',
                          'cursor-pointer transition-colors duration-(--duration-fast) hover:bg-hover',
                          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
                          gone && 'opacity-60',
                        )}
                      >
                        <span class="shrink-0 text-faint [&>svg]:size-3.5">{Icon.folder()}</span>
                        <span class={cn('truncate text-[13px]', gone ? 'text-dim line-through' : 'text-fg')}>{baseName(r)}</span>
                        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{r}</span>
                        {gone && <span class="shrink-0 text-[11px] text-red">not found</span>}
                      </button>
                      <IconButton label={`Forget ${baseName(r)}`} size="sm" onClick={() => props.onForget(r)}>
                        <X />
                      </IconButton>
                    </li>
                  )
                })}
              </ul>
            )}

            <Field label="Model server" htmlFor="srv-input">
              <Input
                id="srv-input"
                class="font-mono"
                value={server}
                invalid={probe.state === 'done' && !probe.result.reachable}
                onInput={(e) => props.onServerChange((e.target as HTMLInputElement).value)}
              />
              <ServerStatus probe={probe} onRetry={() => props.onServerChange(server)} />
            </Field>

            <Button
              variant="primary"
              class="w-full"
              disabled={!canOpen}
              title={canOpen ? undefined : folderMissing ? 'The folder does not exist' : workspace.trim() === '' ? 'Pick a project folder' : 'Waiting for the model server'}
              onClick={() => { if (client !== null) props.onOpen(workspace.trim(), server.trim()) }}
            >
              Open workspace
            </Button>
          </>
        )}

        <div class="flex items-center justify-between text-[11.5px] text-faint">
          <span>{version !== null ? `PrivateCode ${version}` : ''}</span>
          {props.onCheckForUpdates !== undefined && (
            <button type="button" class="border-0 bg-transparent p-0 text-[11.5px] text-faint hover:text-fg cursor-pointer" onClick={props.onCheckForUpdates}>
              Check for updates
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Waiting({ children }: { children: preact.ComponentChildren }): VNode {
  return (
    <div class="flex items-center gap-2 text-[13px] text-dim" role="status">
      <Spinner class="text-accent" />
      {children}
    </div>
  )
}

/** One line under the server field: probing, reachable with what it serves, or why not. */
function ServerStatus({ probe, onRetry }: { probe: Probe; onRetry: () => void }): VNode | null {
  if (probe.state === 'idle') return null
  if (probe.state === 'probing') {
    return (
      <div class="flex items-center gap-1.5 text-[12px] text-faint" role="status">
        <Spinner class="size-3! border-[1.5px]" /> checking…
      </div>
    )
  }
  const r = probe.result
  if (r.reachable) {
    return (
      <div class="flex items-center gap-1.5 text-[12px] text-green" role="status">
        <span class="inline-block size-1.5 rounded-full bg-green" />
        reachable — {r.model ?? 'a model'}{r.contextLength !== undefined ? `, ${formatTokenCount(r.contextLength)} token context` : ''}
      </div>
    )
  }
  return (
    <div class="flex items-start gap-1.5 text-[12px] text-red" role="alert">
      <span class="mt-1.5 inline-block size-1.5 shrink-0 rounded-full bg-red" />
      <span class="min-w-0 flex-1">{r.reason ?? 'not reachable'}</span>
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1 border-0 bg-transparent p-0 text-[12px] text-dim hover:text-fg cursor-pointer"
        onClick={onRetry}
        title="Try again"
      >
        <RefreshCw class="size-3" aria-hidden="true" /> retry
      </button>
    </div>
  )
}
