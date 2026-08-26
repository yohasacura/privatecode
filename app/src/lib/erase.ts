import { invoke } from '@tauri-apps/api/core'

/**
 * "Remove everything this program has written on this computer."
 *
 * Two calls, and the split is the point. Nothing here decides WHAT gets deleted — the shell
 * derives that list itself, from the machine, and this side can only ask to see it or ask for
 * it to be carried out. A command that took paths from the window would be a
 * delete-anything primitive sitting one bug away from a webview.
 *
 * So `scanLocalData` exists purely so the confirmation can show the real list and the real
 * size, produced by the same code that will act on it, rather than a description written
 * beside it that can drift out of agreement.
 */

export interface EraseTarget {
  /** What it is, in the words a person can check: "Project data — D:\proj". */
  label: string
  path: string
  bytes: number
  /** A path that is remembered but no longer on disk. Shown anyway: a silent omission from a
   * list headed "everything that will be deleted" is the wrong kind of surprise. */
  exists: boolean
}

export interface EraseScan {
  targets: EraseTarget[]
  totalBytes: number
}

/** Present only inside the Tauri shell; the dev bridge runs in a plain browser tab. */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

interface RawScan {
  targets: EraseTarget[]
  total_bytes: number
}

/**
 * What an erase would remove. `null` when there is no shell to ask — the dev bridge, a
 * browser tab — which is also the signal for the panel to say so rather than offer a button
 * that cannot work.
 */
export async function scanLocalData(): Promise<EraseScan | null> {
  if (!inTauri()) return null
  const raw = await invoke<RawScan>('scan_local_data')
  return { targets: raw.targets, totalBytes: raw.total_bytes }
}

/**
 * Deletes it all and restarts.
 *
 * Only returns on FAILURE — on success this process is replaced, so there is no "it worked"
 * to render. A returned string means nothing was restarted and some of it is still on disk,
 * which is the one outcome that must never be presented as success: coming back on a
 * first-run screen with a transcript still on disk would tell the person their data is gone
 * when it is not.
 */
export async function eraseLocalData(): Promise<string> {
  if (!inTauri()) return 'this is only available in the desktop app'
  try {
    await invoke('erase_local_data')
    // Reached only if the shell returned without replacing the process, which it should
    // never do. Saying so beats a silent no-op.
    return 'the app did not restart; nothing can be assumed about what was removed'
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
