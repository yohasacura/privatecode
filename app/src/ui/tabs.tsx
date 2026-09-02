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
export function Tabs<T extends string>({ group, tabs, active, onChange, label, class: klass, dense = false, orientation = 'horizontal' }: {
  /** A short id shared by the list and its panels. */
  group: string
  tabs: readonly TabItem<T>[]
  active: T
  onChange: (id: T) => void
  label: string
  class?: string
  /** Tighter tabs for a narrow panel; labels drop to icons at a container width the CSS decides. */
  dense?: boolean
  /** A vertical list — a settings dialog's left column — moves with Up and Down and marks
   * the active tab with a filled row rather than an underline. */
  orientation?: 'horizontal' | 'vertical'
}): VNode {
  const root = useRef<HTMLDivElement>(null)
  const vertical = orientation === 'vertical'

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
      aria-orientation={orientation}
      class={cn(
        vertical
          ? 'flex flex-col gap-0.5'
          : 'flex min-w-0 gap-0.5 px-1.5 pt-1.5 border-b border-border-soft overflow-x-auto [scrollbar-width:none]',
        klass,
      )}
    >
      {tabs.map((t, i) => {
        const on = t.id === active
        const next = vertical ? 'ArrowDown' : 'ArrowRight'
        const previous = vertical ? 'ArrowUp' : 'ArrowLeft'
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
              if (e.key === next) { e.preventDefault(); focusAt(i + 1) }
              else if (e.key === previous) { e.preventDefault(); focusAt(i - 1) }
              else if (e.key === 'Home') { e.preventDefault(); focusAt(0) }
              else if (e.key === 'End') { e.preventDefault(); focusAt(tabs.length - 1) }
            }}
            class={cn(
              'flex items-center gap-1.5 min-w-0 border-0 bg-transparent font-ui font-medium',
              'cursor-pointer transition-colors duration-(--duration-fast)',
              'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
              vertical
                ? cn('h-8 w-full shrink-0 rounded-sm px-2.5 text-left text-[12.5px]', on ? 'bg-active text-fg' : 'text-dim hover:bg-hover hover:text-fg')
                : cn(
                  'shrink border-b-2 -mb-px',
                  dense ? 'h-7 px-2 text-[12px]' : 'h-8 px-2.5 text-[12.5px]',
                  on ? 'text-fg border-accent' : 'text-faint border-transparent hover:text-fg',
                ),
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
