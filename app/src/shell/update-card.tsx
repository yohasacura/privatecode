import type { VNode } from 'preact'
import { Download, RefreshCw, X } from 'lucide-preact'
import type { UpdateAvailable, UpdateProgress } from '../lib/update'
import { describeProgress, formatBytes } from '../lib/update'
import { Button, IconButton } from '../ui/button'
import { cn } from '../ui/cn'

/**
 * The update, as a card (docs/UI-REDESIGN-2026-09.md §8 "Toasts and strips"): the offer,
 * then the running update phase by phase with a bar for the download, then a failure with
 * the button back so it can be tried again. Sits above the composer once a workspace is
 * open, and at the top of the start screen before one is — the moment before starting
 * work is exactly when taking an update costs nothing.
 *
 * Not dismissible while it runs: closing the card would not stop the update, and a window
 * that then vanishes with no card on screen is the "out of nowhere" the feature was
 * rebuilt to remove.
 */
export function UpdateCard({
  update, updating, progress, error, busy, onStart, onDismiss, class: klass,
}: {
  update: UpdateAvailable
  updating: boolean
  progress: UpdateProgress | null
  error: string | null
  /** A turn is running: the update can start once it is over. */
  busy: boolean
  onStart: () => void
  onDismiss: () => void
  class?: string
}): VNode {
  const step = updating && progress !== null ? describeProgress(progress) : null
  const fraction = step?.fraction ?? null
  return (
    <div
      data-update=""
      data-state={error !== null ? 'failed' : updating ? 'running' : 'offered'}
      role="status"
      class={cn(
        'flex items-start gap-3 rounded-md border px-3 py-2.5 font-ui text-[12.5px] leading-[1.45] text-fg shadow-(--shadow-pop)',
        error !== null ? 'border-red-line bg-red-soft' : 'border-accent-line bg-panel',
        klass,
      )}
    >
      <span class={cn('mt-0.5 inline-flex shrink-0 [&>svg]:size-4', error !== null ? 'text-red' : 'text-accent')}>
        {error !== null ? <RefreshCw /> : <Download />}
      </span>
      <div class="min-w-0 flex-1">
        {error !== null
          ? <div><span class="font-medium">Update failed.</span> {error}</div>
          : updating
            ? (
              <div>
                <div>Updating to PrivateCode {update.newVersion} — {step?.text ?? 'starting…'}</div>
                {fraction !== null && (
                  <div
                    class="mt-1.5 h-1 overflow-hidden rounded-full bg-active"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(fraction * 100)}
                  >
                    <div
                      data-update-bar=""
                      class="h-full rounded-full bg-accent transition-[width] duration-(--duration-normal)"
                      style={{ width: `${Math.round(fraction * 100)}%` }}
                    />
                  </div>
                )}
              </div>
              )
            : (
              <div>
                <span class="font-medium">PrivateCode {update.newVersion} is available</span> — {formatBytes(update.downloadBytes)} to download.{' '}
                <span class="text-dim">{busy ? 'It can restart once this turn is over.' : 'The app restarts when it is done.'}</span>
              </div>
              )}
      </div>
      {!updating && (
        <span class="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant={error !== null ? 'secondary' : 'primary'}
            disabled={busy}
            onClick={onStart}
            data-action="update"
            title={busy
              ? 'A turn is running — the update can start once it is over'
              : error !== null
                ? 'Try again'
                : `Download ${formatBytes(update.downloadBytes)} and restart on ${update.newVersion}`}
          >
            {error !== null ? 'Try again' : 'Update'}
          </Button>
          <IconButton size="sm" label="Not now" onClick={onDismiss}><X /></IconButton>
        </span>
      )}
    </div>
  )
}
