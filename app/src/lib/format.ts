/**
 * Small display formatters shared by the transcript, the status bar and the side panels.
 * Pure and clock-free except where a clock is unavoidable (`relativeTime` takes `now` as a
 * parameter so it stays testable and so a caller with a ticker can pass its own).
 */

/** `42.3k` / `1.2M` / `487` -- never more than one decimal, never a suffix under 1000. */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

/**
 * A running generation's own account of where it is, as one short phrase.
 *
 * Two phases, and which one is showing is the point. `reading 12.4k / 18.1k · 9.7k cached`
 * is prefill — the server is working through the prompt and nothing streams, which is the
 * silence that used to read as a freeze. `1.2k tokens · 61 tok/s` is generation.
 *
 * The cached figure stays even at zero, spelled `none cached`, because zero is the loudest
 * reading there is: it means the prefix diverged and the whole prompt is being re-read, which
 * on this machine is the difference between half a second and half a minute. A bare `0` in a
 * row of numbers is easy to skim past; `none` is not.
 *
 * Null when there is nothing measured to say, which is what a caller falls back from.
 */
export function formatProgress(progress: {
  prompt?: { processed: number; total: number; cache: number }
  generated?: { tokens: number; perSecond?: number }
}): string | null {
  const { prompt, generated } = progress
  if (generated !== undefined && generated.tokens > 0) {
    const rate = generated.perSecond !== undefined && generated.perSecond > 0
      ? ` · ${Math.round(generated.perSecond)} tok/s`
      : ''
    return `${formatTokenCount(generated.tokens)} tokens${rate}`
  }
  if (prompt !== undefined && prompt.total > 0) {
    const cached = prompt.cache > 0 ? `${formatTokenCount(prompt.cache)} cached` : 'none cached'
    // Clamped because the two numbers come from different counters on the server, and a
    // "19.0k / 18.1k" would read as a bug in the app rather than as the last batch of a
    // finished prefill.
    const processed = Math.min(prompt.processed, prompt.total)
    return `reading ${formatTokenCount(processed)} / ${formatTokenCount(prompt.total)} · ${cached}`
  }
  return null
}

/** `0.8s` / `12s` / `3m 04s` / `1h 12m` -- a duration a human reads at a glance. */
export function formatDuration(ms: number): string {
  const s = ms / 1000
  if (s < 1) return `${s.toFixed(1)}s`
  if (s < 59.5) return `${Math.round(s)}s`
  // Split AFTER rounding to whole seconds: rounding the remainder on its own turned
  // 119.6s into "1m 60s" on a live step — floor(1.99)=1 minute next to round(59.6)=60.
  const whole = Math.round(s)
  const m = Math.floor(whole / 60)
  if (m < 60) return `${m}m ${String(whole % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** `just now` / `4m ago` / `2h ago` / `3d ago` / an ISO date once it is older than a week. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const diff = Math.max(0, now - then)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(then).toISOString().slice(0, 10)
}

/** Last path segment -- `small-crm`, not `D:\Projects\small-crm`. */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** Middle-elides a long path so both ends stay readable in a narrow column. */
export function ellipsizePath(path: string, max = 44): string {
  if (path.length <= max) return path
  const keepEnd = Math.floor((max - 1) * 0.7)
  const keepStart = max - 1 - keepEnd
  return `${path.slice(0, keepStart)}…${path.slice(path.length - keepEnd)}`
}
