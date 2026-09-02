import type { VNode } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { ShieldCheck } from 'lucide-preact'
import type { ProtocolClient } from '../lib/client'
import { formatTokenCount } from '../lib/format'
import type { ChatState } from '../lib/state'
import { cn } from '../ui/cn'

/**
 * The window's bottom edge (docs/UI-REDESIGN-2026-09.md §2): the server and its model, the
 * mode, the context in use as a bar with the numbers, the speed, and "private" with the
 * one sentence that is the product's promise. 26 px, 12 px text, tabular figures.
 *
 * The polling and the arithmetic are unchanged from the first status bar and carry its
 * reasons; only the drawing is new.
 */
export function StatusBar({ client, chatState }: { client: ProtocolClient; chatState: ChatState }): VNode {
  const [serverUp, setServerUp] = useState<boolean | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [contextLength, setContextLength] = useState<number | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const turnRunningRef = useRef(chatState.turnRunning)
  turnRunningRef.current = chatState.turnRunning

  // Polls `status` every 10s while IDLE and never during a turn: the server runs with a
  // single slot (`-np 1`), so a health probe fired mid-generation would be a second
  // concurrent request against a server that can only ever serve one. `turnRunning` is in
  // the deps so the poll fires at both edges of a turn.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, chatState.turnRunning])

  // `seq`, not `state`: two 'postponed' events in a row carry the same text and must re-flash.
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
  // Whichever window size was learned most recently: the polled one whenever it exists, the
  // session's frozen copy otherwise (the reasons are in the git history of status.tsx).
  const total = contextLength ?? session?.contextLength ?? null
  const compactAt = lastStep?.compactAt
  const fillPct = used !== undefined && total !== null && total > 0
    ? Math.min(100, Math.round((used / total) * 100))
    : null
  const nearCompaction = used !== undefined && total !== null && used >= (compactAt ?? total * 0.8) * 0.9
  const veryNear = used !== undefined && total !== null && used >= (compactAt ?? total * 0.8) * 0.98

  return (
    <footer class="flex h-[26px] items-center gap-3 border-t border-border-soft bg-panel px-3 font-ui text-[12px] text-dim tabular-nums select-none">
      <span
        class={cn('inline-block size-[7px] shrink-0 rounded-full',
          serverUp === null ? 'bg-faint' : serverUp ? 'bg-green' : 'bg-red')}
        role="img"
        aria-label={serverUp === null ? 'checking the model server' : serverUp ? 'model server is answering' : 'model server is not answering'}
        title={serverUp === null ? 'checking the model server…' : serverUp ? 'model server is answering' : 'model server is not answering'}
      />
      {/* The window size is in the tooltip rather than the bar: it answers a question asked
          once a session ("why is it compacting so often"). */}
      <span
        class={cn('min-w-0 max-w-[260px] truncate', serverUp === false && 'line-through decoration-faint')}
        title={contextLength !== null
          ? `${model ?? 'no model'} — ${formatTokenCount(contextLength)} token context window`
          : 'the model server has not said what it is serving yet'}
      >
        {model ?? (serverUp === false ? 'model: unknown' : 'no model')}
      </span>

      {session && (
        <span class={cn('shrink-0 capitalize', MODE_TONE[session.mode] ?? '')}>{session.mode}</span>
      )}

      {fillPct !== null && used !== undefined && total !== null && (
        <span
          class="flex shrink-0 items-center gap-1.5"
          data-status="context"
          title={lastStep?.estimated === true
            ? 'context in use, estimated from the conversation — the exact figure arrives with the next step'
            : `context used by the last step${compactAt !== undefined ? ` · compacts at ${formatTokenCount(compactAt)}` : ''}`}
        >
          <span class="relative inline-block h-[3px] w-16 overflow-hidden rounded-full bg-active">
            <span
              data-status="fill"
              class={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-(--duration-slow)',
                veryNear ? 'bg-red' : nearCompaction ? 'bg-yellow' : 'bg-blue')}
              style={{ width: `${Math.max(fillPct, used > 0 ? 2 : 0)}%` }}
            />
          </span>
          {formatTokenCount(used)}<span class="text-faint">/</span>{formatTokenCount(total)}
        </span>
      )}

      {lastStep?.tokensPerSecond !== undefined && (
        <span class="shrink-0 text-faint">{lastStep.tokensPerSecond.toFixed(1)} tok/s</span>
      )}
      {lastStep?.draftAcceptance !== undefined && (
        <span class="shrink-0 text-faint" title="speculative-decoding draft acceptance">
          MTP {(lastStep.draftAcceptance * 100).toFixed(0)}%
        </span>
      )}

      {flash && <span class="min-w-0 truncate text-accent">{flash}</span>}
      <span class="flex-1" />
      <span class="flex shrink-0 items-center gap-1 text-faint" title="One connection, to the server you configured. Nothing leaves this machine.">
        <ShieldCheck class="size-3" aria-hidden="true" /> private
      </span>
    </footer>
  )
}

const MODE_TONE: Record<string, string> = {
  plan: 'text-blue',
  'auto-edit': 'text-yellow',
  autopilot: 'text-red',
}

/**
 * What the compaction event means, in five words. Adapted verbatim from the first status
 * bar; `null` for the states that need no flash.
 */
export function compactionFlashText(c: ChatState['lastCompaction']): string | null {
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
