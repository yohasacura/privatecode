import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Check, Copy } from 'lucide-preact'
import { cn } from '../ui/cn'

/**
 * Copy-to-clipboard, with the one piece of feedback that matters: that it happened.
 *
 * The conversation could not be copied at all — not an answer, not the whole exchange. For
 * a coding agent that is a daily-path gap, because the model's answer is usually destined
 * for somewhere else: a commit message, an issue, a colleague. Selecting text across
 * markdown rendering loses the structure; this copies the SOURCE text, which is what the
 * destination wants.
 */

/** The holder a row's hover actions sit in: `relative`, and the group the actions watch. */
export const HOLDER = 'group/holder relative'

/**
 * A row action: a small square at the row's top-right, invisible until the row is hovered
 * or the button itself is focused. Shared by copy, edit-and-resend and whatever comes next,
 * so every row's actions land on the same spot.
 */
export const HOVER_ACTION = cn(
  'absolute -top-0.5 right-0 inline-flex size-6 cursor-pointer items-center justify-center rounded-sm border border-border bg-raised text-dim',
  'opacity-0 transition-opacity duration-(--duration-fast) group-hover/holder:opacity-100 focus-visible:opacity-100',
  'hover:bg-hover hover:text-fg [&>svg]:size-3.5',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
)

export function CopyButton({ text, title, class: klass }: { text: string; title?: string; class?: string }): VNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])

  function copy(): void {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    }).catch(() => { /* a denied clipboard is the platform's message to show, not ours */ })
  }

  const label = title ?? 'Copy as markdown'
  return (
    <button
      type="button"
      data-copied={copied ? '' : undefined}
      // The tick holds long enough to be seen and needs no hover to stay: feedback must not
      // depend on keeping the pointer still.
      class={cn(HOVER_ACTION, copied && 'border-green-line text-green opacity-100', klass)}
      onClick={copy}
      title={label}
      aria-label={label}
    >
      {copied ? <Check /> : <Copy />}
    </button>
  )
}
