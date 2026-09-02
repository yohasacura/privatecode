// @vitest-environment happy-dom
import { render } from 'preact'
import { useState } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test } from 'vitest'
import { Button, IconButton } from './button'
import { Chip } from './chip'
import { Segmented } from './segmented'
import { Switch } from './switch'
import { Tabs, tabPanelId } from './tabs'

/**
 * The keyboard and ARIA contract of the small controls — what a screen reader is told and
 * what the arrow keys do. Rendered with Preact into happy-dom; nothing here is visual.
 */

let host: HTMLDivElement
afterEach(() => { render(null, host); host.remove() })
function mount(node: preact.ComponentChild): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  render(node, host)
  return host
}
// `act` flushes Preact's batched re-render, so the DOM read on the next line is current.
const key = (el: Element, k: string): void => {
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) })
}
const click = (el: HTMLElement): void => { act(() => { el.click() }) }

describe('buttons', () => {
  test('a button is type=button unless told otherwise, and loading disables it with aria-busy', () => {
    const el = mount(<Button loading>Save</Button>).querySelector('button')!
    expect(el.type).toBe('button')
    expect(el.disabled).toBe(true)
    expect(el.getAttribute('aria-busy')).toBe('true')
    expect(el.textContent).toContain('Save')
  })

  test('an icon button always has a name, and says when it is pressed', () => {
    const el = mount(<IconButton label="Sessions" active>x</IconButton>).querySelector('button')!
    expect(el.getAttribute('aria-label')).toBe('Sessions')
    expect(el.title).toBe('Sessions')
    expect(el.getAttribute('aria-pressed')).toBe('true')
  })

  test('a chip is inert text with a tone', () => {
    const el = mount(<Chip tone="green">passed</Chip>).querySelector('span')!
    expect(el.textContent).toBe('passed')
    expect(el.className).toContain('text-green')
  })
})

describe('segmented', () => {
  function Harness(): preact.JSX.Element {
    const [v, setV] = useState<'a' | 'b' | 'c'>('a')
    return (
      <Segmented
        label="Mode"
        value={v}
        onChange={setV}
        options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }]}
      />
    )
  }

  test('is a radiogroup where only the chosen segment is in the tab order', () => {
    const el = mount(<Harness />)
    const group = el.querySelector('[role="radiogroup"]')!
    expect(group.getAttribute('aria-label')).toBe('Mode')
    const radios = [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1])
  })

  test('arrows move and choose, skipping a disabled segment, and wrap', () => {
    const el = mount(<Harness />)
    const radios = (): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    key(radios()[0]!, 'ArrowRight')
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true'])
    expect(document.activeElement).toBe(radios()[2])
    key(radios()[2]!, 'ArrowRight')
    expect(radios()[0]!.getAttribute('aria-checked')).toBe('true')
    key(radios()[0]!, 'End')
    expect(radios()[2]!.getAttribute('aria-checked')).toBe('true')
  })
})

describe('switch', () => {
  test('is role=switch, toggles on click, and carries its label as text', () => {
    function Harness(): preact.JSX.Element {
      const [on, setOn] = useState(false)
      return <Switch label="Checks" checked={on} onChange={setOn} />
    }
    const el = mount(<Harness />)
    const sw = el.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(sw.textContent).toContain('Checks')
    click(sw)
    expect(el.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
  })
})

describe('tabs', () => {
  function Harness(): preact.JSX.Element {
    const [t, setT] = useState<'files' | 'history' | 'terminal'>('files')
    return (
      <div>
        <Tabs
          group="inspector"
          label="Inspector"
          active={t}
          onChange={setT}
          tabs={[{ id: 'files', label: 'Files' }, { id: 'history', label: 'History', badge: 2 }, { id: 'terminal', label: 'Terminal' }]}
        />
        <div role="tabpanel" id={tabPanelId('inspector', t)} aria-labelledby={`inspector-tab-${t}`}>{t}</div>
      </div>
    )
  }

  test('wires tabs to their panel and shows a badge only when it counts', () => {
    const el = mount(<Harness />)
    const tabs = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map((x) => x.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(tabs[0]!.getAttribute('aria-controls')).toBe('inspector-panel-files')
    expect(el.querySelector('[role="tabpanel"]')!.getAttribute('aria-labelledby')).toBe('inspector-tab-files')
    expect(tabs[1]!.textContent).toContain('2')
    expect(tabs[2]!.textContent).not.toContain('0')
  })

  test('arrows and Home/End move the selection and the focus', () => {
    const el = mount(<Harness />)
    const tabs = (): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    key(tabs()[0]!, 'ArrowRight')
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[1])
    key(tabs()[1]!, 'End')
    expect(tabs()[2]!.getAttribute('aria-selected')).toBe('true')
    key(tabs()[2]!, 'ArrowRight')
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true')
    expect(el.querySelector('[role="tabpanel"]')!.textContent).toBe('files')
  })
})
