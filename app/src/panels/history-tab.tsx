import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { CheckpointInfo } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { Markdown } from '../lib/markdown'
import { Icon } from '../components/icons'
import { PanelEmpty, PanelError, PanelRow, PanelSection } from '../components/panel'

/**
 * What the agent changed, and how to put it back.
 *
 * Checkpoints and the work log share a tab because they are the same question asked twice:
 * "what happened" and "how far back can I go" are answered by the same list of moments.
 *
 * A rewind is the one destructive action this app offers, so it is the only one that asks
 * twice — and the confirmation says what will actually happen, including the part people do
 * not expect (files created since are deleted) and the part that reassures (ignored files,
 * so `node_modules` and build output, are left alone).
 */

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

  const load = useCallback(() => {
    client.call('checkpoints.list', {})
      .then((r) => { setCheckpoints(r.checkpoints); setError(null) })
      .catch((e: Error) => setError(e.message))
    client.call('worklog.read', {})
      .then((r) => setLog(r.text))
      .catch(() => { /* an absent log is the normal state, not something to report */ })
  }, [client])

  useEffect(() => { load() }, [load, reloadKey])

  async function doRewind(id: string): Promise<void> {
    setRewind({ kind: 'working' })
    try {
      const result = await client.call('checkpoints.rewind', { id })
      setRewind({ kind: 'done', undo: result.undo })
      load()
    } catch (e) {
      setRewind({ kind: 'failed', why: e instanceof Error ? e.message : String(e) })
    }
  }

  if (error !== null) return <PanelError message={error} onRetry={load} />
  if (checkpoints === null) return <div class="panel-placeholder">loading…</div>

  return (
    <div class="history">
      {rewind.kind === 'done' && (
        <div class="history-note">
          Rolled back.{' '}
          <button class="link-button" onClick={() => void doRewind(rewind.undo.id)}>
            Undo this rollback
          </button>
        </div>
      )}
      {rewind.kind === 'failed' && <PanelError message={rewind.why} />}

      {checkpoints.length === 0
        ? (
          <PanelEmpty
            icon={Icon.history()}
            title="No checkpoints yet"
            hint="One is taken before the first turn, and after any turn that changes a file."
          />
          )
        : (
          <PanelSection title="Checkpoints" count={checkpoints.length}>
            {checkpoints.map((c, i) => (
              <PanelRow
                key={c.id}
                icon={Icon.history()}
                label={
                  <>
                    <span class="ckpt-when">{timeOf(c.at)}</span>
                    {c.turn !== undefined ? `after turn ${c.turn}` : 'before anything changed'}
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
                        <button
                          class="btn btn-small"
                          onClick={() => setRewind({ kind: 'confirming', id: c.id })}
                          disabled={rewind.kind === 'working'}
                        >
                          Restore
                        </button>
                      ),
                    }
                  : {})}
              >
                <div class="ckpt-confirm">
                  <p>
                    Put every file back as it was {c.turn !== undefined ? `after turn ${c.turn}` : 'at the start'}.
                    Files created since are <b>deleted</b>. Ignored files — <code>node_modules</code>,
                    build output — are left alone, so this costs no rebuild.
                  </p>
                  <p class="ckpt-confirm-undo">You will be able to undo it straight afterwards.</p>
                  <div class="ckpt-confirm-actions">
                    <button class="btn btn-danger btn-small" onClick={() => void doRewind(c.id)}>
                      Restore it
                    </button>
                    <button class="btn btn-small" onClick={() => setRewind({ kind: 'idle' })}>
                      Cancel
                    </button>
                  </div>
                </div>
              </PanelRow>
            ))}
          </PanelSection>
          )}

      <PanelSection title="Work log">
        {log === ''
          ? <PanelRow icon={Icon.file()} label="Nothing recorded yet" />
          : (
            <PanelRow
              open={showLog}
              onToggle={() => setShowLog((s) => !s)}
              icon={Icon.file()}
              label="What each turn did"
              meta={`${log.trimEnd().split('\n').length} lines`}
            >
              <div class="history-log-body"><Markdown text={log} /></div>
            </PanelRow>
            )}
      </PanelSection>
    </div>
  )
}
