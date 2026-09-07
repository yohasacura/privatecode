import type { RefObject, VNode } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { cn } from './cn'
import { focusWhenReady, rememberFocus } from './focus'
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

/** The index of the first item that can be chosen — where a menu opens by default. */
function firstEnabled(items: readonly MenuItem[]): number {
  const at = items.findIndex((it) => !('separator' in it) && !it.disabled)
  return at === -1 ? 0 : at
}

/**
 * The list itself, floating beside `anchor` from the moment it mounts. Shared by the
 * dropdown (`Menu`) and the right-click menu (`ContextMenu`), which differ only in what
 * they are anchored to — a trigger button, or a point under the pointer. Mounted only
 * while open, so every opening starts on `initialIndex` with nothing left over.
 *
 * The keyboard contract is Radix's: arrows move (wrapping), Home/End jump, a letter jumps
 * to the next item starting with it, Enter/Space choose, Escape and Tab close; a
 * pointer-down outside closes it too. Focus lands on the first item as it opens; who gets
 * focus back is the owner's business, since it knows where focus came from.
 */
function MenuList({ id, label, items, anchor, initialIndex, onClose, side, align, gap, class: klass }: {
  id: string
  label: string
  items: readonly MenuItem[]
  anchor: RefObject<HTMLElement>
  initialIndex: number
  onClose: () => void
  side: Side
  align: Align
  gap: number
  class?: string
}): VNode {
  const [focusIndex, setFocusIndex] = useState(initialIndex)
  const panel = useRef<HTMLDivElement>(null)
  const pos = useFloating(anchor, panel, true, { side, align, gap })

  const enabledIndexes = items
    .map((it, i) => ('separator' in it || it.disabled ? -1 : i))
    .filter((i) => i >= 0)

  useOutsidePointerDown([panel, anchor], true, onClose)
  useEscape(true, onClose)

  // Focus once the list is VISIBLE, not merely mounted: it renders `invisible` until it
  // has been measured and placed, and a browser refuses to focus what cannot be seen. And
  // through `focusWhenReady`, because the browser also refuses the focus for the first few
  // milliseconds after the list appears — in the live window the row that was
  // right-clicked kept focus and the arrow keys went to it instead of the menu, while a
  // DOM without layout focused the item every time, which is why no test caught it.
  const visible = pos !== null
  useEffect(() => {
    if (!visible) return
    // By the item's index in `items`, not its position among the menuitems: a separator
    // sits between them and would put every item after it one off.
    const el = panel.current?.querySelector<HTMLElement>(`[role="menuitem"][data-index="${focusIndex}"]`)
    if (el === null || el === undefined) return
    return focusWhenReady(el)
  }, [visible, focusIndex])

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
      case 'Tab': onClose(); break
      case 'Enter': case ' ': {
        e.preventDefault()
        const item = items[focusIndex]
        if (item !== undefined && !('separator' in item) && !item.disabled) { onClose(); item.onSelect() }
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

  return (
    <Portal>
      <div
        ref={panel}
        id={id}
        role="menu"
        aria-label={label}
        onKeyDown={onMenuKey}
        // The browser's own menu has no business over ours: a right-click on an open menu
        // would otherwise stack the two.
        onContextMenu={(e) => e.preventDefault()}
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
              onClick={() => { if (!it.disabled) { onClose(); it.onSelect() } }}
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
  )
}

/**
 * A dropdown menu on any trigger. Down/Enter/Space on the trigger open it on the first
 * item, Up opens it on the last; closing gives focus back to the trigger.
 */
export function Menu({ items, trigger, label, side = 'bottom', align = 'start', class: klass }: {
  items: readonly MenuItem[]
  trigger: (props: MenuTriggerProps) => VNode
  label: string
  side?: Side
  align?: Align
  class?: string
}): VNode {
  // The index to open on, or closed. One state rather than open + index: the two only
  // ever change together.
  const [openAt, setOpenAt] = useState<number | null>(null)
  const anchor = useRef<HTMLElement>(null)
  const restore = useRef<(() => void) | null>(null)
  const id = useId('menu')
  const open = openAt !== null

  const enabledIndexes = items
    .map((it, i) => ('separator' in it || it.disabled ? -1 : i))
    .filter((i) => i >= 0)

  const close = useCallback((): void => {
    setOpenAt(null)
    restore.current?.()
    restore.current = null
  }, [])
  const show = useCallback((index: number): void => {
    restore.current = rememberFocus()
    setOpenAt(index)
  }, [])

  const triggerProps: MenuTriggerProps = {
    ref: (el) => { anchor.current = el },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': id,
    onClick: () => { if (open) close(); else show(enabledIndexes[0] ?? 0) },
    onKeyDown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(enabledIndexes[0] ?? 0) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); show(enabledIndexes[enabledIndexes.length - 1] ?? 0) }
    },
  }

  return (
    <>
      {trigger(triggerProps)}
      {openAt !== null && (
        <MenuList id={id} label={label} items={items} anchor={anchor} initialIndex={openAt} onClose={close} side={side} align={align} gap={4} {...(klass !== undefined ? { class: klass } : {})} />
      )}
    </>
  )
}

