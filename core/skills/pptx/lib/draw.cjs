'use strict'
/**
 * The drawing vocabulary every layout is built from: a title band, a bullet list, a card, a
 * badge, a stat, a chart, a table, an image, a footer, a callout. Each one measures the text
 * it is given (fit.cjs) and picks the size that fits, so a layout never has to guess — and
 * reports back what it chose, so `check`/`build` can tell the author how full a box is.
 *
 * pptxgenjs footguns are absorbed here once: colours are six hex digits with no `#`, every
 * text box is `isTextBox` with `margin: 0`, shadows have non-negative offsets, option objects
 * are built fresh per call (the library mutates them), and lists are arrays of runs with
 * `breakLine` on every item but the last.
 */
const fs = require('node:fs')
const { imageSize } = require('image-size')
const fit = require('./fit.cjs')

const SHADOW = () => ({ type: 'outer', color: '8A96A6', blur: 8, offset: 2, angle: 90, opacity: 0.22 })

function opts(T, b, o) {
  return {
    x: b.x, y: b.y, w: b.w, h: b.h,
    fontFace: o.head ? T.fonts.head : T.fonts.body,
    fontSize: o.size ?? 14,
    color: o.color ?? T.c.ink,
    bold: o.bold === true,
    italic: o.italic === true,
    align: o.align ?? 'left',
    valign: o.valign ?? 'top',
    isTextBox: true,
    margin: 0,
    lineSpacingMultiple: o.lineSpacing ?? 1.1,
    ...(o.charSpacing !== undefined ? { charSpacing: o.charSpacing } : {}),
    ...(o.paraSpaceAfter !== undefined ? { paraSpaceAfter: o.paraSpaceAfter } : {}),
  }
}

/** One text box. `b` is `{x, y, w, h}` in inches. */
function text(slide, T, str, b, o = {}) {
  slide.addText(String(str), opts(T, b, o))
}

function style(T, head, bold) {
  return { bold: bold === true, serif: head ? T.headSerif : T.bodySerif }
}

/** A round badge with a number or a glyph in it — the deck's recurring visual motif. */
function badge(slide, T, label, x, y, { d = 0.5, fill = T.c.accent, color = T.c.dark, size } = {}) {
  slide.addShape('ellipse', { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill, width: 0 } })
  const str = String(label)
  const glyph = /^[0-9]{1,2}$/.test(str) ? T.fonts.body : 'Segoe UI Symbol'
  slide.addText(str, {
    x, y, w: d, h: d, align: 'center', valign: 'middle',
    fontSize: size ?? (str.length > 2 ? d * 20 : d * 30), bold: true, color, fontFace: glyph,
    isTextBox: true, margin: 0,
  })
}

/** A card: soft fill, hairline, a shadow on light backgrounds. Never an edge stripe. */
function card(slide, T, b, { fill, line, shadow = true, dark = false, radius = 0.06 } = {}) {
  const o = {
    x: b.x, y: b.y, w: b.w, h: b.h, rectRadius: radius,
    fill: { color: fill ?? (dark ? T.c.darkCard : T.c.white) },
    line: { color: line ?? (dark ? T.c.darkCard : T.c.rule), width: 0.75 },
  }
  if (shadow && !dark) o.shadow = SHADOW()
  slide.addShape('roundRect', o)
}

/** The decorative circles dark slides carry: one motif, low opacity, off the content. */
function motif(slide, T) {
  // Two circles, mostly off the slide and nearly the background's colour: presence, not a
  // graphic. Both stay right of the text column every dark layout uses (x < 10.6").
  slide.addShape('ellipse', { x: T.W - 2.9, y: T.H - 3.3, w: 5.8, h: 5.8, fill: { color: T.c.accent, transparency: 90 }, line: { color: T.c.accent, transparency: 100, width: 0 } })
  slide.addShape('ellipse', { x: T.W - 1.5, y: -1.9, w: 3.0, h: 3.0, fill: { color: T.c.support, transparency: 70 }, line: { color: T.c.support, transparency: 100, width: 0 } })
}

