import type { VNode } from 'preact'
import { useRef } from 'preact/hooks'
import { cn } from './cn'

export interface TabItem<T extends string> {
  id: T
  label: string
  icon?: VNode
  /** A count beside the label; hidden when zero. */
  badge?: number
}

/** The id the matching panel should carry, so `aria-controls` and `aria-labelledby` agree. */
export function tabPanelId(group: string, id: string): string {
  return `${group}-panel-${id}`
}

/**
 * A tablist over `tabs`. Arrows move focus and select (Home/End jump); Tab leaves the
 * list. The panel is the caller's — render it with `tabPanelId` and role="tabpanel".
 */
export function Tabs<T extends string>({ group, tabs, active, onChange, label, class: klass, dense = false }: {
  /** A short id shared by the list and its panels. */
  group: string
  tabs: readonly TabItem<T>[]
  active: T
  onChange: (id: T) => void
  label: string
  class?: string
  /** Tighter tabs for a narrow panel; labels drop to icons at a container width the CSS decides. */
  dense?: boolean
}): VNode {
  const root = useRef<HTMLDivElement>(null)

  function focusAt(index: number): void {
    const i = (index + tabs.length) % tabs.length
    onChange(tabs[i]!.id)
    root.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[i]?.focus()
  }

  return (
    <div
      ref={root}
      role="tablist"
      aria-label={label}
      class={cn('flex min-w-0 gap-0.5 px-1.5 pt-1.5 border-b border-border-soft overflow-x-auto [scrollbar-width:none]', klass)}
    >
      {tabs.map((t, i) => {
        const on = t.id === active
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${group}-tab-${t.id}`}
            aria-selected={on}
            aria-controls={tabPanelId(group, t.id)}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') { e.preventDefault(); focusAt(i + 1) }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); focusAt(i - 1) }
              else if (e.key === 'Home') { e.preventDefault(); focusAt(0) }
              else if (e.key === 'End') { e.preventDefault(); focusAt(tabs.length - 1) }
            }}
            class={cn(
              'flex items-center gap-1.5 shrink min-w-0 border-0 border-b-2 bg-transparent font-ui font-medium',
              'cursor-pointer transition-colors duration-(--duration-fast) -mb-px',
              'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
              dense ? 'h-7 px-2 text-[12px]' : 'h-8 px-2.5 text-[12.5px]',
              on ? 'text-fg border-accent' : 'text-faint border-transparent hover:text-fg',
            )}
          >
            {t.icon !== undefined && <span class="inline-flex shrink-0 [&>svg]:size-3.5">{t.icon}</span>}
            <span class="truncate">{t.label}</span>
            {t.badge !== undefined && t.badge > 0 && (
              <span class="inline-flex items-center h-4 min-w-4 px-1 rounded-full bg-accent-soft text-accent text-[10.5px] font-semibold tabular-nums">
                {t.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
