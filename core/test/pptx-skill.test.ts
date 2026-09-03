import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

/**
 * The bundled pptx skill's tool, driven the way the model drives it: as a command. The sample
 * spec exercises every slide type; the assertions are on what the tool SAYS (the plan, the
 * fit report, the errors that name their fix) and on the file it writes (readable back by its
 * own outline, valid as a package, editable). Rendering needs PowerPoint and runs only where
 * it is installed — on CI those tests skip.
 */

const SKILL = join(__dirname, '..', 'skills', 'pptx')
const TOOL = join(SKILL, 'pptx.cjs')
const SAMPLE = join(SKILL, 'examples', 'sample.json')

function run(args: string[], cwd?: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', cwd, windowsHide: true, timeout: 180_000 })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function hasPowerPoint(): boolean {
  if (process.platform !== 'win32') return false
  const r = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\POWERPNT.EXE'], { encoding: 'utf8', windowsHide: true })
  return r.status === 0
}

let tmp: string
let deck: string
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pc-pptx-'))
  deck = join(tmp, 'sample.pptx')
})
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows may still hold a handle */ } })

test('check reads the sample spec and describes the layout of every slide', () => {
  const r = run(['check', SAMPLE])
  expect(r.code, r.out).toBe(0)
  expect(r.out).toContain('12 slides fit')
  expect(r.out).toContain('theme ocean')
  expect(r.out).toContain('6 cards in a 2×3 grid')
  expect(r.out).toContain('column chart with an insight panel')
  expect(r.out).toContain('bullets with stats on the right')
  expect(r.out).toContain('timeline with 5 steps')
  // The fit report says what size and how full, so a model can act on it.
  expect(r.out).toMatch(/bullets \d+(\.\d+)?pt, \d+% of the box/)
})

test('build writes a valid package that its own outline reads back', () => {
  const r = run(['build', SAMPLE, deck, '--quiet'])
  expect(r.code, r.out).toBe(0)
  expect(r.out).toContain('package valid')
  expect(statSync(deck).size).toBeGreaterThan(100_000)

  const v = run(['validate', deck])
  expect(v.code, v.out).toBe(0)
  expect(v.out).toContain('12 slides')

  const o = run(['outline', deck, '--json'])
  expect(o.code, o.out).toBe(0)
  const slides = JSON.parse(o.out) as Array<{ n: number; title: string; notes: string; tables: Array<{ rows: string[][] }>; charts: string[]; pictures: unknown[] }>
  expect(slides).toHaveLength(12)
  expect(slides[0]!.title).toBe('The 2026 network review')
  expect(slides[1]!.notes).toContain('cost figure')
  expect(slides[3]!.title).toBe('Three decisions that moved the numbers')
  expect(slides[6]!.tables[0]!.rows).toHaveLength(7) // header + six hubs
  expect(slides[6]!.tables[0]!.rows[1]![0]).toBe('Warsaw')
  expect(slides[5]!.charts).toHaveLength(1)
  expect(slides[9]!.pictures).toHaveLength(1)

  const text = run(['outline', deck])
  expect(text.out).toContain('Slide 8 — Old routing versus the live model')
  expect(text.out).toContain('[notes] The Vilnius case')
})

test('replace changes every run it finds and counts them; slides trims and reorders', () => {
  const replaced = join(tmp, 'replaced.pptx')
  const r = run(['replace', deck, replaced, 'Northwind=>Southwind', 'no such phrase=>x'])
  expect(r.code, r.out).toBe(0)
  expect(r.out).toMatch(/^[1-9]\d* × "Northwind" → "Southwind"/m)
  expect(r.out).toMatch(/^0 × "no such phrase"/m)
  const o = run(['outline', replaced])
  expect(o.out).toContain('Southwind')
  expect(o.out).not.toContain('Northwind')

  const dropped = join(tmp, 'dropped.pptx')
  expect(run(['slides', deck, dropped, '--drop', '2,3']).code).toBe(0)
  const d = JSON.parse(run(['outline', dropped, '--json']).out) as Array<{ title: string }>
  expect(d).toHaveLength(10)
  expect(d[1]!.title).toBe('Three decisions that moved the numbers')
  expect(run(['validate', dropped]).code).toBe(0)

  const ordered = join(tmp, 'ordered.pptx')
  expect(run(['slides', deck, ordered, '--order', '3,1,12']).code).toBe(0)
  const s = JSON.parse(run(['outline', ordered, '--json']).out) as Array<{ title: string }>
  expect(s.map((x) => x.title)).toEqual(['What changed in the network', 'The 2026 network review', 'Thank you'])
  expect(run(['validate', ordered]).code).toBe(0)
})

