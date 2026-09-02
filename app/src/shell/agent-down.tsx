import type { VNode } from 'preact'
import { useState } from 'preact/hooks'
import { AlertTriangle } from 'lucide-preact'
import { restartSidecar } from '../lib/client'
import { Button } from '../ui/button'

/**
 * The agent-unreachable screen (docs/UI-REDESIGN-2026-09.md §3): what went wrong, what the
 * agent printed on its way out, and a way back. It replaces the state the app was actually
 * in the first time it was run for real — "starting the agent…" forever, with no error,
 * no diagnostics and no recovery.
 */
export function AgentDown({ reason, stderr, isDevBridge }: {
  reason: string
  stderr: string[]
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
    <div class="flex h-full items-center justify-center overflow-auto p-6 font-ui">
      <div class="flex w-[520px] max-w-full flex-col gap-4 rounded-lg border border-border bg-panel p-6 shadow-(--shadow-sm)">
        <div class="flex items-center gap-3">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-md bg-red-soft text-red">
            <AlertTriangle class="size-5" aria-hidden="true" />
          </span>
          <div class="min-w-0">
            <h1 class="m-0 text-[17px] font-semibold leading-tight text-fg-strong">The agent isn’t running</h1>
            <p class="m-0 mt-0.5 text-[13px] text-dim">{reason}.</p>
          </div>
        </div>

        {stderr.length > 0
          ? (
            <div class="flex flex-col gap-1.5">
              <div class="text-[12px] font-medium text-dim">What it printed</div>
              <pre class="m-0 max-h-[240px] overflow-auto rounded-sm border border-border-soft bg-bg p-3 font-mono text-[12px] leading-[1.5] text-dim whitespace-pre-wrap break-words">
                {stderr.slice(-40).join('\n')}
              </pre>
            </div>
            )
          : (
            <p class="m-0 text-[12.5px] text-faint">
              It left no output, which usually means the process was killed rather than that it
              failed on its own.
            </p>
            )}

        {isDevBridge
          ? (
            <p class="m-0 text-[12.5px] text-faint">
              This window is running against the dev bridge. Restart it with
              {' '}<code class="font-mono text-dim">npm run host:dev</code> and reload.
            </p>
            )
          : (
            <Button variant="primary" class="self-start" loading={restarting} onClick={restart}>
              {restarting ? 'Restarting…' : 'Restart the agent'}
            </Button>
            )}
      </div>
    </div>
  )
}