/**
 * The title band of a content slide. Long titles shrink before they wrap, and wrap to two
 * lines only at the smallest size: a wrapped title used to land on the subtitle.
 * Returns the y where content may start, and what was chosen.
 */
function title(slide, T, str, { y = T.M, sub, color, subColor, dark = false, w } = {}) {
  const width = w ?? T.CW
  const col = color ?? (dark ? T.c.white : T.c.dark)
  const st = style(T, true, true)
  const line = fit.fitLine(str, width, { max: 30, min: 24, step: 1, ...st })
  let size = line.size
  let lines = 1
  if (!line.fits) {
    size = 24
    lines = Math.min(2, fit.lineCount(str, width * 72, size, st))
    if (fit.lineCount(str, width * 72, size, st) > 2) lines = 2
  }
  const th = lines === 1 ? 0.78 : 1.18
  text(slide, T, str, { x: T.M, y, w: width, h: th }, { head: true, size, bold: true, color: col, valign: 'middle', lineSpacing: 1.0 })
  let bottom = y + th
  if (sub) {
    const subSt = style(T, false, false)
    const subLines = fit.lineCount(sub, width * 72, 14, subSt)
    const sh = subLines > 1 ? 0.62 : 0.34
    text(slide, T, sub, { x: T.M, y: bottom - 0.02, w: width, h: sh }, { size: 14, italic: true, color: subColor ?? (dark ? T.c.onDarkMute : T.c.mute), valign: 'top', lineSpacing: 1.05 })
    bottom += sh + 0.12
  } else {
    bottom += 0.16
  }
  return { y: bottom, size, lines }
}

/**
 * A bullet list fitted to its box. Items are `{ text, sub? }`; sub-items indent and drop two
 * points. Returns the size used and how full the box is — or `fits: false` when the text does
 * not fit even at `min`, which the caller turns into an error.
 */
function bullets(slide, T, items, b, { max = 18, min = 12, color, dark = false, numbered = false } = {}) {
  const paragraphs = []
  for (const it of items) {
    paragraphs.push({ text: it.text, level: 0 })
    for (const s of it.sub ?? []) paragraphs.push({ text: s, level: 1 })
  }
  const st = style(T, false, false)
  const r = fit.fitBlock(paragraphs, b.w, b.h, { max, min, step: 0.5, bulleted: true, indentIn: 0.28, ...st })
  const runs = []
  let n = 0
  paragraphs.forEach((p, i) => {
    const last = i === paragraphs.length - 1
    const size = Math.max(6, r.size - p.level * 2)
    const bullet = p.level === 0
      ? (numbered ? { type: 'number', indent: 20 } : { code: '25AA', indent: 20 })
      : { code: '2013', indent: 18 }
    if (p.level === 0) n += 1
    runs.push({
      text: p.text,
      options: {
        bullet, breakLine: !last, fontSize: size,
        indentLevel: p.level,
        paraSpaceAfter: p.level === 0 ? r.size * 0.45 : r.size * 0.25,
        color: color ?? (dark ? T.c.onDark : T.c.ink),
      },
    })
  })
  slide.addText(runs, {
    x: b.x, y: b.y, w: b.w, h: b.h, fontFace: T.fonts.body, fontSize: r.size,
    color: color ?? (dark ? T.c.onDark : T.c.ink), isTextBox: true, margin: 0, valign: 'top',
    lineSpacingMultiple: 1.12,
  })
  return { size: r.size, fill: r.fill, fits: r.fits, heightIn: r.heightIn, count: n }
}