/** A menu opened at a point: what to show, where, and what to call it. */
export interface MenuAt {
  x: number
  y: number
  items: readonly MenuItem[]
  label: string
}

/** A zero-size anchor at a point — the floating logic then treats the pointer like any
 * other rectangle: below it if there is room, above it otherwise, never off-screen. */
function pointAnchor(x: number, y: number): HTMLElement {
  const rect = { x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0, toJSON: () => ({}) }
  return { getBoundingClientRect: () => rect, contains: () => false } as unknown as HTMLElement
}

/**
 * The right-click menu: `MenuList` anchored to a point. Controlled — the owner keeps `at`
 * (see `useContextMenu`, which is the ordinary way to get one) and clears it on close.
 */
export function ContextMenu({ at, onClose }: { at: MenuAt | null; onClose: () => void }): VNode | null {
  const anchor = useRef<HTMLElement | null>(null)
  const id = useId('context-menu')
  anchor.current = at === null ? null : pointAnchor(at.x, at.y)
  if (at === null) return null
  return (
    <MenuList
      // A second right-click somewhere else is a new menu, not the old one moved.
      key={`${at.x},${at.y}`}
      id={id}
      label={at.label}
      items={at.items}
      anchor={anchor}
      initialIndex={firstEnabled(at.items)}
      onClose={onClose}
      side="bottom"
      align="start"
      gap={0}
    />
  )
}

/** Where a `contextmenu` event points: the pointer, or — for one raised from the keyboard
 * (Shift+F10, the Menu key), which arrives at 0,0 — the element that has focus. */
function pointOf(e: MouseEvent): { x: number; y: number } {
  if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY }
  const el = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
  const r = el?.getBoundingClientRect()
  return r === undefined ? { x: 0, y: 0 } : { x: r.left + Math.min(24, r.width / 2), y: r.bottom }
}

/**
 * A right-click menu for a component: render `menu` once, and give every row that has
 * actions `onContextMenu={(e) => open(e, itemsFor(row), 'Row actions')}`. The same items
 * the row's `…` button shows, reached the way people reach for them.
 *
 * A right-click inside a text field is left to the browser: its own menu is the one with
 * Cut, Copy and Paste, and a row's actions are not what someone editing a field wants.
 */
export function useContextMenu(): {
  menu: VNode
  open: (e: MouseEvent, items: readonly MenuItem[], label: string) => void
  close: () => void
} {
  const [at, setAt] = useState<MenuAt | null>(null)
  const restore = useRef<(() => void) | null>(null)
  const close = useCallback((): void => {
    setAt(null)
    restore.current?.()
    restore.current = null
  }, [])
  const open = useCallback((e: MouseEvent, items: readonly MenuItem[], label: string): void => {
    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]') !== null) return
    if (items.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    restore.current ??= rememberFocus()
    setAt({ ...pointOf(e), items, label })
  }, [])
  return { menu: <ContextMenu at={at} onClose={close} />, open, close }
}
