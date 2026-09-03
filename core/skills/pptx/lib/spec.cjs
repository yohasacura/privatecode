'use strict'
/**
 * The deck spec: what a JSON file must contain, checked before anything is drawn.
 *
 * Every problem is reported with the slide's index and title and says what to change, so the
 * author (usually a model) can fix the file without reading this code. Limits are the
 * layouts' real capacity, not taste: eight bullets is where 12pt stops fitting, six cards is
 * the largest grid that still holds a sentence per card.
 */
const fs = require('node:fs')
const path = require('node:path')
const { THEMES } = require('./theme.cjs')

const LIMITS = {
  bullets: 8, bulletChars: 160, subBullets: 4,
  columns: [2, 3], cards: [2, 6], stats: [1, 4], steps: [3, 8],
  categories: 12, series: 4, tableRows: 10, tableCols: 6,
  titleChars: 90, quoteChars: 320, contacts: 5,
}

const TYPES = ['title', 'section', 'bullets', 'text', 'columns', 'cards', 'stats', 'image', 'chart', 'table', 'timeline', 'quote', 'comparison', 'closing']
const CHART_KINDS = ['bar', 'column', 'stacked', 'line', 'area', 'pie', 'doughnut']

class Problems {
  constructor() { this.errors = []; this.warnings = [] }
  error(where, msg) { this.errors.push(`${where}: ${msg}`) }
  warn(where, msg) { this.warnings.push(`${where}: ${msg}`) }
}

function isStr(x) { return typeof x === 'string' }
function nonEmpty(x) { return isStr(x) && x.trim() !== '' }

function str(p, where, obj, key, { required = false, max } = {}) {
  const v = obj[key]
  if (v === undefined || v === null || v === '') {
    if (required) p.error(where, `"${key}" is required`)
    return undefined
  }
  if (!isStr(v)) { p.error(where, `"${key}" must be a string`); return undefined }
  const t = v.trim()
  if (max !== undefined && t.length > max) p.warn(where, `"${key}" is ${t.length} characters; ${max} is the comfortable limit`)
  return t
}

/** Bullets may be strings or `{ text, sub: [] }`; both come back as objects. */
function bulletList(p, where, raw, key = 'bullets', { required = false } = {}) {
  if (raw === undefined) {
    if (required) p.error(where, `"${key}" is required — an array of strings`)
    return undefined
  }
  if (!Array.isArray(raw)) { p.error(where, `"${key}" must be an array`); return undefined }
  const out = []
  raw.forEach((item, i) => {
    const w = `${where} ${key}[${i}]`
    if (isStr(item)) {
      if (item.trim() === '') { p.warn(w, 'empty item dropped'); return }
      if (item.length > LIMITS.bulletChars) p.warn(w, `${item.length} characters; keep a bullet under ${LIMITS.bulletChars}`)
      out.push({ text: item.trim(), sub: [] })
      return
    }
    if (item && typeof item === 'object' && isStr(item.text)) {
      const sub = Array.isArray(item.sub) ? item.sub.filter(isStr).map((s) => s.trim()).filter((s) => s !== '') : []
      if (sub.length > LIMITS.subBullets) p.warn(w, `${sub.length} sub-bullets; ${LIMITS.subBullets} at most`)
      out.push({ text: item.text.trim(), sub })
      return
    }
    p.error(w, 'must be a string or { "text": "...", "sub": ["..."] }')
  })
  if (out.length > LIMITS.bullets) p.error(where, `${out.length} bullets; the layout holds ${LIMITS.bullets} — split the slide`)
  if (required && out.length === 0) p.error(where, `"${key}" needs at least one item`)
  return out
}

function stats(p, where, raw, { required = false } = {}) {
  if (raw === undefined) { if (required) p.error(where, '"stats" is required'); return undefined }
  if (!Array.isArray(raw)) { p.error(where, '"stats" must be an array of { "value", "label" }'); return undefined }
  const out = []
  raw.forEach((s, i) => {
    const w = `${where} stats[${i}]`
    if (!s || typeof s !== 'object') { p.error(w, 'must be { "value": "42%", "label": "..." }'); return }
    const value = s.value === undefined ? undefined : String(s.value).trim()
    const label = str(p, w, s, 'label', { required: true, max: 70 })
    if (!nonEmpty(value)) { p.error(w, '"value" is required — a number with its unit, like "42%" or "1.8 млн"'); return }
    if (value.length > 14) p.warn(w, `value "${value}" is long; a stat is a number, not a phrase`)
    out.push({ value, label: label ?? '' })
  })
  const [lo, hi] = LIMITS.stats
  if (out.length < lo || out.length > hi) p.error(where, `${out.length} stats; between ${lo} and ${hi}`)
  return out
}

