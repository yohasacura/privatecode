// @vitest-environment happy-dom
import { render } from 'preact'
import { afterEach, expect, test } from 'vitest'
import { Icon, type GitMarkKind } from './icons'

/**
 * The git marks carry two facts at once — WHAT changed and whether the next commit takes
 * it — and both are shape, not text: a distinct symbol per state, filled when staged.
 * Neither is enforced by anything else, and losing either is invisible until someone
 * commits the wrong set of files.
 */

let host: HTMLDivElement | null = null

function draw(kind: GitMarkKind, staged: boolean): SVGSVGElement {
  host?.remove()
  host = document.createElement('div')
  document.body.appendChild(host)
  render(Icon.gitMark(kind, staged), host)
  const svg = host.querySelector('svg')
  expect(svg).not.toBeNull()
  return svg as unknown as SVGSVGElement
}

afterEach(() => {
  if (host !== null) render(null, host)
  host?.remove()
  host = null
})

test('staged fills the square, unstaged leaves it an outline', () => {
  expect(draw('M', true).querySelector('rect')?.getAttribute('fill')).toBe('currentColor')
  expect(draw('M', false).querySelector('rect')?.getAttribute('fill')).toBeNull()
})

test('every state draws a different symbol', () => {
  const kinds: GitMarkKind[] = ['M', 'A', 'U', 'D', 'R', '!']
  // The symbol is whatever sits inside the square, so the rect is dropped before
  // comparing: two states that draw the same thing are two states nobody can tell apart.
  const symbols = kinds.map((k) => {
    const svg = draw(k, false)
    return [...svg.children].filter((c) => c.tagName.toLowerCase() !== 'rect')
      .map((c) => `${c.tagName}:${c.getAttribute('d') ?? c.getAttribute('r') ?? ''}`)
      .join('|')
  })
  // A and U are deliberately the same glyph — both mean "this file is new" — so the set is
  // one smaller than the list.
  expect(new Set(symbols).size).toBe(kinds.length - 1)
  expect(symbols.every((s) => s !== '')).toBe(true)
})

test('the knocked-out symbol takes the panel background, not the state colour', () => {
  // Otherwise a filled square shows a same-coloured symbol on itself — a solid blob.
  const staged = draw('D', true)
  const symbol = [...staged.children].find((c) => c.tagName.toLowerCase() !== 'rect')
  expect(symbol?.getAttribute('stroke')).toBe('var(--bg-panel)')
})
