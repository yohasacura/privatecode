import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { FileText, History, RotateCcw } from 'lucide-preact'
import type { CheckpointInfo } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { Markdown } from '../lib/markdown'
import { Button } from '../ui/button'
import { toast } from '../ui/toast'
import { PanelEmpty, PanelError, PanelLoading, PanelNote, PanelRow, PanelSection } from '../components/panel'

/**
 * What the agent changed, and how to put it back (docs/UI-REDESIGN-2026-09.md §7 "History").
 *
 * Checkpoints and the work log share a tab because they are the same question asked twice:
 * "what happened" and "how far back can I go" are answered by the same list of moments.
 *
 * A rewind is the one destructive action this app offers, so it is the only one that asks
 * twice — and the confirmation says what will actually happen, including the part people do
 * not expect (files created since are deleted) and the part that reassures (ignored files,
 * so `node_modules` and build output, are left alone).
 */

/** What the store returns when asked for nothing in particular. Matched here so the first
 * load costs exactly what it always did. */
const DEFAULT_LIMIT = 50
/** Each "further back" step. Enough to cross several hours of a long turn in one click. */
const LIMIT_STEP = 200

type Rewinding =
  | { kind: 'idle' }
  | { kind: 'confirming'; id: string }
  | { kind: 'working' }
  | { kind: 'done'; undo: CheckpointInfo }
  | { kind: 'failed'; why: string }

function timeOf(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const today = new Date().toDateString() === at.toDateString()
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return today ? time : `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

function moment(c: CheckpointInfo): string {
  return c.turn === undefined
    ? 'before anything changed'
    : c.step === undefined ? `after turn ${c.turn}` : `during turn ${c.turn}, at step ${c.step}`
}

export function HistoryTab({
  client, reloadKey,
}: {
  client: ProtocolClient
  /** Bumped by the app whenever a turn ends, so the list follows the work without polling. */
  reloadKey: number
}): VNode {
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[] | null>(null)
  const [log, setLog] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [rewind, setRewind] = useState<Rewinding>({ kind: 'idle' })
  const [showLog, setShowLog] = useState(false)
  /**
   * How far back to ask for. The store's own default is fifty, which used to span days:
   * a turn contributed one checkpoint. A long turn now contributes one every two minutes it
   * writes in, so fifty rows can be a single afternoon, and the point someone actually wants
   * to roll back to sits just past the end of the list with no way to ask for it.
   */
  const [limit, setLimit] = useState(DEFAULT_LIMIT)

  const load = useCallback(() => {
    client.call('checkpoints.list', { limit })
      .then((r) => { setCheckpoints(r.checkpoints); setError(null) })
      .catch((e: Error) => setError(e.message))
    client.call('worklog.read', {})
      .then((r) => setLog(r.text))
      .catch(() => { /* an absent log is the normal state, not something to report */ })
  }, [client, limit])

  useEffect(() => { load() }, [load, reloadKey])

  async function doRewind(id: string): Promise<void> {
    setRewind({ kind: 'working' })
    try {
      const result = await client.call('checkpoints.rewind', { id })
      setRewind({ kind: 'done', undo: result.undo })
      toast.push({
        title: 'Rolled back',
        description: 'Every file is as it was at that checkpoint.',
        tone: 'success',
        action: { label: 'Undo', onClick: () => { void doRewind(result.undo.id) } },
      })
      load()
    } catch (e) {
      setRewind({ kind: 'failed', why: e instanceof Error ? e.message : String(e) })
    }
  }

  if (error !== null) return <PanelError message={error} onRetry={load} />
  if (checkpoints === null) return <PanelLoading />

  return (
    <div data-panel="history" class="overflow-y-auto">
      {rewind.kind === 'done' && (
        <PanelNote tone="good">
          <span class="flex flex-wrap items-center gap-2">
            Rolled back.
            <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => void doRewind(rewind.undo.id)}>
              Undo this rollback
            </Button>
          </span>
        </PanelNote>
      )}
      {rewind.kind === 'failed' && <PanelError message={rewind.why} />}

      {checkpoints.length === 0
        ? (
          <PanelEmpty
            icon={<History />}
            title="No checkpoints yet"
            hint="One is taken before the first turn, after any turn that changes a file, and as a long turn works."
          />
          )
        : (
          <PanelSection title="Checkpoints" count={checkpoints.length}>
            {checkpoints.map((c, i) => (
              <PanelRow
                key={c.id}
                icon={<History />}
                label={
                  <>
                    <span class="mr-2 font-mono text-[11.5px] tabular-nums text-faint">{timeOf(c.at)}</span>
                    {moment(c)}
                  </>
                }
                title={`checkpoint ${c.id}`}
                meta={c.summary}
                open={rewind.kind === 'confirming' && rewind.id === c.id}
                {...(i > 0
                  ? {
                      // The newest checkpoint IS the current state, so offering to restore
                      // it would be a button that does nothing -- worse than absent,
                      // because it implies the others are different in kind.
                      actions: (
                        <Button
                          size="sm"
                          data-action="restore"
                          onClick={() => setRewind({ kind: 'confirming', id: c.id })}
                          disabled={rewind.kind === 'working'}
                        >
                          Restore
                        </Button>
                      ),
                    }
                  : {})}
              >
                <div
                  data-confirm="restore"
                  class="mt-1 rounded-md border border-red-line bg-red-soft p-2.5 font-ui text-[12.5px] leading-[1.45] text-fg"
                >
                  <p class="m-0 mb-1.5">
                    Put every file back as it was {c.turn === undefined ? 'at the start' : c.step === undefined ? `after turn ${c.turn}` : `at step ${c.step} of turn ${c.turn}`}.
                    Files created since are <b>deleted</b>. Ignored files — <code>node_modules</code>,
                    build output — are left alone, so this costs no rebuild.
                  </p>
                  <p class="m-0 mb-2 text-dim">You will be able to undo it straight afterwards.</p>
                  <div class="flex gap-1.5">
                    <Button size="sm" variant="danger" data-autofocus onClick={() => void doRewind(c.id)}>
                      Restore it
                    </Button>
                    <Button size="sm" onClick={() => setRewind({ kind: 'idle' })}>
                      Cancel
                    </Button>
                  </div>
                </div>
              </PanelRow>
            ))}
            {/* Offered only when the list came back full, which is the one case where there
                might be more behind it. A button that reloads the same rows would be a
                button that lies about there being something further back. */}
            {checkpoints.length >= limit && (
              <div class="px-2.5 py-2">
                <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + LIMIT_STEP)}>
                  Look further back
                </Button>
              </div>
            )}
          </PanelSection>
          )}

      <PanelSection title="Work log">
        {log === ''
          ? <PanelRow icon={<FileText />} label="Nothing recorded yet" />
          : (
            <PanelRow
              open={showLog}
              onToggle={() => setShowLog((s) => !s)}
              icon={<FileText />}
              label="What each turn did"
              meta={`${log.trimEnd().split('\n').length} lines`}
            >
              <div class="font-ui text-[12.5px] [&_h1]:text-[13.5px] [&_h2]:mt-3 [&_h2]:text-[12.5px]">
                <Markdown text={log} />
              </div>
            </PanelRow>
            )}
      </PanelSection>
    </div>
  )
}
