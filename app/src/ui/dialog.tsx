import type { ComponentChildren, VNode } from 'preact'
import { useCallback, useEffect, useRef } from 'preact/hooks'
import { X } from 'lucide-preact'
import { Button, IconButton } from './button'
import { cn } from './cn'
import { focusFirst, rememberFocus, trapTab } from './focus'
import { LAYER, Portal, useEscape, useId } from './overlay'

export type DialogSize = 'sm' | 'md' | 'lg'
const WIDTH: Record<DialogSize, string> = { sm: 'w-[400px]', md: 'w-[560px]', lg: 'w-[760px]' }

/**
 * A modal: the page behind it is inert to the keyboard (Tab stays inside), scroll is
 * locked, Escape and the close button close it, a click on the overlay closes it unless
 * the caller says otherwise, and focus goes back to where it was. Labelled by its title,
 * described by its description when there is one.
 */
export function Dialog({
  open, onClose, title, description, size = 'md', closeOnOverlay = true, role = 'dialog', class: klass, children, footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  size?: DialogSize
  closeOnOverlay?: boolean
  role?: 'dialog' | 'alertdialog'
  class?: string
  children: ComponentChildren
  /** Actions, right-aligned, beneath the body. */
  footer?: ComponentChildren
}): VNode | null {
  const box = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const titleId = useId('dlg-title')
  const descId = useId('dlg-desc')
  const close = useCallback(() => onClose(), [onClose])
  useEscape(open, close)

  useEffect(() => {
    if (!open) return
    const restore = rememberFocus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // A control marked `data-autofocus` anywhere in the dialog first (an alert's Confirm),
    // else the first control of the BODY — never the header's own Close button.
    const marked = box.current?.querySelector<HTMLElement>('[data-autofocus]')
    if (marked !== null && marked !== undefined) marked.focus()
    else if (body.current !== null) focusFirst(body.current)
    else if (box.current !== null) focusFirst(box.current)
    return () => {
      document.body.style.overflow = previousOverflow
      restore()
    }
  }, [open])

  if (!open) return null
  return (
    <Portal>
      <div
        class={cn('fixed inset-0 flex items-center justify-center bg-(--overlay) p-6', LAYER.dialog,
          'motion-safe:animate-[fade-in_var(--duration-normal)_var(--ease-enter)]')}
        onPointerDown={(e) => {
          if (closeOnOverlay && e.target === e.currentTarget) close()
        }}
      >
        <div
          ref={box}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description !== undefined ? descId : undefined}
          tabIndex={-1}
          onKeyDown={(e) => { if (box.current !== null) trapTab(box.current)(e) }}
          class={cn(
            'max-w-full max-h-full flex flex-col rounded-lg border border-border bg-panel text-fg shadow-(--shadow-overlay) outline-none',
            'motion-safe:animate-[pop-in_var(--duration-normal)_var(--ease-enter)]',
            WIDTH[size], klass,
          )}
        >
          <div class="flex items-start gap-3 px-5 pt-4 pb-2">
            <div class="min-w-0 flex-1">
              <h2 id={titleId} class="m-0 text-[15px] font-semibold leading-[1.3] text-fg-strong">{title}</h2>
              {description !== undefined && <p id={descId} class="mt-1 mb-0 text-[13px] text-dim">{description}</p>}
            </div>
            <IconButton label="Close" size="sm" onClick={close}><X /></IconButton>
          </div>
          <div ref={body} tabIndex={-1} class="min-h-0 flex-1 overflow-auto px-5 py-2 outline-none">{children}</div>
          {footer !== undefined && <div class="flex justify-end gap-2 px-5 pt-2 pb-4">{footer}</div>}
        </div>
      </div>
    </Portal>
  )
}

/**
 * A question with two answers, the destructive one red. Never closes on the overlay: a
 * stray click must not answer "delete everything" either way. Enter confirms only when
 * the confirm button has focus, which it has first.
 */
export function AlertDialog({
  open, onCancel, onConfirm, title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, busy = false, children,
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** The confirm is in flight: both buttons wait, the confirm shows it. */
  busy?: boolean
  children?: ComponentChildren
}): VNode | null {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      {...(description !== undefined ? { description } : {})}
      size="sm"
      role="alertdialog"
      closeOnOverlay={false}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children ?? null}
    </Dialog>
  )
}
