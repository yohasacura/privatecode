'use strict'
/**
 * One builder per slide type. Each takes the normalised slide (spec.cjs), draws it with the
 * vocabulary in draw.cjs, and returns a report line: which layout was used, how the text was
 * fitted, and anything the author should hear about. A builder never lets text overflow: when
 * the smallest allowed size still does not fit, it reports an error and the deck is not
 * written (unless `--force`).
 *
 * The layouts are deliberately varied — cards, columns, stats, a chart panel, an image with
 * text, a timeline — because a deck that is title-and-bullets twelve times over is the thing
 * this skill exists to avoid.
 */
const draw = require('./draw.cjs')
const fit = require('./fit.cjs')

function report(layout) {
  return { layout, fit: [], warnings: [], errors: [] }
}

function pct(x) { return `${Math.round(x * 100)}%` }

/** Title band + the y where content starts, with the subtitle if the slide has one. */
function head(slide, T, s, rep) {
  const t = draw.title(slide, T, s.title, { sub: s.subtitle })
  if (t.lines > 1) rep.warnings.push(`the title wraps to two lines at ${t.size}pt; a shorter title reads better`)
  return t.y
}

function bottom(T, s) {
  return s.callout ? T.BOTTOM_WITH_CALLOUT : T.BOTTOM
}

/** The parts every content slide ends with: callout, footer, notes. */
function finish(slide, T, s, ctx, rep, { dark = false } = {}) {
  if (s.callout) {
    const c = draw.callout(slide, T, s.callout, { dark })
    if (c.lines > 1) rep.warnings.push('the callout runs to two lines; one sentence is stronger')
  }
  draw.footer(slide, T, ctx.footer, ctx.n, { dark })
  if (s.notes) slide.addNotes(s.notes)
}

function bulletsInto(slide, T, s, items, b, rep, label, extra = {}) {
  const r = draw.bullets(slide, T, items, b, extra)
  rep.fit.push(`${label} ${r.size}pt, ${pct(r.fill)} of the box`)
  if (!r.fits) rep.errors.push(`${label}: does not fit even at ${r.size}pt — shorten the items or split the slide`)
  return r
}

