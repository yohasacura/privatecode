// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest'
import { focusFirst, rememberFocus, tabbables, trapTab } from './focus'

afterEach(() => { document.body.innerHTML = '' })

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body.firstElementChild as HTMLElement
}

describe('what Tab can reach', () => {
  test('lists the focusable controls in order, skipping disabled and hidden ones', () => {
    const box = mount(`<div>
      <button id="a">a</button>
      <button disabled id="b">b</button>
      <input id="c" />
      <input type="hidden" id="d" />
      <a href="#" id="e">e</a>
      <span tabindex="0" id="f">f</span>
      <span tabindex="-1" id="g">g</span>
      <button hidden id="h">h</button>
    </div>`)
    expect(tabbables(box).map((el) => el.id)).toEqual(['a', 'c', 'e', 'f'])
  })
})

describe('keeping Tab inside', () => {
  test('wraps from the last control to the first and back', () => {
    const box = mount('<div tabindex="-1"><button id="a">a</button><button id="b">b</button></div>')
    const trap = trapTab(box)
    const b = box.querySelector<HTMLElement>('#b')!
    const a = box.querySelector<HTMLElement>('#a')!
    b.focus()
    const forward = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    trap(forward)
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(a)
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })
    trap(back)
    expect(back.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(b)
  })

  test('with nothing tabbable, focus stays on the container', () => {
    const box = mount('<div tabindex="-1"><p>nothing here</p></div>')
    const trap = trapTab(box)
    const e = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    trap(e)
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(box)
  })

  test('ignores every other key', () => {
    const box = mount('<div tabindex="-1"><button id="a">a</button></div>')
    const e = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    trapTab(box)(e)
    expect(e.defaultPrevented).toBe(false)
  })
})

describe('opening and closing', () => {
  test('focuses the marked control first, else the first control, else the container', () => {
    const box = mount('<div tabindex="-1"><button id="a">a</button><button id="b" data-autofocus>b</button></div>')
    focusFirst(box)
    expect(document.activeElement?.id).toBe('b')
    const plain = mount('<div tabindex="-1"><button id="a">a</button></div>')
    focusFirst(plain)
    expect(document.activeElement?.id).toBe('a')
    const empty = mount('<div tabindex="-1"></div>')
    focusFirst(empty)
    expect(document.activeElement).toBe(empty)
  })

  test('remembers where focus was and puts it back, unless that element is gone', () => {
    const box = mount('<div><button id="opener">open</button><button id="inside">x</button></div>')
    const opener = box.querySelector<HTMLElement>('#opener')!
    opener.focus()
    const restore = rememberFocus()
    box.querySelector<HTMLElement>('#inside')!.focus()
    restore()
    expect(document.activeElement).toBe(opener)
    const restore2 = rememberFocus()
    opener.remove()
    expect(() => restore2()).not.toThrow()
  })
})
