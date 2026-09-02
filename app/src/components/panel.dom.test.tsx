// @vitest-environment happy-dom
import { render, type VNode } from 'preact'
import { useState } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanelEmpty, PanelError, PanelRow } from './panel'

/** The vocabulary of the right column: one row, one empty state, one error. */

function mount(node: VNode): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => { render(node, host) })
  return host
}

afterEach(() => { document.body.innerHTML = '' })

describe('a panel row', () => {
  it('folds its body behind a chevron that says which way it is', () => {
    function Host(): VNode {
      const [open, setOpen] = useState(false)
      return <PanelRow open={open} onToggle={() => setOpen((o) => !o)} label="npm test" mono meta="exit 0">the output</PanelRow>
    }
    const host = mount(<Host />)
    const toggle = host.querySelector<HTMLButtonElement>('[aria-expanded]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(host.textContent).not.toContain('the output')
    act(() => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(host.textContent).toContain('the output')
    expect(host.querySelector('[data-panel-row]')?.hasAttribute('data-open')).toBe(true)
  })

  it('makes the label a button only when the row opens something', () => {
    const onOpen = vi.fn()
    const host = mount(<PanelRow label="src/a.ts" onOpen={onOpen} />)
    act(() => host.querySelector<HTMLButtonElement>('button')!.click())
    expect(onOpen).toHaveBeenCalledOnce()
    document.body.innerHTML = ''
    const plain = mount(<PanelRow label="src/a.ts" />)
    expect(plain.querySelector('button')).toBeNull()
  })
})

describe('what a list says when it cannot list', () => {
  it('an error offers a retry when there is one', () => {
    const retry = vi.fn()
    const host = mount(<PanelError message="the store is locked" onRetry={retry} />)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('the store is locked')
    act(() => host.querySelector<HTMLButtonElement>('button')!.click())
    expect(retry).toHaveBeenCalledOnce()
    document.body.innerHTML = ''
    const plain = mount(<PanelError message="gone" />)
    expect(plain.querySelector('button')).toBeNull()
  })

  it('an empty state carries the hint and the one thing to do', () => {
    const host = mount(<PanelEmpty icon={<span>i</span>} title="Nothing yet" hint="It fills as the agent works." action={<button type="button">Start</button>} />)
    const empty = host.querySelector('[data-panel="empty"]')!
    expect(empty.textContent).toContain('Nothing yet')
    expect(empty.textContent).toContain('It fills as the agent works.')
    expect(empty.querySelector('button')?.textContent).toBe('Start')
  })
})