const LAYOUTS = {
  title(slide, T, s, ctx) {
    const rep = report('title slide, dark')
    slide.background = { color: T.c.dark }
    draw.motif(slide, T)
    let y = 1.35
    if (s.kicker) {
      draw.text(slide, T, s.kicker, { x: T.M, y: 0.95, w: 9, h: 0.3 }, { size: 11, bold: true, color: T.c.accent, charSpacing: 2.2, valign: 'middle' })
    }
    const st = { bold: true, serif: T.headSerif }
    let size = 40
    let lines = fit.lineCount(s.title, 10.4 * 72, size, st)
    while (lines > 3 && size > 28) { size -= 2; lines = fit.lineCount(s.title, 10.4 * 72, size, st) }
    if (lines > 3) rep.errors.push('the deck title does not fit in three lines at 28pt — shorten it')
    const th = (lines * size * 1.2 * 0.98) / 72 + 0.1
    draw.text(slide, T, s.title, { x: T.M, y, w: 10.4, h: th }, { head: true, size, bold: true, color: T.c.white, valign: 'top', lineSpacing: 0.98 })
    rep.fit.push(`title ${size}pt on ${lines} line${lines > 1 ? 's' : ''}`)
    y += th + 0.18
    if (s.subtitle) {
      const r = draw.paragraph(slide, T, s.subtitle, { x: T.M, y, w: 10.0, h: 1.0 }, { max: 19, min: 14, color: T.c.accentSoft, lineSpacing: 1.1 })
      rep.fit.push(`subtitle ${r.size}pt`)
      if (!r.fits) rep.errors.push('the subtitle is too long for the title slide — two lines at most')
    }
    const meta = [s.author, s.organization, s.date].filter(Boolean).join('   ·   ')
    if (meta) draw.text(slide, T, meta, { x: T.M, y: T.H - 1.25, w: 10, h: 0.36 }, { size: 12, color: T.c.onDarkMute, valign: 'middle' })
    if (s.notes) slide.addNotes(s.notes)
    return rep
  },

  section(slide, T, s, ctx) {
    const rep = report('section divider, dark')
    slide.background = { color: T.c.dark }
    draw.motif(slide, T)
    const num = s.number !== undefined ? String(s.number).padStart(2, '0') : null
    const x = num ? T.M + 2.3 : T.M
    if (num) draw.text(slide, T, num, { x: T.M, y: 2.05, w: 2.1, h: 1.2 }, { head: true, size: 64, bold: true, color: T.c.accent, valign: 'middle', lineSpacing: 1.0 })
    const st = { bold: true, serif: T.headSerif }
    let size = 34
    const w = T.W - T.M - x - 0.4
    let lines = fit.lineCount(s.title, w * 72, size, st)
    while (lines > 3 && size > 26) { size -= 2; lines = fit.lineCount(s.title, w * 72, size, st) }
    if (lines > 3) rep.errors.push('the section title does not fit in three lines — shorten it')
    const th = (lines * size * 1.2) / 72 + 0.1
    draw.text(slide, T, s.title, { x, y: 2.1, w, h: th }, { head: true, size, bold: true, color: T.c.white, valign: 'top', lineSpacing: 1.0 })
    rep.fit.push(`title ${size}pt on ${lines} line${lines > 1 ? 's' : ''}`)
    if (s.text) {
      const r = draw.paragraph(slide, T, s.text, { x, y: 2.1 + th + 0.16, w: Math.min(w, 8.4), h: 1.4 }, { max: 17, min: 13, color: T.c.onDark })
      rep.fit.push(`text ${r.size}pt`)
      if (!r.fits) rep.errors.push('the section text is too long — three lines at most')
    }
    draw.footer(slide, T, ctx.footer, ctx.n, { dark: true })
    if (s.notes) slide.addNotes(s.notes)
    return rep
  },

  bullets(slide, T, s, ctx) {
    const side = s.image ? 'image' : s.stats && s.stats.length > 0 ? 'stats' : 'none'
    const rep = report(side === 'none' ? 'bullets, full width' : `bullets with ${side} on the right`)
    slide.background = { color: T.c.paper }
    const y = head(slide, T, s, rep)
    const bot = bottom(T, s)
    const h = bot - y
    if (side === 'none') {
      const r = bulletsInto(slide, T, s, s.bullets, { x: T.M, y, w: T.CW - 0.6, h }, rep, 'bullets', { max: 18, min: 12 })
      if (r.fill < 0.4 && !s.callout) rep.warnings.push('the slide is mostly empty — add a callout, a stat or an image, or merge it into another slide')
    } else if (side === 'image') {
      const iw = T.CW * 0.44
      bulletsInto(slide, T, s, s.bullets, { x: T.M, y, w: T.CW - iw - 0.4, h }, rep, 'bullets', { max: 17, min: 12 })
      draw.image(slide, T, s.image, { x: T.W - T.M - iw, y, w: iw, h }, { caption: s.caption })
    } else {
      const cw = 3.5
      bulletsInto(slide, T, s, s.bullets, { x: T.M, y, w: T.CW - cw - 0.4, h }, rep, 'bullets', { max: 17, min: 12 })
      const cx = T.W - T.M - cw
      const per = Math.min(1.3, (h - 0.3) / s.stats.length)
      draw.card(slide, T, { x: cx, y, w: cw, h: Math.min(h, per * s.stats.length + 0.3) })
      s.stats.forEach((st, i) => {
        const r = draw.stat(slide, T, st, { x: cx + 0.3, y: y + 0.18 + i * per, w: cw - 0.6, h: per - 0.1 }, { max: 34, min: 20 })
        if (!r.fits) rep.errors.push(`stat "${st.value}": too long for the side column`)
      })
      rep.fit.push(`${s.stats.length} stat${s.stats.length > 1 ? 's' : ''} in the side column`)
    }
    finish(slide, T, s, ctx, rep)
    return rep
  },

  text(slide, T, s, ctx) {
    const rep = report('statement: one paragraph, large')
    slide.background = { color: T.c.paper }
    const y = head(slide, T, s, rep)
    const h = bottom(T, s) - y - 0.1
    const r = draw.paragraph(slide, T, s.text, { x: T.M, y: y + 0.1, w: T.CW - 1.2, h }, { max: 22, min: 15, color: T.c.ink, lineSpacing: 1.25 })
    rep.fit.push(`text ${r.size}pt, ${pct(r.fill)} of the box`)
    if (!r.fits) rep.errors.push('the text does not fit at 15pt — this layout is for a few sentences; use bullets or split it')
    finish(slide, T, s, ctx, rep)
    return rep
  },

  columns(slide, T, s, ctx) {
    const n = s.columns.length
    const rep = report(`${n} columns as cards`)
    slide.background = { color: T.c.paper }
    const y = head(slide, T, s, rep)
    const h = bottom(T, s) - y
    const gap = 0.3
    const cw = (T.CW - gap * (n - 1)) / n
    s.columns.forEach((col, i) => {
      const x = T.M + i * (cw + gap)
      draw.card(slide, T, { x, y, w: cw, h }, { fill: T.c.tint, line: T.c.tint, shadow: false })
      let cy = y + 0.22
      if (col.heading) {
        draw.heading(slide, T, col.heading, { x: x + 0.28, y: cy, w: cw - 0.56, h: 0.42 }, { color: T.c.dark, size: 15 })
        cy += 0.5
      }
      const body = { x: x + 0.28, y: cy, w: cw - 0.56, h: y + h - cy - 0.22 }
      if (col.bullets && col.bullets.length > 0) {
        bulletsInto(slide, T, s, col.bullets, body, rep, `column ${i + 1}`, { max: 15, min: 11 })
      } else if (col.text) {
        const r = draw.paragraph(slide, T, col.text, body, { max: 15, min: 11 })
        rep.fit.push(`column ${i + 1} text ${r.size}pt, ${pct(r.fill)} of the box`)
        if (!r.fits) rep.errors.push(`column ${i + 1}: the text does not fit — shorten it`)
      }
    })
    finish(slide, T, s, ctx, rep)
    return rep
  },

  cards(slide, T, s, ctx) {
    const n = s.cards.length
    const cols = n <= 3 ? n : n === 4 ? 2 : 3
    const rows = Math.ceil(n / cols)
    const rep = report(`${n} cards in a ${rows}×${cols} grid`)
    slide.background = { color: T.c.paper }
    const y = head(slide, T, s, rep)
    const h = bottom(T, s) - y
    const gap = 0.28
    const cw = (T.CW - gap * (cols - 1)) / cols
    const ch = (h - gap * (rows - 1)) / rows
    s.cards.forEach((c, i) => {
      const x = T.M + (i % cols) * (cw + gap)
      const cy = y + Math.floor(i / cols) * (ch + gap)
      draw.card(slide, T, { x, y: cy, w: cw, h: ch })
      const glyph = c.icon ?? (c.number ?? i + 1)
      draw.badge(slide, T, glyph, x + 0.24, cy + 0.24, { d: 0.5 })
      const headLine = draw.heading(slide, T, c.heading, { x: x + 0.9, y: cy + 0.22, w: cw - 1.12, h: 0.54 }, { size: 15 })
      if (!headLine.fits) rep.warnings.push(`card ${i + 1}: the heading is long; it is shown at ${headLine.size}pt`)
      if (c.text) {
        const body = { x: x + 0.24, y: cy + 0.92, w: cw - 0.48, h: ch - 1.14 }
        const r = draw.paragraph(slide, T, c.text, body, { max: 15, min: 10.5, color: T.c.ink })
        rep.fit.push(`card ${i + 1} ${r.size}pt, ${pct(r.fill)}`)
        if (!r.fits) rep.errors.push(`card ${i + 1} "${c.heading}": the text does not fit — about ${Math.round(ch * 60 / 13 * (cw / 3))} words is the room`)
      }
    })
    finish(slide, T, s, ctx, rep)
    return rep
  },

  stats(slide, T, s, ctx) {
    const n = s.stats.length
    const rep = report(`${n} stat${n > 1 ? 's' : ''} in a row`)
    slide.background = { color: T.c.paper }
    const y = head(slide, T, s, rep)
    const bot = bottom(T, s)
    const gap = 0.3
    const cw = (T.CW - gap * (n - 1)) / n
    const room = bot - y
    const ch = Math.min(2.4, s.text ? 2.2 : room)
    // The cards and the paragraph are one group, centred in the room they have — a band of
    // paper between the text and the callout read as an unfinished slide.
    const paras = s.text ? String(s.text).split(/\n\s*\n/).map((t) => ({ text: t.replace(/\s*\n\s*/g, ' ').trim() })) : []
    const est = s.text ? fit.fitBlock(paras, T.CW - 0.6, room - ch - 0.4, { max: 17, min: 12, step: 0.5, lineSpacing: 1.15, paraGapPt: 10, serif: T.bodySerif }).heightIn : 0
    const groupH = ch + (s.text ? 0.4 + est : 0)
    const cy = y + Math.max(0, (room - groupH) / 2) * 0.85
    s.stats.forEach((st, i) => {
      const x = T.M + i * (cw + gap)
      draw.card(slide, T, { x, y: cy, w: cw, h: ch })
      const r = draw.stat(slide, T, st, { x: x + 0.34, y: cy + 0.34, w: cw - 0.68, h: ch - 0.56 }, { max: 48, min: 24 })
      if (!r.fits) rep.errors.push(`stat "${st.value}": too long for its card — a number and a unit, not a sentence`)
    })
    if (s.text) {
      const ty = cy + ch + 0.4
      const r = draw.paragraph(slide, T, s.text, { x: T.M, y: ty, w: T.CW - 0.6, h: bot - ty }, { max: 17, min: 12 })
      rep.fit.push(`text ${r.size}pt, ${pct(r.fill)}`)
      if (!r.fits) rep.errors.push('the text under the stats does not fit — shorten it')
    }
    finish(slide, T, s, ctx, rep)
    return rep
  },

  image(slide, T, s, ctx) {
    const withText = (s.bullets && s.bullets.length > 0) || s.text
    const rep = report(withText ? `image on the ${s.imageSide ?? 'right'} with text` : 'image, full width')
    slide.background = { color: T.c.paper }
    const y = head(slide, T, s, rep)
    const h = bottom(T, s) - y
    if (!withText) {
      draw.image(slide, T, s.image, { x: T.M, y, w: T.CW, h }, { caption: s.caption })
    } else {
      const iw = T.CW * 0.5
      const left = s.imageSide === 'left'
      const ix = left ? T.M : T.W - T.M - iw
      const tx = left ? T.M + iw + 0.4 : T.M
      draw.image(slide, T, s.image, { x: ix, y, w: iw, h }, { caption: s.caption })
      const box = { x: tx, y, w: T.CW - iw - 0.4, h }
      if (s.bullets && s.bullets.length > 0) bulletsInto(slide, T, s, s.bullets, box, rep, 'bullets', { max: 16, min: 12 })
      else {
        const r = draw.paragraph(slide, T, s.text, box, { max: 16, min: 12 })
        rep.fit.push(`text ${r.size}pt, ${pct(r.fill)}`)
        if (!r.fits) rep.errors.push('the text beside the image does not fit — shorten it')
      }
    }
    finish(slide, T, s, ctx, rep)
    return rep
  },

  chart(slide, T, s, ctx) {
    const rep = report(s.insight ? `${s.chart.kind} chart with an insight panel` : `${s.chart.kind} chart, full width`)
    slide.background = { color: T.c.paper }
    const y = head(slide, T, s, rep)
    const h = bottom(T, s) - y
    if (s.insight) {
      const pw = T.CW * 0.33
      draw.chart(slide, T, s.chart, { x: T.M, y, w: T.CW - pw - 0.4, h })
      const px = T.W - T.M - pw
      draw.card(slide, T, { x: px, y, w: pw, h: Math.min(h, 3.6) }, { fill: T.c.tint, line: T.c.tint, shadow: false })
      draw.badge(slide, T, '→', px + 0.26, y + 0.26, { d: 0.44 })
      const r = draw.paragraph(slide, T, s.insight, { x: px + 0.26, y: y + 0.9, w: pw - 0.52, h: Math.min(h, 3.6) - 1.1 }, { max: 15, min: 11.5, lineSpacing: 1.15 })
      rep.fit.push(`insight ${r.size}pt, ${pct(r.fill)}`)
      if (!r.fits) rep.errors.push('the insight does not fit its panel — two or three sentences')
    } else {
      draw.chart(slide, T, s.chart, { x: T.M, y, w: T.CW, h })
    }
    rep.fit.push(`${s.chart.series.length} series × ${s.chart.categories.length} categories`)
    finish(slide, T, s, ctx, rep)
    return rep
  },

  table(slide, T, s, ctx) {
    const rep = report(`table ${s.rows.length}×${s.columns.length}`)
    slide.background = { color: T.c.paper }
    const y = head(slide, T, s, rep)
    const h = bottom(T, s) - y
    const r = draw.table(slide, T, s, { x: T.M, y, w: T.CW, h })
    rep.fit.push(`cells ${r.size}pt, about ${pct(r.fill)} of the height`)
    if (!r.fits) rep.errors.push(`the table is about ${r.heightIn.toFixed(1)}" tall for a ${h.toFixed(1)}" box — fewer rows, shorter cells, or two slides`)
    finish(slide, T, s, ctx, rep)
    return rep
  },

  timeline(slide, T, s, ctx) {
    const n = s.steps.length
    const rep = report(`timeline with ${n} steps`)
    slide.background = { color: T.c.paper }
    const y0 = head(slide, T, s, rep)
    const bot = bottom(T, s)
    const y = y0 + 0.5
    const step = T.CW / n
    slide.addShape('rect', { x: T.M + step / 2, y: y + 0.34, w: T.CW - step, h: 0.03, fill: { color: T.c.rule }, line: { color: T.c.rule, width: 0 } })
    s.steps.forEach((st, i) => {
      const cx = T.M + i * step
      const on = st.key === true
      slide.addShape('ellipse', { x: cx + step / 2 - 0.17, y: y + 0.18, w: 0.34, h: 0.34, fill: { color: on ? T.c.accent : T.c.supportSoft }, line: { color: T.c.paper, width: 1.5 } })
      draw.text(slide, T, st.label, { x: cx, y: y - 0.2, w: step, h: 0.3 }, { size: 12, bold: true, color: T.c.dark, align: 'center', valign: 'middle' })
      const r = draw.paragraph(slide, T, st.text, { x: cx + 0.08, y: y + 0.66, w: step - 0.16, h: bot - (y + 0.66) }, { max: 12, min: 9.5, color: on ? T.c.dark : T.c.mute, bold: on, align: 'center', lineSpacing: 1.08 })
      if (!r.fits) rep.errors.push(`step ${i + 1} "${st.label}": the text does not fit under its dot — a line or two`)
    })
    rep.fit.push(`${n} steps, ${step.toFixed(2)}" each`)
    finish(slide, T, s, ctx, rep)
    return rep
  },

  quote(slide, T, s, ctx) {
    const rep = report('quote, dark')
    slide.background = { color: T.c.dark }
    draw.motif(slide, T)
    draw.text(slide, T, '“', { x: T.M - 0.05, y: 0.9, w: 1.6, h: 1.4 }, { head: true, size: 110, bold: true, color: T.c.accent, valign: 'top', lineSpacing: 0.8 })
    const r = draw.paragraph(slide, T, s.text, { x: T.M + 1.3, y: 1.55, w: T.CW - 1.9, h: 3.4 }, { max: 30, min: 20, color: T.c.white, italic: true, head: true, lineSpacing: 1.2 })
    rep.fit.push(`quote ${r.size}pt, ${pct(r.fill)}`)
    if (!r.fits) rep.errors.push('the quote does not fit at 20pt — trim it to the sentence that matters')
    if (s.attribution) {
      draw.text(slide, T, `— ${s.attribution}`, { x: T.M + 1.3, y: 5.25, w: T.CW - 1.9, h: 0.5 }, { size: 15, color: T.c.accentSoft, valign: 'middle' })
    }
    draw.footer(slide, T, ctx.footer, ctx.n, { dark: true })
    if (s.notes) slide.addNotes(s.notes)
    return rep
  },

  comparison(slide, T, s, ctx) {
    const rep = report('two sides compared')
    slide.background = { color: T.c.paper }
    const y = head(slide, T, s, rep)
    const h = bottom(T, s) - y
    const gap = 0.8
    const cw = (T.CW - gap) / 2
    ;[s.left, s.right].forEach((side, i) => {
      const x = T.M + i * (cw + gap)
      draw.card(slide, T, { x, y, w: cw, h }, { fill: i === 0 ? T.c.tint : T.c.white })
      draw.heading(slide, T, side.heading, { x: x + 0.3, y: y + 0.22, w: cw - 0.6, h: 0.44 }, { size: 16, color: i === 0 ? T.c.support : T.c.accent })
      const body = { x: x + 0.3, y: y + 0.8, w: cw - 0.6, h: h - 1.02 }
      if (side.bullets && side.bullets.length > 0) bulletsInto(slide, T, s, side.bullets, body, rep, i === 0 ? 'left' : 'right', { max: 15, min: 11 })
      else if (side.text) {
        const r = draw.paragraph(slide, T, side.text, body, { max: 15, min: 11 })
        rep.fit.push(`${i === 0 ? 'left' : 'right'} text ${r.size}pt, ${pct(r.fill)}`)
        if (!r.fits) rep.errors.push(`${i === 0 ? 'left' : 'right'} side: the text does not fit`)
      }
    })
    draw.badge(slide, T, s.versus ?? 'vs', T.M + cw + gap / 2 - 0.3, y + h / 2 - 0.3, { d: 0.6, size: 13 })
    finish(slide, T, s, ctx, rep)
    return rep
  },

  closing(slide, T, s, ctx) {
    const rep = report('closing slide, dark')
    slide.background = { color: T.c.dark }
    draw.motif(slide, T)
    const st = { bold: true, serif: T.headSerif }
    let size = 38
    let lines = fit.lineCount(s.title, 10 * 72, size, st)
    while (lines > 2 && size > 28) { size -= 2; lines = fit.lineCount(s.title, 10 * 72, size, st) }
    const th = (lines * size * 1.2) / 72 + 0.1
    draw.text(slide, T, s.title, { x: T.M, y: 1.7, w: 10, h: th }, { head: true, size, bold: true, color: T.c.white, valign: 'top', lineSpacing: 1.0 })
    let y = 1.7 + th + 0.2
    if (s.text) {
      const r = draw.paragraph(slide, T, s.text, { x: T.M, y, w: 9.4, h: 1.6 }, { max: 18, min: 14, color: T.c.accentSoft })
      rep.fit.push(`text ${r.size}pt`)
      if (!r.fits) rep.errors.push('the closing text does not fit — three lines at most')
      y += 1.7
    }
    if (s.contacts && s.contacts.length > 0) {
      const runs = s.contacts.map((c, i) => ({ text: c, options: { breakLine: i < s.contacts.length - 1, paraSpaceAfter: 6 } }))
      slide.addText(runs, { x: T.M, y: Math.max(y, T.H - 2.3), w: 9, h: 1.4, fontFace: T.fonts.body, fontSize: 13, color: T.c.onDark, isTextBox: true, margin: 0, valign: 'top' })
    }
    draw.footer(slide, T, ctx.footer, ctx.n, { dark: true })
    if (s.notes) slide.addNotes(s.notes)
    return rep
  },
}

/** Draws every slide of a normalised spec into `pres`; returns one report per slide. */
function build(pres, T, spec) {
  const footer = spec.footer !== undefined ? spec.footer : spec.title.length > 72 ? `${spec.title.slice(0, 70)}…` : spec.title
  const reports = []
  spec.slides.forEach((s, i) => {
    const slide = pres.addSlide()
    const ctx = { n: i + 1, count: spec.slides.length, footer }
    const rep = LAYOUTS[s.type](slide, T, s, ctx)
    reports.push({ n: i + 1, type: s.type, title: s.title ?? s.text ?? '', ...rep })
  })
  return reports
}

module.exports = { build, LAYOUTS }
