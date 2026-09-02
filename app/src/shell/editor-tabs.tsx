import type { VNode } from 'preact'
import { X } from 'lucide-preact'
import { IconButton } from '../ui/button'
import { cn } from '../ui/cn'

/**
 * One tab in the strip above the chat column (docs/UI-REDESIGN-2026-09.md §7 "File and
 * diff tabs"): the conversation first and never closable, then every open file or diff.
 * A div with the tab role rather than a button, because the close control inside it is a
 * button and buttons cannot nest; Enter and Space select, a middle click closes.
 */
export function EditorTab({
  active, icon, name, title, onSelect, onClose,
}: {
  active: boolean
  icon: VNode
  name: string
  title: string
  onSelect: () => void
  onClose?: () => void
}): VNode {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={title}
      data-editor-tab={name}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
      onAuxClick={(e) => { if (e.button === 1 && onClose !== undefined) onClose() }}
      class={cn(
        'group inline-flex max-w-[220px] shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap',
        'rounded-t-md border border-b-0 px-2 py-1 font-ui text-[12.5px] transition-colors duration-(--duration-fast)',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
        active ? 'border-border-soft bg-bg text-fg' : 'border-transparent text-dim hover:bg-raised hover:text-fg',
      )}
    >
      <span class={cn('inline-flex shrink-0 [&>svg]:size-[13px]', active ? 'text-accent' : 'text-faint')}>{icon}</span>
      <span class="min-w-0 truncate">{name}</span>
      {onClose !== undefined && (
        <IconButton
          size="sm"
          class={cn('-mr-1 size-[18px] [&>svg]:size-3', !active && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
          label={`Close ${name}`}
          onClick={(e) => { e.stopPropagation(); onClose() }}
        >
          <X />
        </IconButton>
      )}
    </div>
  )
}
