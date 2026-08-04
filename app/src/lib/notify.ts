/**
 * Telling you something happened while you were not looking.
 *
 * Everything the app built for long runs — parking a question instead of blocking on it,
 * stopping for a named reason, a budget that ends the run — assumes you walked away. All of
 * it is worth nothing if the only way to learn it happened is to come back and check. The
 * agent parks a question at 02:00; this is what makes you find out at 02:00.
 *
 * Two channels, because one of them is always wrong on its own: a system notification, which
 * you see if you are at the machine doing something else, and a taskbar flash, which is
 * still there ten minutes later when you walk back. Neither fires while the window is
 * focused — you are already looking at the thing.
 *
 * Everything here degrades to nothing. In the dev bridge there is no Tauri at all; if the
 * notification permission is refused, the taskbar flash still happens; if both fail, the
 * in-window banner the caller shows is the whole story. A failure to notify must never be
 * able to take down a window that is otherwise working.
 */

export type NotifyKind = 'question' | 'run-ended' | 'approval'

/** Present only inside the Tauri shell; the dev bridge runs in a plain browser tab. */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Focused windows get nothing: you are already looking at it. `document.hasFocus()` is the
 * honest question — not `visibilityState`, which is still 'visible' for a window sitting
 * behind another one. */
export function windowIsWatched(): boolean {
  return typeof document !== 'undefined' && document.hasFocus()
}

/**
 * Whether an event is worth interrupting for. Pure, and separate from the platform calls,
 * because this is the part with a wrong answer: a notification for something you are
 * already watching trains you to dismiss them, and after that the 02:00 one does not work
 * either.
 */
export function shouldAnnounce(env: { focused: boolean; tauri: boolean }): boolean {
  return env.tauri && !env.focused
}

/** Whether a change in the parked-decision count is news. Only a RISE is: the count also
 * falls as you answer them, and being notified about your own clicks is noise. */
export function decisionsAreNews(before: number, after: number): boolean {
  return after > before
}

async function flashTaskbar(): Promise<void> {
  const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window')
  await getCurrentWindow().requestUserAttention(UserAttentionType.Informational)
}

async function systemNotification(title: string, body: string): Promise<void> {
  const mod = await import('@tauri-apps/plugin-notification')
  let allowed = await mod.isPermissionGranted()
  if (!allowed) allowed = (await mod.requestPermission()) === 'granted'
  if (allowed) mod.sendNotification({ title, body })
}

/**
 * Announces something worth interrupting for, unless the window is already being watched.
 *
 * Returns whether anything was actually sent, so a caller can tell "nothing to say" from
 * "said it" without inspecting platform state itself.
 */
export async function notify(title: string, body: string): Promise<boolean> {
  if (!shouldAnnounce({ focused: windowIsWatched(), tauri: inTauri() })) return false
  // Both are attempted independently: a refused notification permission must not cost the
  // taskbar flash, which needs no permission at all.
  const results = await Promise.allSettled([systemNotification(title, body), flashTaskbar()])
  return results.some((r) => r.status === 'fulfilled')
}