/** A plain paragraph (or several, separated by blank lines) fitted to its box. */
function paragraph(slide, T, str, b, { max = 16, min = 11, color, dark = false, italic = false, bold = false, align = 'left', head = false, lineSpacing = 1.15 } = {}) {
  const paras = String(str).split(/\n\s*\n/).map((t) => ({ text: t.replace(/\s*\n\s*/g, ' ').trim() })).filter((p) => p.text !== '')
  const st = style(T, head, bold)
  const r = fit.fitBlock(paras, b.w, b.h, { max, min, step: 0.5, lineSpacing, paraGapPt: max * 0.6, ...st })
  const runs = paras.map((p, i) => ({ text: p.text, options: { breakLine: i < paras.length - 1, paraSpaceAfter: r.size * 0.6 } }))
  slide.addText(runs.length === 1 ? runs[0].text : runs, {
    x: b.x, y: b.y, w: b.w, h: b.h, fontFace: head ? T.fonts.head : T.fonts.body, fontSize: r.size,
    color: color ?? (dark ? T.c.onDark : T.c.ink), italic, bold, align, isTextBox: true, margin: 0, valign: 'top',
    lineSpacingMultiple: lineSpacing,
  })
  return { size: r.size, fill: r.fill, fits: r.fits }
}

/** A big number with its label under it. The number shrinks to stay on one line. */
function stat(slide, T, { value, label }, b, { valueColor, labelColor, max = 44, min = 22, dark = false, align = 'left' } = {}) {
  const st = style(T, true, true)
  const line = fit.fitLine(String(value), b.w, { max, min, step: 1, ...st })
  const vh = line.size >= 36 ? 0.76 : line.size >= 28 ? 0.62 : 0.52
  text(slide, T, value, { x: b.x, y: b.y, w: b.w, h: vh }, { head: true, size: line.size, bold: true, color: valueColor ?? (dark ? T.c.accentSoft : T.c.dark), valign: 'middle', align, lineSpacing: 1.0 })
  const lh = Math.max(0.3, b.h - vh - 0.04)
  const lab = fit.fitBlock([{ text: label }], b.w, lh, { max: 13, min: 10, step: 0.5, lineSpacing: 1.05, ...style(T, false, false) })
  text(slide, T, label, { x: b.x, y: b.y + vh + 0.02, w: b.w, h: lh }, { size: lab.size, color: labelColor ?? (dark ? T.c.onDarkMute : T.c.mute), valign: 'top', align, lineSpacing: 1.05 })
  return { size: line.size, fits: line.fits && lab.fits }
}

/** Deck name on the left, slide number on the right; quiet on either background. */
function footer(slide, T, str, n, { dark = false } = {}) {
  const col = dark ? T.c.onDarkMute : T.c.mute
  if (str) text(slide, T, str, { x: T.M, y: T.FOOTER_Y, w: T.CW - 1.0, h: 0.3 }, { size: 9, color: col, valign: 'middle' })
  text(slide, T, String(n), { x: T.W - T.M - 0.6, y: T.FOOTER_Y, w: 0.6, h: 0.3 }, { size: 10, color: col, valign: 'middle', align: 'right' })
}

/** The takeaway strip along the bottom: the sentence the speaker says last on this slide. */
function callout(slide, T, str, { dark = false } = {}) {
  const st = style(T, false, true)
  const line = fit.fitLine(str, T.CW - 0.88, { max: 13.5, min: 11, step: 0.5, ...st })
  const two = !line.fits
  const h = two ? 0.76 : T.CALLOUT_H
  const y = two ? T.CALLOUT_Y - 0.2 : T.CALLOUT_Y
  slide.addShape('roundRect', { x: T.M, y, w: T.CW, h, rectRadius: 0.04, fill: { color: dark ? T.c.darkCard : T.c.tint2 }, line: { color: dark ? T.c.darkCard : T.c.tint2, width: 0 } })
  slide.addShape('ellipse', { x: T.M + 0.16, y: y + h / 2 - 0.08, w: 0.16, h: 0.16, fill: { color: T.c.accent }, line: { color: T.c.accent, width: 0 } })
  text(slide, T, str, { x: T.M + 0.44, y, w: T.CW - 0.88, h }, { size: two ? 11.5 : line.size, italic: true, bold: true, color: dark ? T.c.accentSoft : T.c.dark, valign: 'middle', lineSpacing: 1.05 })
  return { lines: two ? 2 : 1 }
}

