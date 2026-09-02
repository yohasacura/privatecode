import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * The two palettes, checked rather than eyed.
 *
 * A dark palette tuned by hand and then "inverted" for light is how light themes go wrong:
 * the dim label that was fine on near-black is invisible on white. Every text role is
 * checked against every surface it is used on, at the WCAG AA ratio for its size, in both
 * themes. And the two themes must declare the same roles — a token that exists in one and
 * not the other is a colour that silently disappears when the theme flips.
 */

const SRC = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const css = readFileSync(join(SRC, 'tokens.css'), 'utf8')

function block(theme: 'dark' | 'light'): Record<string, string> {
  const re = theme === 'dark'
    ? /:root,\s*\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/
    : /\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/
  const body = re.exec(css)?.[1]
  if (body === undefined) throw new Error(`no ${theme} block`)
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim()
  return out
}

function hex(value: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(value)
  if (m === null) throw new Error(`not an opaque hex colour: ${value}`)
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a: string, b: string): number {
  const la = luminance(hex(a))
  const lb = luminance(hex(b))
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

const dark = block('dark')
const light = block('light')

/** Text roles and the surfaces they sit on, with the ratio each must clear. */
const PAIRS: { text: string; on: string[]; ratio: number }[] = [
  { text: '--text', on: ['--bg', '--bg-panel', '--bg-raised', '--bg-hover', '--bg-active'], ratio: 7 },
  { text: '--text-strong', on: ['--bg', '--bg-panel'], ratio: 7 },
  { text: '--text-dim', on: ['--bg', '--bg-panel', '--bg-raised', '--bg-hover'], ratio: 4.5 },
  // Labels at 12 px on hover surfaces: the large-text bar, because they are never body text.
  { text: '--text-faint', on: ['--bg', '--bg-panel', '--bg-raised'], ratio: 3 },
  { text: '--accent', on: ['--bg', '--bg-panel'], ratio: 3 },
  { text: '--green', on: ['--bg', '--bg-panel'], ratio: 3 },
  { text: '--red', on: ['--bg', '--bg-panel'], ratio: 3 },
  { text: '--yellow', on: ['--bg', '--bg-panel'], ratio: 3 },
  { text: '--blue', on: ['--bg', '--bg-panel'], ratio: 3 },
  { text: '--on-accent', on: ['--accent'], ratio: 4.5 },
  { text: '--diff-add-text', on: ['--bg-panel'], ratio: 3 },
  { text: '--diff-del-text', on: ['--bg-panel'], ratio: 3 },
  { text: '--hl-comment', on: ['--bg-panel'], ratio: 3 },
  { text: '--hl-string', on: ['--bg-panel'], ratio: 3 },
  { text: '--hl-keyword', on: ['--bg-panel'], ratio: 3 },
  { text: '--hl-number', on: ['--bg-panel'], ratio: 3 },
]

describe('the two palettes', () => {
  test('declare the same roles', () => {
    const d = Object.keys(dark).sort()
    const l = Object.keys(light).sort()
    expect(l).toEqual(d)
  })

  for (const theme of ['dark', 'light'] as const) {
    const tokens = theme === 'dark' ? dark : light
    for (const pair of PAIRS) {
      for (const surface of pair.on) {
        test(`${theme}: ${pair.text} on ${surface} clears ${pair.ratio}:1`, () => {
          const ratio = contrast(tokens[pair.text]!, tokens[surface]!)
          expect(ratio, `${tokens[pair.text]} on ${tokens[surface]} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(pair.ratio)
        })
      }
    }
  }
})

describe('the fonts', () => {
  test('are the bundled files, one rule per subset', () => {
    const faces = [...css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map((m) => m[1]!)
    const bundled = faces.filter((f) => f.includes("url('../assets/fonts/"))
    expect(bundled).toHaveLength(5)
    for (const f of bundled) expect(f).toContain('font-display: swap')
    // Cyrillic is a requirement, not a nicety: the owner's prompts are Russian.
    expect(bundled.filter((f) => f.includes('U+0400-045F'))).toHaveLength(2)
  })
})
