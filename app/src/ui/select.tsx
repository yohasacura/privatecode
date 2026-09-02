import type { JSX, VNode } from 'preact'
import { forwardRef } from 'preact/compat'
import { cn } from './cn'

export interface SelectProps extends JSX.SelectHTMLAttributes<HTMLSelectElement> {
  /** The value is wrong and the field says so in red. */
  invalid?: boolean
}

/**
 * The platform's own drop-down, dressed like the Input beside it. Native on purpose: a
 * list of a handful of fixed choices needs the keyboard, the screen reader and the
 * scroll-wheel behaviour the OS already gives a `<select>`, and a custom listbox would
 * have to earn each of those back.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ invalid = false, class: klass, children, ...rest }, ref): VNode {
  return (
    <select
      ref={ref}
      class={cn(
        'h-7 rounded-sm border bg-bg px-2 font-ui text-[13px] leading-[1.4] text-fg',
        'transition-colors duration-(--duration-fast)',
        'focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--focus-ring)]',
        'disabled:cursor-default disabled:opacity-45',
        invalid ? 'border-red' : 'border-border',
        klass as string | undefined,
      )}
      aria-invalid={invalid || undefined}
      {...rest}
    >
      {children}
    </select>
  )
})