/** An image, contained in its box and centred; a caption under it if there is one. */
function image(slide, T, file, b, { caption, dark = false } = {}) {
  let iw = 4, ih = 3
  try {
    const dim = imageSize(fs.readFileSync(file))
    if (dim.width > 0 && dim.height > 0) { iw = dim.width; ih = dim.height }
  } catch { /* an unreadable header: assume 4:3, the layout still holds */ }
  const capH = caption ? 0.36 : 0
  const boxH = b.h - capH
  const scale = Math.min(b.w / iw, boxH / ih)
  const w = iw * scale
  const h = ih * scale
  const x = b.x + (b.w - w) / 2
  const y = b.y + (boxH - h) / 2
  slide.addImage({ path: file, x, y, w, h })
  if (caption) {
    text(slide, T, caption, { x: b.x, y: y + h + 0.06, w: b.w, h: 0.3 }, { size: 10.5, italic: true, color: dark ? T.c.onDarkMute : T.c.mute, align: 'center', valign: 'top' })
  }
  return { w, h }
}

/**
 * A native chart. Quiet by default — gridlines faint, axes muted, labels on — and coloured
 * from the palette. Single-series charts carry no legend; pies show percentages.
 */
function chart(slide, T, spec, b) {
  const kind = spec.kind
  const data = spec.series.map((s) => ({ name: s.name, labels: spec.categories, values: s.values }))
  const multi = spec.series.length > 1
  const round = kind === 'pie' || kind === 'doughnut'
  const common = {
    x: b.x, y: b.y, w: b.w, h: b.h,
    // One series, one colour: pptxgenjs otherwise colours every bar differently, which reads
    // as seven categories of data rather than one measure over time.
    chartColors: multi || round ? T.chartColors : [T.c.accent],
    dataLabelFormatCode: '#,##0.#',
    showTitle: false,
    showLegend: multi || kind === 'pie' || kind === 'doughnut',
    legendPos: 'b', legendFontSize: 11, legendColor: T.c.mute, legendFontFace: T.fonts.body,
    dataLabelFontFace: T.fonts.body, dataLabelFontSize: 10.5, dataLabelColor: T.c.ink,
    catAxisLabelFontFace: T.fonts.body, catAxisLabelFontSize: 11, catAxisLabelColor: T.c.mute,
    valAxisLabelFontFace: T.fonts.body, valAxisLabelFontSize: 10, valAxisLabelColor: T.c.mute,
    valGridLine: { color: T.c.rule, size: 0.5, style: 'solid' },
    catGridLine: { style: 'none' },
    valAxisLineShow: false,
    catAxisLineShow: false,
  }
  let type = 'bar'
  let extra = {}
  switch (kind) {
    case 'bar':
      extra = { barDir: 'bar', barGapWidthPct: 55, showValue: true, dataLabelPosition: 'outEnd' }
      break
    case 'column':
      extra = { barDir: 'col', barGapWidthPct: 55, showValue: true, dataLabelPosition: 'outEnd' }
      break
    case 'stacked':
      // On a stacked chart the label must sit inside the bar: `outEnd` corrupts the file.
      extra = { barDir: 'col', barGrouping: 'stacked', barGapWidthPct: 55, showValue: true, dataLabelPosition: 'ctr', dataLabelColor: T.c.white }
      break
    case 'line':
      type = 'line'
      extra = { lineSize: 2.5, lineDataSymbol: 'circle', lineDataSymbolSize: 7, showValue: spec.categories.length <= 8, dataLabelPosition: 't' }
      break
    case 'area':
      type = 'area'
      extra = { chartColorsOpacity: 35, lineSize: 2 }
      break
    case 'pie':
      type = 'pie'
      extra = { showPercent: true, showValue: false, dataLabelPosition: 'bestFit', showLeaderLines: true, dataLabelColor: T.c.ink }
      break
    case 'doughnut':
      type = 'doughnut'
      extra = { holeSize: 55, showPercent: true, showValue: false, dataLabelPosition: 'bestFit', dataLabelColor: T.c.ink }
      break
    default:
      throw new Error(`chart kind "${kind}"`)
  }
  if (spec.unit && (type === 'bar' || type === 'line' || type === 'area')) {
    extra.valAxisLabelFormatCode = `#,##0"${spec.unit}"`
  }
  if (spec.max !== undefined) extra.valAxisMaxVal = spec.max
  if (spec.min !== undefined) extra.valAxisMinVal = spec.min
  slide.addChart(type, data, { ...common, ...extra })
}

