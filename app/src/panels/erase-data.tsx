import { useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Icon } from '../components/icons'
import { formatBytes } from '../lib/update'
import { type EraseScan, eraseLocalData, scanLocalData } from '../lib/erase'

/**
 * "Remove everything on this computer", and the confirmation it is owed.
 *
 * There is no undo behind this button and no copy of any of it anywhere else — that is the
 * whole proposition of the tool. So the panel does not ask "are you sure": it SHOWS the
 * actual folders, their actual sizes, and where they are, produced by the same code that
 * will delete them. A person can then check the list against what they believe is there,
 * which is a question they can answer; "are you sure" is not.
 *
 * The reveal is two-step for the same reason. The list is not shown until asked for, and the
 * button that acts is not on screen until the list is — so the irreversible control cannot be
 * reached by one stray click on a settings tab.
 */
export function EraseEverything(): VNode {
  const [scan, setScan] = useState<EraseScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [armed, setArmed] = useState(false)
  const [erasing, setErasing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Set when there is no shell to ask — the dev bridge, or a plain browser tab. */
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    // Nothing is deleted by looking, so the list is fetched on open rather than behind a
    // button: seeing what is there is the ordinary reason to visit this tab.
    setScanning(true)
    scanLocalData()
      .then((result) => {
        if (result === null) setUnavailable(true)
        else setScan(result)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setScanning(false))
  }, [])

  if (unavailable) {
    return (
      <div class="field-hint">
        Erasing local data is only available in the desktop app.
      </div>
    )
  }

  const present = scan?.targets.filter((t) => t.exists) ?? []

  return (
    <div class="erase">
      <div class="field-label">Everything this app has written on this computer</div>

      {scanning && <div class="field-hint loading-quiet">looking…</div>}
      {error !== null && <div class="panel-error">{error}</div>}

      {scan !== null && (
        <>
          <div class="erase-list">
            {scan.targets.map((t) => (
              <div key={t.path} class={`erase-row ${t.exists ? '' : 'erase-row-gone'}`}>
                <span class="erase-row-label">{t.label}</span>
                <span class="erase-row-path" title={t.path}>{t.path}</span>
                <span class="erase-row-size">
                  {/* A remembered folder that is no longer there is listed and marked,
                      rather than dropped: an entry missing from a list headed "everything
                      that will be deleted" reads as an omission, not as an absence. */}
                  {t.exists ? formatBytes(t.bytes) : 'not there'}
                </span>
              </div>
            ))}
            {scan.targets.length === 0 && (
              <div class="field-hint">Nothing found — there is nothing to erase.</div>
            )}
          </div>

          {present.length > 0 && (
            <div class="erase-total">
              {present.length} folder{present.length === 1 ? '' : 's'} ·{' '}
              {formatBytes(scan.totalBytes)}
            </div>
          )}

          <div class="field-hint">
            This removes settings, permissions, skills, AGENTS.md, and every conversation and
            checkpoint in every project listed above. It does not touch your code. The app
            restarts afterwards and comes back as if it had never been run.
          </div>

          {present.length > 0 && (
            armed ? (
              <div class="erase-armed">
                <div class="erase-armed-title">
                  {Icon.alert()} There is no undo, and no copy anywhere else.
                </div>
                <div class="erase-armed-row">
                  <button
                    class="btn btn-danger"
                    disabled={erasing}
                    onClick={() => {
                      setErasing(true)
                      setError(null)
                      // Only ever RESOLVES on failure — success replaces this process.
                      void eraseLocalData().then((problem) => {
                        setError(problem)
                        setErasing(false)
                        setArmed(false)
                      })
                    }}
                  >
                    {erasing ? 'Erasing…' : 'Erase it all and restart'}
                  </button>
                  <button class="btn" disabled={erasing} onClick={() => setArmed(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button class="btn btn-danger modal-primary" onClick={() => setArmed(true)}>
                {Icon.trash()} Erase all of it…
              </button>
            )
          )}
        </>
      )}
    </div>
  )
}
