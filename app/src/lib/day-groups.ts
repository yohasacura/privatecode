/**
 * Sessions by day: "Today", "Yesterday", the weekday for the rest of the week, then the
 * date. Pure over `now`, so the labels can be tested without a clock.
 */
export interface DayGroup<T> {
  label: string
  items: T[]
}

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function dayLabel(when: Date, now: Date): string {
  const days = Math.round((startOfDay(now) - startOfDay(when)) / DAY_MS)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return when.toLocaleDateString(undefined, { weekday: 'long' })
  if (when.getFullYear() === now.getFullYear()) return when.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

/** Newest first within a group; groups in the order the items arrive (newest first too). */
export function groupByDay<T>(items: readonly T[], at: (item: T) => string, now: Date = new Date()): DayGroup<T>[] {
  const sorted = [...items].sort((a, b) => Date.parse(at(b)) - Date.parse(at(a)))
  const groups: DayGroup<T>[] = []
  for (const item of sorted) {
    const parsed = new Date(at(item))
    const label = Number.isNaN(parsed.getTime()) ? 'Undated' : dayLabel(parsed, now)
    const last = groups[groups.length - 1]
    if (last !== undefined && last.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}