function resolveImage(p, where, file, specDir) {
  if (file === undefined) return undefined
  if (!nonEmpty(file)) { p.error(where, '"image" must be a file path'); return undefined }
  const abs = path.isAbsolute(file) ? file : path.resolve(specDir, file)
  if (!fs.existsSync(abs)) { p.error(where, `image not found: ${abs}`); return undefined }
  if (!/\.(png|jpe?g|gif|bmp)$/i.test(abs)) p.error(where, `"${path.basename(abs)}": only PNG, JPEG, GIF and BMP can be placed`)
  return abs
}

function chart(p, where, raw) {
  if (!raw || typeof raw !== 'object') { p.error(where, '"chart" is required: { "kind", "categories", "series" }'); return undefined }
  const kind = str(p, where, raw, 'kind', { required: true })
  if (kind !== undefined && !CHART_KINDS.includes(kind)) p.error(where, `chart kind "${kind}"; one of ${CHART_KINDS.join(', ')}`)
  const categories = Array.isArray(raw.categories) ? raw.categories.map((c) => String(c)) : undefined
  if (categories === undefined) p.error(where, '"chart.categories" must be an array of labels')
  else if (categories.length > LIMITS.categories) p.error(where, `${categories.length} categories; ${LIMITS.categories} at most — group the tail`)
  let series
  if (!Array.isArray(raw.series) || raw.series.length === 0) p.error(where, '"chart.series" must be a non-empty array of { "name", "values" }')
  else {
    series = []
    raw.series.forEach((s, i) => {
      const w = `${where} series[${i}]`
      if (!s || typeof s !== 'object' || !Array.isArray(s.values)) { p.error(w, 'must be { "name": "...", "values": [numbers] }'); return }
      const values = s.values.map((v) => (typeof v === 'number' ? v : Number(String(v).replace(',', '.'))))
      if (values.some((v) => !Number.isFinite(v))) p.error(w, 'every value must be a number')
      if (categories && values.length !== categories.length) p.error(w, `${values.length} values for ${categories.length} categories`)
      series.push({ name: nonEmpty(s.name) ? s.name.trim() : `Series ${i + 1}`, values })
    })
    if (series.length > LIMITS.series) p.error(where, `${series.length} series; ${LIMITS.series} at most`)
    if ((kind === 'pie' || kind === 'doughnut') && series.length > 1) p.error(where, `a ${kind} chart takes one series`)
  }
  const out = { kind, categories, series }
  if (nonEmpty(raw.unit)) out.unit = raw.unit.trim()
  if (typeof raw.max === 'number') out.max = raw.max
  if (typeof raw.min === 'number') out.min = raw.min
  return out
}

function tableSpec(p, where, s) {
  const columns = Array.isArray(s.columns) ? s.columns.map((c) => String(c)) : undefined
  if (columns === undefined || columns.length === 0) p.error(where, '"columns" must be an array of header labels')
  else if (columns.length > LIMITS.tableCols) p.error(where, `${columns.length} columns; ${LIMITS.tableCols} at most`)
  const rows = Array.isArray(s.rows) ? s.rows : undefined
  if (rows === undefined || rows.length === 0) p.error(where, '"rows" must be an array of arrays')
  else {
    if (rows.length > LIMITS.tableRows) p.error(where, `${rows.length} rows; ${LIMITS.tableRows} at most — two slides`)
    rows.forEach((r, i) => {
      if (!Array.isArray(r)) p.error(`${where} rows[${i}]`, 'must be an array of cells')
      else if (columns && r.length !== columns.length) p.error(`${where} rows[${i}]`, `${r.length} cells for ${columns.length} columns`)
    })
  }
  const out = { columns, rows: rows ? rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [])) : [] }
  if (s.boldFirstColumn === true) out.boldFirstColumn = true
  if (Array.isArray(s.align)) out.align = s.align
  return out
}

