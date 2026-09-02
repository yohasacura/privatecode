import type { ComponentChildren, JSX, VNode } from 'preact'
import { cn } from './cn'

/**
 * The button, in its four weights. `primary` is the one action on a surface (the accent);
 * `secondary` is the default; `ghost` sits in rows and bars; `danger` is red on hover only,
 * so a destructive action reads as one when the pointer arrives and not before.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const BASE =
  'inline-flex items-center justify-center gap-1.5 select-none whitespace-nowrap ' +
  'font-ui font-medium rounded-sm border transition-colors duration-(--duration-fast) ' +
  'cursor-pointer disabled:cursor-default disabled:opacity-45 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent border-accent text-on-accent hover:enabled:bg-accent-hover hover:enabled:border-accent-hover active:enabled:bg-accent',
  secondary: 'bg-raised border-border text-fg hover:enabled:bg-hover hover:enabled:border-border-strong active:enabled:bg-active',
  ghost: 'bg-transparent border-transparent text-dim hover:enabled:bg-hover hover:enabled:text-fg active:enabled:bg-active',
  danger: 'bg-raised border-border text-red hover:enabled:bg-red-soft hover:enabled:border-red active:enabled:bg-red-soft',
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-6 px-2 text-[12px]',
  md: 'h-7 px-3 text-[13px]',
}

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'size' | 'icon'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Drawn before the label at 14 px. */
  icon?: VNode
  /** Replaces the icon with a spinner and disables the button; the label stays readable. */
  loading?: boolean
  children?: ComponentChildren
}

export function Button({
  variant = 'secondary', size = 'md', icon, loading = false, class: klass, children, disabled, type, ...rest
}: ButtonProps): VNode {
  return (
    <button
      type={type ?? 'button'}
      class={cn(BASE, VARIANT[variant], SIZE[size], klass as string | undefined)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon !== undefined ? <span class="inline-flex shrink-0 [&>svg]:size-3.5">{icon}</span> : null}
      {children}
    </button>
  )
}

/** A 14 px ring that turns; under reduced motion it is a static ring. */
export function Spinner({ class: klass }: { class?: string }): VNode {
  return (
    <span
      class={cn('inline-block size-3.5 shrink-0 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin', klass)}
      aria-hidden="true"
    />
  )
}

export interface IconButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'size'> {
  /** What the button does, in two or three words: the accessible name and the tooltip. */
  label: string
  size?: ButtonSize
  /** Pressed state for a toggle (a panel that is shown, a filter that is on). */
  active?: boolean
  children: ComponentChildren
}

/** A square button holding one icon; never without a label. */
export function IconButton({ label, size = 'md', active = false, class: klass, type, ...rest }: IconButtonProps): VNode {
  return (
    <button
      type={type ?? 'button'}
      class={cn(
        'inline-flex items-center justify-center shrink-0 rounded-sm border border-transparent bg-transparent',
        'text-dim transition-colors duration-(--duration-fast) cursor-pointer',
        'hover:enabled:bg-hover hover:enabled:text-fg active:enabled:bg-active',
        'disabled:cursor-default disabled:opacity-45',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        size === 'sm' ? 'size-6 [&>svg]:size-3.5' : 'size-7 [&>svg]:size-4',
        active && 'text-fg bg-active',
        klass as string | undefined,
      )}
      aria-label={label}
      title={label}
      aria-pressed={rest['aria-pressed'] ?? (active || undefined)}
      {...rest}
    />
  )
}