test('a spec with problems is refused with the slide, the field and the fix', () => {
  const bad = {
    title: 'Bad deck',
    theme: 'ocean',
    slides: [
      { type: 'title', title: 'Bad deck' },
      { type: 'bullets', title: 'Too many', bullets: Array.from({ length: 9 }, (_, i) => `bullet ${i + 1}`) },
      { type: 'image', title: 'Missing', image: 'nope.png' },
      { type: 'chart', title: 'Uneven', chart: { kind: 'pie', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] } },
      { type: 'cards', title: 'One card', cards: [{ heading: 'only' }] },
      { type: 'wat', title: 'x' },
    ],
  }
  const file = join(tmp, 'bad.json')
  writeFileSync(file, JSON.stringify(bad))
  const r = run(['check', file])
  expect(r.code).toBe(1)
  expect(r.out).toContain('slides[1] (bullets "Too many"): 9 bullets; the layout holds 8')
  expect(r.out).toContain('image not found')
  expect(r.out).toContain('1 values for 2 categories')
  expect(r.out).toContain('"cards" must hold 2–6 entries')
  expect(r.out).toContain('slides[5]: type "wat"')
})

test('a section divider that introduces a single slide is refused, and a short deck is told not to use them', () => {
  // The shape the live model produced first time: four dividers in ten slides, each
  // followed by one slide. A divider is a pause before a run; before one slide it is a
  // slide spent on nothing.
  const spec = {
    title: 'Dividers',
    slides: [
      { type: 'title', title: 'Dividers' },
      { type: 'section', title: 'Numbers', number: 1 },
      { type: 'stats', title: 'Four numbers', stats: [{ value: '42%', label: 'of something' }], notes: 'say it', callout: 'keep it' },
      { type: 'section', title: 'Plans', number: 2 },
      { type: 'bullets', title: 'Next', bullets: ['one', 'two'], notes: 'say it', callout: 'keep it' },
      { type: 'closing', title: 'Thanks' },
    ],
  }
  const file = join(tmp, 'dividers.json')
  writeFileSync(file, JSON.stringify(spec))
  const r = run(['check', file])
  expect(r.code).toBe(1)
  expect(r.out).toContain('slides[1] (section "Numbers"): a section divider must be followed by at least two content slides; this one has 1')
  expect(r.out).toContain('slides[3] (section "Plans")')
  expect(r.out).toContain('2 section dividers in a 6-slide deck')
})

test('text that cannot fit stops the build, and --force writes it anyway', () => {
  // Eight full-length bullets alone still fit at 12pt across the whole slide; with four
  // sub-bullets under each, forty paragraphs cannot, whatever the size.
  const long = 'This bullet is deliberately far too long to fit on a slide at any reasonable size, and it goes on and on about nothing in particular so that the layout has no room. '.repeat(2)
  const spec = {
    title: 'Overflow',
    slides: [
      { type: 'title', title: 'Overflow' },
      { type: 'bullets', title: 'Way too much', bullets: Array.from({ length: 8 }, () => ({ text: long.slice(0, 160), sub: Array.from({ length: 4 }, () => long.slice(20, 140)) })) },
    ],
  }
  const file = join(tmp, 'overflow.json')
  writeFileSync(file, JSON.stringify(spec))
  const r = run(['check', file])
  expect(r.code).toBe(1)
  expect(r.out).toContain('does not fit')
  const out = join(tmp, 'overflow.pptx')
  expect(run(['build', file, out, '--quiet']).code).toBe(1)
  expect(existsSync(out)).toBe(false)
  const forced = run(['build', file, out, '--quiet', '--force'])
  expect(forced.code, forced.out).toBe(0)
  expect(forced.out).toContain('Forced')
  expect(existsSync(out)).toBe(true)
})

test('example writes a spec that builds, and the usage is printed for a bad call', () => {
  const file = join(tmp, 'from-example.json')
  const r = run(['example', file])
  expect(r.code, r.out).toBe(0)
  expect(existsSync(file)).toBe(true)
  expect(existsSync(join(tmp, 'figure.png'))).toBe(true)
  const spec = JSON.parse(readFileSync(file, 'utf8')) as { slides: unknown[] }
  expect(spec.slides).toHaveLength(12)
  expect(run(['check', file]).code).toBe(0)
  expect(run([]).code).toBe(2)
  expect(run(['frobnicate']).code).toBe(2)
  expect(run(['themes']).out).toContain('midnight')
})

describe.skipIf(!hasPowerPoint())('with PowerPoint installed', () => {
  test('render writes one PNG per slide and a contact sheet, through PowerPoint', () => {
    const src = join(tmp, 'render-me.pptx')
    copyFileSync(deck, src)
    const out = join(tmp, 'qa')
    const r = run(['render', src, '-o', out, '--width', '800', '--grid'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('Rendered 12 slides with PowerPoint')
    for (let i = 1; i <= 12; i += 1) expect(existsSync(join(out, `slide-${String(i).padStart(2, '0')}.png`))).toBe(true)
    expect(existsSync(join(out, 'slide-grid.jpg'))).toBe(true)
    expect(statSync(join(out, 'slide-01.png')).size).toBeGreaterThan(5_000)
  }, 180_000)
})