/**
 * Validate and normalise a raw spec. Returns `{ spec, errors, warnings }`; `spec` is complete
 * only when `errors` is empty. `specPath` anchors relative image paths.
 */
function normalize(raw, specPath) {
  const p = new Problems()
  const specDir = specPath ? path.dirname(path.resolve(specPath)) : process.cwd()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    p.error('spec', 'the file must hold one JSON object: { "title", "theme", "slides": [...] }')
    return { spec: undefined, errors: p.errors, warnings: p.warnings }
  }
  const spec = {}
  spec.title = str(p, 'deck', raw, 'title', { required: true, max: 120 }) ?? ''
  spec.subtitle = str(p, 'deck', raw, 'subtitle', { max: 200 })
  spec.author = str(p, 'deck', raw, 'author')
  spec.organization = str(p, 'deck', raw, 'organization')
  spec.date = str(p, 'deck', raw, 'date')
  spec.footer = raw.footer === undefined ? undefined : String(raw.footer)
  const theme = raw.theme === undefined ? 'midnight' : String(raw.theme).trim().toLowerCase()
  if (THEMES[theme] === undefined) p.error('deck', `theme "${theme}"; one of ${Object.keys(THEMES).join(', ')}`)
  spec.theme = theme
  spec.font = {}
  if (raw.font && typeof raw.font === 'object') {
    if (nonEmpty(raw.font.head)) spec.font.head = raw.font.head.trim()
    if (nonEmpty(raw.font.body)) spec.font.body = raw.font.body.trim()
  }
  if (nonEmpty(raw.accent)) {
    const hex = raw.accent.trim().replace(/^#/, '').toUpperCase()
    if (/^[0-9A-F]{6}$/.test(hex)) spec.font.accent = hex
    else p.error('deck', `accent "${raw.accent}" is not a six-digit hex colour`)
  }

  if (!Array.isArray(raw.slides) || raw.slides.length === 0) {
    p.error('deck', '"slides" must be a non-empty array')
    return { spec: undefined, errors: p.errors, warnings: p.warnings }
  }
  spec.slides = []
  const typeCounts = {}
  raw.slides.forEach((s, i) => {
    const where = `slides[${i}]`
    if (!s || typeof s !== 'object') { p.error(where, 'must be an object with a "type"'); return }
    const type = isStr(s.type) ? s.type.trim().toLowerCase() : undefined
    if (type === undefined || !TYPES.includes(type)) {
      p.error(where, `type "${s.type}"; one of ${TYPES.join(', ')}`)
      return
    }
    typeCounts[type] = (typeCounts[type] ?? 0) + 1
    const out = { type }
    const w = `${where} (${type}${nonEmpty(s.title) ? ` "${s.title.trim().slice(0, 40)}"` : ''})`
    out.notes = str(p, w, s, 'notes')
    out.callout = str(p, w, s, 'callout', { max: 170 })
    if (['title', 'section', 'quote', 'closing'].includes(type) && out.callout) {
      p.warn(w, 'a callout is not shown on this slide type')
      out.callout = undefined
    }
    switch (type) {
      case 'title':
        out.title = str(p, w, s, 'title', { required: true, max: 110 }) ?? spec.title
        out.subtitle = str(p, w, s, 'subtitle', { max: 220 }) ?? (i === 0 ? spec.subtitle : undefined)
        out.kicker = str(p, w, s, 'kicker', { max: 60 })
        out.author = str(p, w, s, 'author') ?? spec.author
        out.organization = str(p, w, s, 'organization') ?? spec.organization
        out.date = str(p, w, s, 'date') ?? spec.date
        break
      case 'section':
        out.title = str(p, w, s, 'title', { required: true, max: 80 })
        out.text = str(p, w, s, 'text', { max: 240 })
        if (s.number !== undefined) out.number = Number(s.number)
        break
      case 'bullets':
        out.title = str(p, w, s, 'title', { required: true, max: LIMITS.titleChars })
        out.subtitle = str(p, w, s, 'subtitle', { max: 140 })
        out.bullets = bulletList(p, w, s.bullets, 'bullets', { required: true }) ?? []
        out.image = resolveImage(p, w, s.image, specDir)
        out.caption = str(p, w, s, 'caption', { max: 120 })
        out.stats = s.stats === undefined ? undefined : stats(p, w, s.stats)
        if (out.image && out.stats) { p.warn(w, 'both an image and stats: only the image is shown'); out.stats = undefined }
        break
      case 'text':
        out.title = str(p, w, s, 'title', { required: true, max: LIMITS.titleChars })
        out.subtitle = str(p, w, s, 'subtitle', { max: 140 })
        out.text = str(p, w, s, 'text', { required: true, max: 700 })
        break
      case 'columns': {
        out.title = str(p, w, s, 'title', { required: true, max: LIMITS.titleChars })
        out.subtitle = str(p, w, s, 'subtitle', { max: 140 })
        const cols = Array.isArray(s.columns) ? s.columns : undefined
        const [lo, hi] = LIMITS.columns
        if (cols === undefined || cols.length < lo || cols.length > hi) p.error(w, `"columns" must hold ${lo} or ${hi} entries of { "heading", "bullets" | "text" }`)
        out.columns = (cols ?? []).map((c, j) => {
          const cw = `${w} columns[${j}]`
          if (!c || typeof c !== 'object') { p.error(cw, 'must be { "heading", "bullets" | "text" }'); return { heading: '', bullets: [] } }
          const col = { heading: str(p, cw, c, 'heading', { max: 50 }) }
          if (c.bullets !== undefined) col.bullets = bulletList(p, cw, c.bullets) ?? []
          else col.text = str(p, cw, c, 'text', { max: 500 })
          if ((col.bullets === undefined || col.bullets.length === 0) && !col.text) p.error(cw, 'needs "bullets" or "text"')
          return col
        })
        break
      }
      case 'cards': {
        out.title = str(p, w, s, 'title', { required: true, max: LIMITS.titleChars })
        out.subtitle = str(p, w, s, 'subtitle', { max: 140 })
        const cards = Array.isArray(s.cards) ? s.cards : undefined
        const [lo, hi] = LIMITS.cards
        if (cards === undefined || cards.length < lo || cards.length > hi) p.error(w, `"cards" must hold ${lo}–${hi} entries of { "heading", "text", "icon"? }`)
        out.cards = (cards ?? []).map((c, j) => {
          const cw = `${w} cards[${j}]`
          if (!c || typeof c !== 'object') { p.error(cw, 'must be { "heading", "text" }'); return { heading: '' } }
          const card = { heading: str(p, cw, c, 'heading', { required: true, max: 48 }) ?? '', text: str(p, cw, c, 'text', { max: 260 }) }
          if (nonEmpty(c.icon)) {
            const glyph = [...c.icon.trim()]
            if (glyph.length > 2) p.warn(cw, `icon "${c.icon}" is more than one character; a single glyph like ✓ ★ → ⚡ fits the badge`)
            card.icon = glyph.slice(0, 2).join('')
          }
          if (c.number !== undefined) card.number = String(c.number)
          return card
        })
        break
      }
      case 'stats':
        out.title = str(p, w, s, 'title', { required: true, max: LIMITS.titleChars })
        out.subtitle = str(p, w, s, 'subtitle', { max: 140 })
        out.stats = stats(p, w, s.stats, { required: true }) ?? []
        out.text = str(p, w, s, 'text', { max: 420 })
        break
      case 'image':
        out.title = str(p, w, s, 'title', { required: true, max: LIMITS.titleChars })
        out.subtitle = str(p, w, s, 'subtitle', { max: 140 })
        out.image = resolveImage(p, w, s.image ?? '', specDir)
        if (s.image === undefined) p.error(w, '"image" is required — a path relative to the spec file')
        out.caption = str(p, w, s, 'caption', { max: 140 })
        if (s.bullets !== undefined) out.bullets = bulletList(p, w, s.bullets) ?? []
        out.text = str(p, w, s, 'text', { max: 500 })
        if (s.imageSide !== undefined) {
          if (s.imageSide === 'left' || s.imageSide === 'right') out.imageSide = s.imageSide
          else p.error(w, '"imageSide" is "left" or "right"')
        }
        break
      case 'chart':
        out.title = str(p, w, s, 'title', { required: true, max: LIMITS.titleChars })
        out.subtitle = str(p, w, s, 'subtitle', { max: 140 })
        out.chart = chart(p, w, s.chart)
        out.insight = str(p, w, s, 'insight', { max: 320 })
        break
      case 'table':
        out.title = str(p, w, s, 'title', { required: true, max: LIMITS.titleChars })
        out.subtitle = str(p, w, s, 'subtitle', { max: 140 })
        Object.assign(out, tableSpec(p, w, s))
        break
      case 'timeline': {
        out.title = str(p, w, s, 'title', { required: true, max: LIMITS.titleChars })
        out.subtitle = str(p, w, s, 'subtitle', { max: 140 })
        const steps = Array.isArray(s.steps) ? s.steps : undefined
        const [lo, hi] = LIMITS.steps
        if (steps === undefined || steps.length < lo || steps.length > hi) p.error(w, `"steps" must hold ${lo}–${hi} entries of { "label", "text", "key"? }`)
        out.steps = (steps ?? []).map((st, j) => {
          const sw = `${w} steps[${j}]`
          if (!st || typeof st !== 'object') { p.error(sw, 'must be { "label": "2022", "text": "..." }'); return { label: '', text: '' } }
          return { label: str(p, sw, st, 'label', { required: true, max: 24 }) ?? '', text: str(p, sw, st, 'text', { required: true, max: 150 }) ?? '', key: st.key === true }
        })
        break
      }
      case 'quote':
        out.text = str(p, w, s, 'text', { required: true, max: LIMITS.quoteChars })
        out.attribution = str(p, w, s, 'attribution', { max: 90 })
        break
      case 'comparison': {
        out.title = str(p, w, s, 'title', { required: true, max: LIMITS.titleChars })
        out.subtitle = str(p, w, s, 'subtitle', { max: 140 })
        for (const side of ['left', 'right']) {
          const raw = s[side]
          const sw = `${w} ${side}`
          if (!raw || typeof raw !== 'object') { p.error(sw, `"${side}" must be { "heading", "bullets" | "text" }`); out[side] = { heading: '', bullets: [] }; continue }
          const o = { heading: str(p, sw, raw, 'heading', { required: true, max: 50 }) ?? '' }
          if (raw.bullets !== undefined) o.bullets = bulletList(p, sw, raw.bullets) ?? []
          else o.text = str(p, sw, raw, 'text', { max: 500 })
          if ((o.bullets === undefined || o.bullets.length === 0) && !o.text) p.error(sw, 'needs "bullets" or "text"')
          out[side] = o
        }
        out.versus = str(p, w, s, 'versus', { max: 6 })
        break
      }
      case 'closing':
        out.title = str(p, w, s, 'title', { required: true, max: 80 })
        out.text = str(p, w, s, 'text', { max: 260 })
        if (s.contacts !== undefined) {
          if (!Array.isArray(s.contacts)) p.error(w, '"contacts" must be an array of strings')
          else {
            out.contacts = s.contacts.filter(isStr).map((c) => c.trim()).filter((c) => c !== '')
            if (out.contacts.length > LIMITS.contacts) p.warn(w, `${out.contacts.length} contact lines; ${LIMITS.contacts} at most`)
          }
        }
        break
    }
    spec.slides.push(out)
  })

  // Shape of the whole deck, as warnings: these are the habits that make a deck dull.
  const n = spec.slides.length
  if (n > 0 && spec.slides[0].type !== 'title') p.warn('deck', 'the first slide is not a title slide')
  if (n >= 4 && (typeCounts.bullets ?? 0) > Math.ceil(n * 0.5)) p.warn('deck', `${typeCounts.bullets} of ${n} slides are bullet lists — swap some for cards, columns, stats, a chart or a timeline`)
  for (let i = 2; i < n; i += 1) {
    if (spec.slides[i].type === 'bullets' && spec.slides[i - 1].type === 'bullets' && spec.slides[i - 2].type === 'bullets') {
      p.warn(`slides[${i}]`, 'the third bullet slide in a row — vary the layout')
      break
    }
  }
  const noNotes = spec.slides.filter((s) => !s.notes && !['title', 'section', 'quote', 'closing'].includes(s.type)).length
  if (noNotes > 0 && noNotes === spec.slides.filter((s) => !['title', 'section', 'quote', 'closing'].includes(s.type)).length) {
    p.warn('deck', 'no slide has speaker notes; "notes" is where the spoken argument goes')
  }
  return { spec: p.errors.length === 0 ? spec : undefined, errors: p.errors, warnings: p.warnings }
}

module.exports = { normalize, LIMITS, TYPES, CHART_KINDS }
