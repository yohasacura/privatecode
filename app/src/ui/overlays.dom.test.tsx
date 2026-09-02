// @vitest-environment happy-dom
import { render } from 'preact'
import { useRef, useState } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AlertDialog, Dialog } from './dialog'
import { Menu } from './menu'
import { Popover } from './popover'
import { toast, Toaster } from './toast'
import { Tooltip } from './tooltip'

/**
 * The overlay contract — focus goes in, stays in, comes back; Escape and the outside close;
 * the roles and names a screen reader hears. Positions are not asserted (happy-dom has no
 * layout); `position.test.ts` covers the arithmetic.
 */

let host: HTMLDivElement
afterEach(() => {
  render(null, host)
  host.remove()
  toast.clear()
  vi.useRealTimers()
})
function mount(node: preact.ComponentChild): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  act(() => { render(node, host) })
  return host
}
const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}): void => {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
}
const click = (el: HTMLElement): void => { act(() => { el.click() }) }
const pointerDown = (target: EventTarget): void => {
  act(() => { target.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
}

describe('dialog', () => {
  function Harness({ closeOnOverlay = true }: { closeOnOverlay?: boolean }): preact.JSX.Element {
    const [open, setOpen] = useState(false)
    return (
      <div>
        <button id="opener" onClick={() => setOpen(true)}>open</button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Erase everything" description="This cannot be undone." closeOnOverlay={closeOnOverlay}>
          <input id="inside" />
          <button id="second">ok</button>
        </Dialog>
      </div>
    )
  }

  test('is modal, labelled by its title, and moves focus inside', () => {
    const el = mount(<Harness />)
    click(el.querySelector<HTMLButtonElement>('#opener')!)
    const dlg = document.querySelector('[role="dialog"]')!
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dlg.getAttribute('aria-labelledby')!)?.textContent).toBe('Erase everything')
    expect(document.getElementById(dlg.getAttribute('aria-describedby')!)?.textContent).toBe('This cannot be undone.')
    expect(document.activeElement?.id).toBe('inside')
    expect(document.body.style.overflow).toBe('hidden')
  })

  test('keeps Tab inside, and Escape closes and gives focus back', () => {
    const el = mount(<Harness />)
    const opener = el.querySelector<HTMLButtonElement>('#opener')!
    opener.focus()
    click(opener)
    const dlg = document.querySelector<HTMLElement>('[role="dialog"]')!
    document.getElementById('second')!.focus()
    // The close button is the last tabbable? No: the body's controls come after the header.
    // Tab from the last control wraps to the first.
    const last = [...dlg.querySelectorAll<HTMLElement>('button, input')].pop()!
    last.focus()
    press(dlg, 'Tab')
    expect(dlg.contains(document.activeElement)).toBe(true)
    press(document, 'Escape')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(document.body.style.overflow).toBe('')
  })

  test('the overlay closes it unless told otherwise', () => {
    const el = mount(<Harness closeOnOverlay={false} />)
    click(el.querySelector<HTMLButtonElement>('#opener')!)
    const overlay = document.querySelector<HTMLElement>('[role="dialog"]')!.parentElement!
    pointerDown(overlay)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })

  test('an alert dialog is role=alertdialog, starts on Confirm, and never closes on the overlay', () => {
    const onConfirm = vi.fn()
    mount(<AlertDialog open title="Delete session?" onCancel={() => {}} onConfirm={onConfirm} confirmLabel="Delete" danger />)
    const dlg = document.querySelector<HTMLElement>('[role="alertdialog"]')!
    expect(dlg).not.toBeNull()
    expect((document.activeElement as HTMLElement).textContent).toContain('Delete')
    pointerDown(dlg.parentElement!)
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    click(document.activeElement as HTMLElement)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('popover', () => {
  function Harness(): preact.JSX.Element {
    const [open, setOpen] = useState(false)
    const anchor = useRef<HTMLButtonElement>(null)
    return (
      <div>
        <button id="trigger" ref={anchor} aria-expanded={open} onClick={() => setOpen((v) => !v)}>switch</button>
        <Popover open={open} onOpenChange={setOpen} anchor={anchor} label="Workspaces">
          <button id="first">one</button>
          <button id="second">two</button>
        </Popover>
        <button id="elsewhere">elsewhere</button>
      </div>
    )
  }

  test('opens with focus on its first control and closes on a pointer-down outside, restoring focus', () => {
    const el = mount(<Harness />)
    const trigger = el.querySelector<HTMLButtonElement>('#trigger')!
    trigger.focus()
    click(trigger)
    const panel = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Workspaces"]')!
    expect(panel).not.toBeNull()
    expect(document.activeElement?.id).toBe('first')
    pointerDown(el.querySelector('#elsewhere')!)
    expect(document.querySelector('[aria-label="Workspaces"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  test('a pointer-down inside does not close it; Escape does', () => {
    const el = mount(<Harness />)
    click(el.querySelector<HTMLButtonElement>('#trigger')!)
    pointerDown(document.getElementById('second')!)
    expect(document.querySelector('[aria-label="Workspaces"]')).not.toBeNull()
    press(document, 'Escape')
    expect(document.querySelector('[aria-label="Workspaces"]')).toBeNull()
  })
})

describe('menu', () => {
  const picked: string[] = []
  function Harness(): preact.JSX.Element {
    return (
      <Menu
        label="Session actions"
        items={[
          { id: 'rename', label: 'Rename', onSelect: () => picked.push('rename') },
          { id: 'export', label: 'Export as Markdown', onSelect: () => picked.push('export') },
          { separator: true },
          { id: 'restore', label: 'Restore', disabled: true, reason: 'nothing to restore', onSelect: () => picked.push('restore') },
          { id: 'delete', label: 'Delete', danger: true, onSelect: () => picked.push('delete') },
        ]}
        trigger={(p) => <button id="more" {...p}>more</button>}
      />
    )
  }

  test('the trigger says what it opens; Down opens on the first item; arrows wrap past the disabled one', () => {
    picked.length = 0
    const el = mount(<Harness />)
    const trigger = el.querySelector<HTMLButtonElement>('#more')!
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    trigger.focus()
    press(trigger, 'ArrowDown')
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.getAttribute('aria-label')).toBe('Session actions')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const items = (): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(document.activeElement).toBe(items()[0])
    press(menu, 'ArrowUp')
    expect(document.activeElement?.textContent).toBe('Delete')
    press(menu, 'ArrowUp')
    expect(document.activeElement?.textContent).toBe('Export as Markdown')
    expect(items()[2]!.title).toBe('nothing to restore')
  })

  test('a letter jumps, Enter chooses and closes with focus back on the trigger, Escape just closes', () => {
    picked.length = 0
    const el = mount(<Harness />)
    const trigger = el.querySelector<HTMLButtonElement>('#more')!
    trigger.focus()
    press(trigger, 'ArrowDown')
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    press(menu, 'd')
    expect(document.activeElement?.textContent).toBe('Delete')
    press(menu, 'Enter')
    expect(picked).toEqual(['delete'])
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    click(trigger)
    press(document, 'Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(picked).toEqual(['delete'])
  })
})

describe('tooltip', () => {
  test('appears on focus after the delay, is role=tooltip, and describes the control', () => {
    vi.useFakeTimers()
    const el = mount(<Tooltip text="Sessions (Ctrl+B)" delay={300}><button id="b">x</button></Tooltip>)
    const b = el.querySelector<HTMLButtonElement>('#b')!
    act(() => { b.focus() })
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    act(() => { vi.advanceTimersByTime(300) })
    const tip = document.querySelector('[role="tooltip"]')!
    expect(tip.textContent).toBe('Sessions (Ctrl+B)')
    expect(b.getAttribute('aria-describedby')).toBe(tip.id)
    act(() => { b.blur() })
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })
})

describe('toasts', () => {
  test('show what was pushed, at most three, newest last, and go on their own', () => {
    vi.useFakeTimers()
    mount(<Toaster />)
    act(() => {
      toast.push({ title: 'Copied' })
      toast.push({ title: 'Exported', tone: 'success' })
      toast.push({ title: 'Saved' })
      toast.push({ title: 'Restored' })
    })
    const titles = (): string[] => [...document.querySelectorAll('[role="status"], [role="alert"]')].map((n) => n.querySelector('div > div')!.textContent!)
    expect(titles()).toEqual(['Exported', 'Saved', 'Restored'])
    act(() => { vi.advanceTimersByTime(4100) })
    expect(titles()).toEqual([])
  })

  test('an error is an alert, can be dismissed, and its action runs once', () => {
    vi.useFakeTimers()
    const onUndo = vi.fn()
    mount(<Toaster />)
    act(() => { toast.push({ title: 'Put back failed', tone: 'error', duration: 0, action: { label: 'Retry', onClick: onUndo } }) })
    const card = document.querySelector<HTMLElement>('[role="alert"]')!
    expect(card).not.toBeNull()
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    click([...card.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!)
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})
