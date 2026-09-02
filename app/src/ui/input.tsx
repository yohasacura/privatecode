import type { JSX, VNode } from 'preact'
import { cn } from './cn'

const FIELD =
  'block w-full rounded-sm border bg-bg text-fg font-ui text-[13px] leading-[1.4] ' +
  'placeholder:text-faint transition-colors duration-(--duration-fast) ' +
  'focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--focus-ring)] ' +
  'disabled:opacity-45 disabled:cursor-default'

export interface InputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
  /** The value is wrong and the field says so in red; pair with a message beneath it. */
  invalid?: boolean
}

/** A single-line field. Monospace for paths and URLs is the caller's `class="font-mono"`. */
export function Input({ invalid = false, class: klass, ...rest }: InputProps): VNode {
  return (
    <input
      class={cn(FIELD, 'h-7 px-2.5', invalid ? 'border-red' : 'border-border', klass as string | undefined)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  )
}

export interface TextareaProps extends JSX.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export function Textarea({ invalid = false, class: klass, ...rest }: TextareaProps): VNode {
  return (
    <textarea
      class={cn(FIELD, 'px-2.5 py-1.5 resize-y', invalid ? 'border-red' : 'border-border', klass as string | undefined)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  )
}

/** A label above a field, 12 px, dim; `hint` goes beneath in the faint colour. */
export function Field({ label, hint, error, htmlFor, children }: {
  label: string
  hint?: string
  error?: string
  htmlFor?: string
  children: VNode | VNode[]
}): VNode {
  return (
    <div class="flex flex-col gap-1.5">
      <label class="text-[12px] font-medium text-dim" for={htmlFor}>{label}</label>
      {children}
      {error !== undefined
        ? <div class="text-[12px] text-red" role="alert">{error}</div>
        : hint !== undefined ? <div class="text-[12px] text-faint">{hint}</div> : null}
    </div>
  )
}
