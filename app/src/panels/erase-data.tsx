import { useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Trash2, TriangleAlert } from 'lucide-preact'
import { PanelError, PanelLoading, PanelNote } from '../components/panel'
import { CopyablePath, SettingHint, SettingLabel } from '../components/settings-bits'
import { Button } from '../ui/button'
import { cn } from '../ui/cn'
import { Input } from '../ui/input'
import { formatBytes } from '../lib/update'
import { type EraseScan, eraseLocalData, scanLocalData } from '../lib/erase'

/**
 * "Remove everything on this computer", and the confirmation it is owed
 * (docs/UI-REDESIGN-2026-09.md §8 "Data").
 *
 * There is no undo behind this button and no copy of any of it anywhere else — that is the
 * whole proposition of the tool. So the panel does not ask "are you sure": it SHOWS the
 * actual folders, their actual sizes, and where they are, produced by the same code that
 * will delete them. A person can then check the list against what they believe is there,
 * which is a question they can answer; "are you sure" is not. The last step asks for the
 * word to be typed, because a button that erases years of checkpoints must not be one
 * stray click from a settings tab.
 */

const CONFIRM_WORD = 'erase'

export function EraseEverything(): VNode {
  const [scan, setScan] = useState<EraseScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [armed, setArmed] = useState(false)
  const [typed, setTyped] = useState('')
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
      <div data-erase="unavailable" class="font-ui">
        <SettingLabel>Everything this app has written on this computer</SettingLabel>
        <SettingHint>Erasing local data is only available in the desktop app.</SettingHint>
      </div>
    )
  }

  const present = scan?.targets.filter((t) => t.exists) ?? []
  const ready = typed.trim().toLowerCase() === CONFIRM_WORD

  return (
    <div data-erase="" class="font-ui">
      <SettingLabel>Everything this app has written on this computer</SettingLabel>

      {scanning && <PanelLoading what="looking…" />}
      {error !== null && <PanelError message={error} />}

      {scan !== null && (
        <>
          <div class="flex flex-col gap-1">
            {scan.targets.map((t) => (
              <div key={t.path} class={cn('flex items-center gap-2 text-[12.5px]', !t.exists && 'opacity-55')} data-erase-row="">
                <span class="w-36 shrink-0 text-fg">{t.label}</span>
                <div class="min-w-0 flex-1"><CopyablePath path={t.path} /></div>
                <span class="w-20 shrink-0 text-right font-mono text-[11.5px] tabular-nums text-faint">
                  {/* A remembered folder that is no longer there is listed and marked,
                      rather than dropped: an entry missing from a list headed "everything
                      that will be deleted" reads as an omission, not as an absence. */}
                  {t.exists ? formatBytes(t.bytes) : 'not there'}
                </span>
              </div>
            ))}
            {scan.targets.length === 0 && (
              <SettingHint>Nothing found — there is nothing to erase.</SettingHint>
            )}
          </div>

          {present.length > 0 && (
            <div class="mt-2 text-[12px] text-dim">
              {present.length} folder{present.length === 1 ? '' : 's'} ·{' '}
              {formatBytes(scan.totalBytes)}
            </div>
          )}

          <SettingHint>
            This removes settings, permissions, skills, AGENTS.md, and every conversation and
            checkpoint in every project listed above. It does not touch your code. The app
            restarts afterwards and comes back as if it had never been run.
          </SettingHint>

          {present.length > 0 && (
            armed ? (
              <PanelNote tone="bad" inset class="mt-4">
                <div class="flex items-center gap-2 font-semibold">
                  <span class="inline-flex [&>svg]:size-4"><TriangleAlert /></span>
                  There is no undo, and no copy anywhere else.
                </div>
                <div class="mt-2 text-[12px] text-fg">
                  Type <code>{CONFIRM_WORD}</code> to confirm.
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-1.5">
                  <Input
                    class="w-40 font-mono"
                    value={typed}
                    aria-label={`Type ${CONFIRM_WORD} to confirm`}
                    placeholder={CONFIRM_WORD}
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    onInput={(e) => setTyped(e.currentTarget.value)}
                  />
                  <Button
                    variant="danger"
                    icon={<Trash2 />}
                    disabled={erasing || !ready}
                    loading={erasing}
                    data-action="erase"
                    onClick={() => {
                      setErasing(true)
                      setError(null)
                      // Only ever RESOLVES on failure — success replaces this process.
                      void eraseLocalData().then((problem) => {
                        setError(problem)
                        setErasing(false)
                        setArmed(false)
                        setTyped('')
                      })
                    }}
                  >
                    Erase it all and restart
                  </Button>
                  <Button disabled={erasing} onClick={() => { setArmed(false); setTyped('') }}>
                    Cancel
                  </Button>
                </div>
              </PanelNote>
            ) : (
              <Button variant="danger" class="mt-4" icon={<Trash2 />} onClick={() => setArmed(true)} data-action="arm-erase">
                Erase all of it…
              </Button>
            )
          )}
        </>
      )}
    </div>
  )
}
