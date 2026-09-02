import type { VNode } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { cn } from './cn'
import { rememberFocus } from './focus'
import { LAYER, Portal, useEscape, useFloating, useId, useOutsidePointerDown } from './overlay'
import type { Align, Side } from './position'

export type MenuItem =
  | {
    id: string
    label: string
    icon?: VNode
    /** Shown right-aligned, dim: `Ctrl+N`. Display only; the shortcut itself is the caller's. */
    shortcut?: string
    /** Red on hover: a destructive action reads as one when the pointer arrives. */
    danger?: boolean
    disabled?: boolean
    /** Why it is disabled, as the item's title. A hidden command is one nobody learns. */
    reason?: string
    onSelect: () => void
  }
  | { separator: true }

export interface MenuTriggerProps {
  ref: (el: HTMLElement | null) => void
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  'aria-controls': string
  onClick: () => void
  onKeyDown: (e: KeyboardEvent) => void
}

/**
 * A dropdown menu on any trigger. The keyboard contract is Radix's: Down/Enter/Space on
 * the trigger open it on the first item, arrows move (wrapping), Home/End jump, a letter
 * jumps to the next item starting with it, Enter/Space choose, Escape and Tab close and
 * give focus back to the trigger; a pointer-down outside closes it too.
 */
export function Menu({ items, trigger, label, side = 'bottom', align = 'start', class: klass }: {
  items: readonly MenuItem[]
  trigger: (props: MenuTriggerProps) => VNode
  label: string
  side?: Side
  align?: Align
  class?: string
}): VNode {
  const [open, setOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState(0)
  const anchor = useRef<HTMLElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const restore = useRef<(() => void) | null>(null)
  const id = useId('menu')
  const pos = useFloating(anchor, panel, open, { side, align, gap: 4 })

  const enabledIndexes = items
    .map((it, i) => ('separator' in it || it.disabled ? -1 : i))
    .filter((i) => i >= 0)

  const close = useCallback((): void => {
    setOpen(false)
    restore.current?.()
    restore.current = null
  }, [])
  const openAt = useCallback((index: number): void => {
    restore.current = rememberFocus()
    setFocusIndex(index)
    setOpen(true)
  }, [])

  useOutsidePointerDown([panel, anchor], open, close)
  useEscape(open, close)

  useEffect(() => {
    if (!open) return
    // By the item's index in `items`, not its position among the menuitems: a separator
    // sits between them and would put every item after it one off.
    panel.current?.querySelector<HTMLElement>(`[role="menuitem"][data-index="${focusIndex}"]`)?.focus()
  }, [open, focusIndex])

  const step = (from: number, delta: number): number => {
    if (enabledIndexes.length === 0) return from
    const at = enabledIndexes.indexOf(from)
    const next = at === -1 ? 0 : (at + delta + enabledIndexes.length) % enabledIndexes.length
    return enabledIndexes[next]!
  }

  function onMenuKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setFocusIndex((i) => step(i, 1)); break
      case 'ArrowUp': e.preventDefault(); setFocusIndex((i) => step(i, -1)); break
      case 'Home': e.preventDefault(); setFocusIndex(enabledIndexes[0] ?? 0); break
      case 'End': e.preventDefault(); setFocusIndex(enabledIndexes[enabledIndexes.length - 1] ?? 0); break
      case 'Tab': close(); break
      case 'Enter': case ' ': {
        e.preventDefault()
        const item = items[focusIndex]
        if (item !== undefined && !('separator' in item) && !item.disabled) { close(); item.onSelect() }
        break
      }
      default: {
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const letter = e.key.toLowerCase()
          const order = [...enabledIndexes.filter((i) => i > focusIndex), ...enabledIndexes.filter((i) => i <= focusIndex)]
          const hit = order.find((i) => {
            const it = items[i]
            return it !== undefined && !('separator' in it) && it.label.toLowerCase().startsWith(letter)
          })
          if (hit !== undefined) setFocusIndex(hit)
        }
      }
    }
  }

  const triggerProps: MenuTriggerProps = {
    ref: (el) => { anchor.current = el },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': id,
    onClick: () => { if (open) close(); else openAt(enabledIndexes[0] ?? 0) },
    onKeyDown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAt(enabledIndexes[0] ?? 0) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); openAt(enabledIndexes[enabledIndexes.length - 1] ?? 0) }
    },
  }

  return (
    <>
      {trigger(triggerProps)}
      {open && (
        <Portal>
          <div
            ref={panel}
            id={id}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKey}
            class={cn(
              'fixed min-w-[180px] max-w-[320px] py-1 rounded-md border border-border bg-panel text-fg shadow-(--shadow-pop) outline-none',
              'motion-safe:animate-[pop-in_var(--duration-normal)_var(--ease-enter)]',
              LAYER.popover,
              pos === null && 'invisible',
              klass,
            )}
            style={pos === null ? undefined : { left: `${pos.x}px`, top: `${pos.y}px` }}
          >
            {items.map((it, i) => 'separator' in it
              ? <div key={`sep-${i}`} role="separator" class="my-1 h-px bg-border-soft" />
              : (
                <button
                  key={it.id}
                  type="button"
                  role="menuitem"
                  data-index={i}
                  tabIndex={i === focusIndex ? 0 : -1}
                  disabled={it.disabled}
                  aria-disabled={it.disabled || undefined}
                  title={it.disabled ? it.reason : undefined}
                  onPointerEnter={() => { if (!it.disabled) setFocusIndex(i) }}
                  onClick={() => { if (!it.disabled) { close(); it.onSelect() } }}
                  class={cn(
                    'flex w-full items-center gap-2 h-7 px-2.5 mx-0 border-0 bg-transparent text-left font-ui text-[13px]',
                    'cursor-pointer outline-none whitespace-nowrap',
                    it.disabled ? 'text-ghost cursor-default' : it.danger ? 'text-red' : 'text-fg',
                    !it.disabled && 'focus:bg-hover hover:bg-hover',
                    it.danger && !it.disabled && 'focus:bg-red-soft hover:bg-red-soft',
                  )}
                >
                  {it.icon !== undefined && <span class="inline-flex shrink-0 text-dim [&>svg]:size-3.5">{it.icon}</span>}
                  <span class="flex-1 truncate">{it.label}</span>
                  {it.shortcut !== undefined && <span class="ml-4 text-[11px] text-faint tabular-nums">{it.shortcut}</span>}
                </button>
              ))}
          </div>
        </Portal>
      )}
    </>
  )
}
