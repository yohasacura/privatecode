import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Icon } from './icons'

/**
 * Copy-to-clipboard, with the one piece of feedback that matters: that it happened.
 *
 * The conversation could not be copied at all — not an answer, not the whole exchange. For
 * a coding agent that is a daily-path gap, because the model's answer is usually destined
 * for somewhere else: a commit message, an issue, a colleague. Selecting text across
 * markdown rendering loses the structure; this copies the SOURCE text, which is what the
 * destination wants.
 */
export function CopyButton({ text, title }: { text: string; title?: string }): VNode {
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

  return (
    <button
      class={`copy-button ${copied ? 'copy-button-done' : ''}`}
      onClick={copy}
      title={title ?? 'Copy as markdown'}
    >
      {copied ? Icon.check() : Icon.files()}
    </button>
  )
}
