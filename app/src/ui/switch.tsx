import type { VNode } from 'preact'
import { cn } from './cn'

/**
 * On or off, with its label beside it. A real `role="switch"`: Space and Enter toggle,
 * the state is announced, and the whole label is the target.
 */
export function Switch({ checked, onChange, label, hint, disabled = false, size = 'md', class: klass }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  /** One sentence, as the tooltip. */
  hint?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  class?: string
}): VNode {
  const track = size === 'sm' ? 'w-6 h-3.5' : 'w-7 h-4'
  const knob = size === 'sm' ? 'size-2.5' : 'size-3'
  const travel = size === 'sm' ? 'translate-x-[10px]' : 'translate-x-3'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={hint}
      onClick={() => onChange(!checked)}
      class={cn(
        'inline-flex items-center gap-2 h-6 px-1 rounded-sm border-0 bg-transparent font-ui text-[12px] font-medium',
        'text-dim cursor-pointer transition-colors duration-(--duration-fast)',
        'hover:enabled:text-fg disabled:cursor-default disabled:opacity-45',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        checked && 'text-fg',
        klass,
      )}
    >
      <span
        aria-hidden="true"
        class={cn(
          'relative inline-flex shrink-0 items-center rounded-full border transition-colors duration-(--duration-fast)',
          track,
          checked ? 'bg-accent border-accent' : 'bg-active border-border',
        )}
      >
        <span
          class={cn(
            'absolute left-px rounded-full transition-transform duration-(--duration-fast) ease-(--ease-enter)',
            knob,
            checked ? cn('bg-on-accent', travel) : 'bg-faint translate-x-0',
          )}
        />
      </span>
      {label}
    </button>
  )
}