/**
 * A table with a dark header row and zebra body rows. Column widths follow the text; the
 * size follows the row count. Reports the size and its estimated height so a table that
 * would run off the slide is refused before it is drawn.
 */
function table(slide, T, spec, b, { dark = false } = {}) {
  const cols = spec.columns
  const rows = spec.rows
  const nCols = cols.length
  const size = rows.length > 8 ? 10.5 : rows.length > 6 || nCols > 5 ? 12 : 14
  const st = style(T, false, false)
  // Natural widths from the longest cell in each column, then squeezed into the box.
  const natural = cols.map((c, i) => {
    let w = fit.widthPt(c, size, { ...st, bold: true })
    for (const r of rows) w = Math.max(w, fit.widthPt(String(r[i] ?? ''), size, st))
    return Math.min(w / 72 + 0.3, b.w * 0.5)
  })
  const sum = natural.reduce((a, x) => a + x, 0)
  const minW = 0.9
  let colW = natural.map((w) => Math.max(minW, (w / sum) * b.w))
  const total = colW.reduce((a, x) => a + x, 0)
  colW = colW.map((w) => (w / total) * b.w)
  // Height: header + every row at its wrapped line count, plus cell padding.
  const pad = 0.12
  let height = 0
  const rowLines = (cells, bold) => Math.max(...cells.map((c, i) => fit.lineCount(String(c ?? ''), (colW[i] - 0.16) * 72, size, { ...st, bold })))
  height += rowLines(cols, true) * size * 1.2 / 72 + pad
  for (const r of rows) height += rowLines(r, false) * size * 1.2 / 72 + pad
  const headFill = dark ? T.c.darkCard : T.c.dark
  const body = rows.map((r, ri) => cols.map((_, ci) => ({
    text: String(r[ci] ?? ''),
    options: {
      fontSize: size, color: dark ? T.c.onDark : T.c.ink, fontFace: T.fonts.body, valign: 'middle',
      fill: { color: ri % 2 === 1 ? (dark ? T.c.darkCard : T.c.tint) : (dark ? T.c.dark : T.c.white) },
      bold: spec.boldFirstColumn === true && ci === 0,
      align: spec.align?.[ci] ?? (/^[\s\d.,%+−-]+$/.test(String(r[ci] ?? '')) && String(r[ci] ?? '') !== '' ? 'right' : 'left'),
    },
  })))
  const head = cols.map((c, ci) => ({
    text: String(c),
    options: { bold: true, fontSize: size, color: T.c.white, fill: { color: headFill }, fontFace: T.fonts.body, valign: 'middle', align: spec.align?.[ci] ?? 'left' },
  }))
  slide.addTable([head, ...body], {
    x: b.x, y: b.y, w: b.w, colW,
    border: { type: 'solid', pt: 0.5, color: dark ? T.c.darkCard : T.c.rule },
    margin: 5, autoPage: false, fontFace: T.fonts.body, fontSize: size,
  })
  return { size, heightIn: height, fits: height <= b.h, fill: height / b.h }
}

/** A short heading above a column or card body. */
function heading(slide, T, str, b, { color, size = 15, dark = false, align = 'left' } = {}) {
  const st = style(T, false, true)
  const line = fit.fitLine(str, b.w, { max: size, min: 12, step: 0.5, ...st })
  text(slide, T, str, b, { size: line.size, bold: true, color: color ?? (dark ? T.c.white : T.c.dark), valign: 'middle', align, lineSpacing: 1.0 })
  return line
}

module.exports = { text, badge, card, motif, title, bullets, paragraph, stat, footer, callout, image, chart, table, heading }
