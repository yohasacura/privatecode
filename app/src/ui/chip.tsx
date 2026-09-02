import type { ComponentChildren, JSX, VNode } from 'preact'
import { cn } from './cn'

export type ChipTone = 'neutral' | 'accent' | 'green' | 'red' | 'yellow' | 'blue'

const TONE: Record<ChipTone, string> = {
  neutral: 'bg-hover text-dim',
  accent: 'bg-accent-soft text-accent',
  green: 'bg-green-soft text-green',
  red: 'bg-red-soft text-red',
  yellow: 'bg-yellow-soft text-yellow',
  blue: 'bg-blue-soft text-blue',
}

export interface ChipProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone
  /** Monospace, for a tool name or a code. */
  mono?: boolean
  icon?: VNode
  children: ComponentChildren
}

/** A small label with a tint: a state, a mode, a count. Never interactive on its own. */
export function Chip({ tone = 'neutral', mono = false, icon, class: klass, children, ...rest }: ChipProps): VNode {
  return (
    <span
      class={cn(
        'inline-flex items-center gap-1 h-5 px-1.5 rounded-[4px] text-[11px] font-medium leading-none whitespace-nowrap',
        mono ? 'font-mono' : 'font-ui',
        TONE[tone],
        klass as string | undefined,
      )}
      {...rest}
    >
      {icon !== undefined && <span class="inline-flex [&>svg]:size-3">{icon}</span>}
      {children}
    </span>
  )
}
