import { invoke } from '@tauri-apps/api/core'

/**
 * "A new version is available."
 *
 * The whole feature is one question and one button, and the restraint is the design. This is
 * an offline tool: it works with no network at all, and a check nobody asked for must never be
 * able to make it look broken. So every failure here is silence — no banner, no error row, no
 * retry storm. If GitHub is unreachable, or the machine has no route out, or the manifest is
 * malformed, the app simply carries on being the app.
 *
 * It runs ONCE, a little after startup rather than during it: launching is the moment a person
 * is waiting on, and nothing here is urgent. There is no polling loop — a person who leaves the
 * window open for a week does not need to be told about a release every hour.
 *
 * The number shown is what the update would actually DOWNLOAD, not the size of the release.
 * Those are very different here: the release is ~124 MB but a routine update is ~3 MB, because
 * the 368 MB of pinned binaries only move when a PROVENANCE file does. Showing the release size
 * would make every update look like a reason to say no.
 */

export interface UpdateAvailable {
  currentVersion: string
  newVersion: string
  /** What taking this update would cost in bytes, over the wire. */
  downloadBytes: number
  notesUrl: string
}

/** Present only inside the Tauri shell; the dev bridge runs in a plain browser tab. */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** How long after startup to look. Long enough that launching is not competing with it. */
const CHECK_DELAY_MS = 20_000

interface RawCheck {
  available: boolean
  current_version: string
  new_version: string
  download_bytes: number
  notes_url: string
}

/**
 * Asks once whether there is something newer. Resolves to null for "no" AND for every kind of
 * "could not find out" — the caller has nothing useful to do with the difference, and an
 * offline tool that complains about being offline is a bug.
 */
export async function checkForUpdate(): Promise<UpdateAvailable | null> {
  if (!inTauri()) return null
  try {
    const raw = await invoke<RawCheck>('check_for_update')
    if (!raw.available) return null
    return {
      currentVersion: raw.current_version,
      newVersion: raw.new_version,
      downloadBytes: raw.download_bytes,
      notesUrl: raw.notes_url,
    }
  } catch {
    return null
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

/** Bytes as a person reads them. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`
}

/**
 * Runs the one check, after a delay, and hands the answer back. Returns a cancel function so a
 * window that closes first does not fire it.
 */
export function scheduleUpdateCheck(
  onAvailable: (u: UpdateAvailable) => void,
  delayMs: number = CHECK_DELAY_MS,
): () => void {
  const timer = setTimeout(() => {
    void checkForUpdate().then((u) => { if (u !== null) onAvailable(u) })
  }, delayMs)
  return () => clearTimeout(timer)
}
