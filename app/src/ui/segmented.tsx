import type { VNode } from 'preact'
import { useRef } from 'preact/hooks'
import { cn } from './cn'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  /** One sentence, as the tooltip. */
  hint?: string
  /** A colour the chosen segment takes, for options that mean something (Plan, Autopilot). */
  tone?: 'accent' | 'blue' | 'yellow' | 'red'
  disabled?: boolean
}

const TONE_ON: Record<NonNullable<SegmentedOption<string>['tone']>, string> = {
  accent: 'text-accent',
  blue: 'text-blue',
  yellow: 'text-yellow',
  red: 'bg-red-soft text-red',
}

/**
 * One of a few, all visible, the chosen one raised. A radiogroup: arrows move AND choose,
 * Home/End jump, Tab leaves the group. Disabled as a whole while the session cannot change.
 */
export function Segmented<T extends string>({ options, value, onChange, label, disabled = false, size = 'md', class: klass }: {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  /** The group's accessible name. */
  label: string
  disabled?: boolean
  size?: 'sm' | 'md'
  class?: string
}): VNode {
  const root = useRef<HTMLDivElement>(null)

  function move(from: number, delta: number): void {
    const enabled = options.map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled)
    if (enabled.length === 0) return
    const at = Math.max(0, enabled.findIndex(({ i }) => i === from))
    const next = enabled[(at + delta + enabled.length) % enabled.length]!
    onChange(next.o.value)
    root.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next.i]?.focus()
  }

  function onKey(e: KeyboardEvent, index: number): void {
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': e.preventDefault(); move(index, 1); break
      case 'ArrowLeft': case 'ArrowUp': e.preventDefault(); move(index, -1); break
      case 'Home': e.preventDefault(); move(-1, 1); break
      case 'End': e.preventDefault(); move(options.length, -1); break
    }
  }

  return (
    <div
      ref={root}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      class={cn(
        'inline-flex gap-px p-0.5 rounded-[7px] border border-border-soft bg-bg',
        disabled && 'opacity-45',
        klass,
      )}
    >
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled || o.disabled}
            title={o.hint}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            class={cn(
              'rounded-[5px] border-0 font-ui font-medium whitespace-nowrap cursor-pointer',
              'transition-colors duration-(--duration-fast)',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
              'disabled:cursor-default',
              size === 'sm' ? 'h-5 px-2 text-[11.5px]' : 'h-6 px-2.5 text-[12px]',
              on
                ? cn('bg-active text-fg shadow-[inset_0_0_0_1px_var(--border)]', o.tone !== undefined && TONE_ON[o.tone])
                : 'bg-transparent text-dim hover:enabled:bg-hover hover:enabled:text-fg',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
