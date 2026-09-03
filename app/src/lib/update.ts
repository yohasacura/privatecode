import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * "A new version is available."
 *
 * The whole feature is one question and one button, and the restraint is the design. This is
 * an offline tool: it works with no network at all, and a check nobody asked for must never be
 * able to make it look broken. So every failure of the AUTOMATIC check is silence — no banner,
 * no error row, no retry storm. If GitHub is unreachable, or the machine has no route out, or
 * the manifest is malformed, the app simply carries on being the app. A check the person asked
 * for by name (the palette's "Check for updates") is the one place "could not check" is said.
 *
 * It runs a little after startup rather than during it: launching is the moment a person is
 * waiting on, and nothing here is urgent. After that, once every twelve hours while the window
 * stays open — a window left open for a week should hear about a release without a restart,
 * and twice a day is nowhere near a nag.
 *
 * The number shown is what the update would actually DOWNLOAD, not the size of the release.
 * Those are very different here: the release is ~124 MB but a routine update is ~3 MB, because
 * the 368 MB of pinned binaries only move when a PROVENANCE file does. Showing the release size
 * would make every update look like a reason to say no.
 *
 * While an update runs, the shell reports every step as an `update-progress` event and the
 * banner follows it — the download by bytes, the rest by name. Before that existed the banner
 * said "Downloading…" for the whole of a 4–125 MB transfer and then the window vanished, which
 * is what "it works but it is jerky" looked like from the chair.
 */

export interface UpdateAvailable {
  currentVersion: string
  newVersion: string
  /** What taking this update would cost in bytes, over the wire. */
  downloadBytes: number
  notesUrl: string
  /** The version is already this one; only the agent's runtime tree is behind. The folder an
   * updater up to 0.4.0 leaves: it could swap the app but never the tree (see update.rs). */
  sidecarOnly?: boolean
}

/** One step of a running update, as the shell reports it. */
export interface UpdateProgress {
  phase: 'manifest' | 'downloading' | 'verifying' | 'unpacking' | 'installing' | 'restarting'
  /** The archive being handled, during `downloading`, `verifying` and `unpacking`. */
  part: string | null
  /** Bytes so far and in all, during `downloading`; zeros otherwise. */
  received: number
  total: number
}

/** Present only inside the Tauri shell; the dev bridge runs in a plain browser tab. */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** How long after startup to look. Long enough that launching is not competing with it. */
const CHECK_DELAY_MS = 20_000
/** And how often after that, while the window stays open. */
const RECHECK_INTERVAL_MS = 12 * 60 * 60_000

interface RawCheck {
  available: boolean
  current_version: string
  new_version: string
  download_bytes: number
  notes_url: string
  sidecar_only?: boolean
}

/** What a check the person asked for comes back with — every outcome named, none silent. */
export type ManualCheck =
  | { kind: 'available'; update: UpdateAvailable }
  | { kind: 'latest'; currentVersion: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'unavailable' }

/**
 * Asks once whether there is something newer, and says exactly what it found. The automatic
 * path collapses everything but `available` into silence; the palette shows all four.
 */
export async function checkForUpdate(): Promise<ManualCheck> {
  if (!inTauri()) return { kind: 'unavailable' }
  try {
    const raw = await invoke<RawCheck>('check_for_update')
    if (!raw.available) return { kind: 'latest', currentVersion: raw.current_version }
    return {
      kind: 'available',
      update: {
        currentVersion: raw.current_version,
        newVersion: raw.new_version,
        downloadBytes: raw.download_bytes,
        notesUrl: raw.notes_url,
        sidecarOnly: raw.sidecar_only === true,
      },
    }
  } catch (e) {
    return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Downloads, verifies and swaps, then relaunches. Only returns if something went wrong — on
 * success the process has already been replaced.
 *
 * The verification is not decoration: every downloaded byte is checked against the SHA-256 in
 * the manifest BEFORE anything on disk is touched, and the running executable is renamed aside
 * rather than overwritten, so a failure at the last step leaves the old version in place.
 */
export async function applyUpdate(): Promise<string | null> {
  if (!inTauri()) return 'updates are only available in the desktop app'
  try {
    await invoke('apply_update')
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/**
 * Follow a running update. The unlisten is returned so a window that closes mid-update does
 * not keep a dead callback subscribed; outside the shell there is nothing to follow.
 */
export async function onUpdateProgress(cb: (p: UpdateProgress) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => {}
  try {
    return await listen<UpdateProgress>('update-progress', (event) => cb(event.payload))
  } catch {
    return () => {}
  }
}

/** Did the previous process update into this one? Asked once, at startup. */
export async function updatedFrom(): Promise<{ currentVersion: string; updatedFrom: string | null } | null> {
  if (!inTauri()) return null
  try {
    const raw = await invoke<{ current_version: string; updated_from: string | null }>('update_startup_info')
    return { currentVersion: raw.current_version, updatedFrom: raw.updated_from }
  } catch {
    return null
  }
}

/**
 * An update that stopped the agent to swap its runtime tree and then failed leaves the
 * shell with a fresh agent and this window with a dead transport. The honest way back is
 * the same one the agent-down screen takes — reload — and the failure is carried across the
 * reload here so the card can say what happened instead of the update silently vanishing.
 * `sessionStorage` because it lives exactly as long as this window and no longer.
 */
const FAILURE_KEY = 'privatecode.update-failure'

export interface StashedFailure {
  update: UpdateAvailable
  error: string
}

export function stashUpdateFailure(update: UpdateAvailable, error: string): void {
  try {
    sessionStorage.setItem(FAILURE_KEY, JSON.stringify({ update, error }))
  } catch {
    // Storage refused: the reload still happens, the card just will not explain itself.
  }
}

/** Read once and cleared, so the next launch of this window is an ordinary one. */
export function takeUpdateFailure(): StashedFailure | null {
  try {
    const raw = sessionStorage.getItem(FAILURE_KEY)
    if (raw === null) return null
    sessionStorage.removeItem(FAILURE_KEY)
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { update, error } = parsed as Partial<StashedFailure>
    if (typeof error !== 'string' || typeof update !== 'object' || update === null) return null
    if (typeof update.newVersion !== 'string' || typeof update.downloadBytes !== 'number') return null
    return { update, error }
  } catch {
    return null
  }
}

/** Bytes as a person reads them. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`
}

/**
 * The line under the bar, and how full the bar is — `null` for the phases that take under a
 * second, where a bar would only flicker.
 */
export function describeProgress(p: UpdateProgress): { text: string; fraction: number | null } {
  switch (p.phase) {
    case 'manifest':
      return { text: 'Checking the release…', fraction: null }
    case 'downloading': {
      const total = p.total > 0 ? p.total : null
      const text = total === null
        ? `Downloading ${p.part ?? ''}… ${formatBytes(p.received)}`
        : `Downloading ${p.part ?? ''}… ${formatBytes(p.received)} of ${formatBytes(total)}`
      return { text: text.replace(/\s{2,}/g, ' '), fraction: total === null ? null : Math.min(1, p.received / total) }
    }
    case 'verifying':
      return { text: 'Verifying the download…', fraction: 1 }
    case 'unpacking':
      return { text: 'Unpacking…', fraction: 1 }
    case 'installing':
      return { text: 'Installing…', fraction: 1 }
    case 'restarting':
      return { text: 'Restarting…', fraction: 1 }
  }
}

/**
 * Runs the check after a delay, then every `intervalMs` while the window stays open, and
 * hands the answer back whenever there is one. Returns a cancel function so a window that
 * closes first does not fire it.
 */
export function scheduleUpdateCheck(
  onAvailable: (u: UpdateAvailable) => void,
  delayMs: number = CHECK_DELAY_MS,
  intervalMs: number = RECHECK_INTERVAL_MS,
): () => void {
  const check = (): void => {
    void checkForUpdate().then((r) => { if (r.kind === 'available') onAvailable(r.update) })
  }
  const timer = setTimeout(check, delayMs)
  const interval = setInterval(check, intervalMs)
  return () => { clearTimeout(timer); clearInterval(interval) }
}
