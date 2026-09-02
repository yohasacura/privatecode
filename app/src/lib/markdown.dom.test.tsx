// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Markdown } from './markdown'

/** A ```mermaid block is a diagram container, not a code block (the `mermaid` skill writes them). */

let host: HTMLElement
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host) })
afterEach(() => { render(null, host); host.remove() })

describe('mermaid blocks', () => {
  it('render into their own container, labelled, while every other fence stays a code block', () => {
    act(() => {
      render(<Markdown text={'Before\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\n```ts\nconst x = 1\n```\n'} />, host)
    })
    const diagram = host.querySelector('[data-mermaid]')!
    expect(diagram).not.toBeNull()
    expect(diagram.querySelector('.md-lang')?.textContent).toBe('mermaid')
    // Not rendered as code: the source is handed to the renderer, not printed.
    expect(diagram.querySelector('pre')).toBeNull()
    const code = [...host.querySelectorAll('.md-code')].filter((n) => !n.hasAttribute('data-mermaid'))
    expect(code).toHaveLength(1)
    expect(code[0]?.querySelector('.md-lang')?.textContent).toBe('ts')
  })
})
