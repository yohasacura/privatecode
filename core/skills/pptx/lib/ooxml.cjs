'use strict'
/**
 * Existing decks: read, replace text, keep/drop/reorder slides, validate the package.
 *
 * A .pptx is a zip of XML parts. Reading goes through a real XML parser; the two edits go
 * through the text of the parts instead — a `<a:t>` run's text, a `<p:sldId>` entry, a
 * `<Relationship>`, an `<Override>` — because round-tripping OOXML through a serializer is
 * how namespace prefixes get rewritten and a deck stops opening. Nothing here reflows a
 * slide: replaced text keeps the run's formatting, and a run that grows may wrap. `render`
 * is how that gets seen.
 */
const fs = require('node:fs')
const path = require('node:path')
const JSZip = require('jszip')
const { DOMParser } = require('@xmldom/xmldom')

const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'
const REL_NOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'
const REL_LAYOUT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout'

async function openZip(file) {
  if (!fs.existsSync(file)) throw new Error(`not found: ${file}`)
  return JSZip.loadAsync(fs.readFileSync(file))
}

async function partText(zip, name) {
  const f = zip.file(name)
  if (!f) throw new Error(`the package has no part ${name}`)
  return f.async('string')
}

/** Parse one XML part, turning parser errors into a thrown message that names the part. */
function parse(text, name) {
  const errors = []
  const doc = new DOMParser({
    onError: (level, msg) => { if (level === 'fatalError' || level === 'error') errors.push(`${level}: ${String(msg).split('\n')[0]}`) },
  }).parseFromString(text, 'application/xml')
  if (errors.length > 0) throw new Error(`${name}: ${errors[0]}`)
  return doc
}

/** `ppt/slides/slide1.xml` + `../notesSlides/notesSlide1.xml` → `ppt/notesSlides/notesSlide1.xml`. */
function resolve(fromPart, target) {
  if (target.startsWith('/')) return target.slice(1)
  const base = path.posix.dirname(fromPart)
  return path.posix.normalize(path.posix.join(base, target))
}

function relsName(part) {
  const dir = path.posix.dirname(part)
  return `${dir === '.' ? '' : `${dir}/`}_rels/${path.posix.basename(part)}.rels`
}

async function readRels(zip, part) {
  const name = relsName(part)
  const f = zip.file(name)
  if (!f) return []
  const doc = parse(await f.async('string'), name)
  const out = []
  const rels = doc.getElementsByTagName('Relationship')
  for (let i = 0; i < rels.length; i += 1) {
    const r = rels[i]
    const mode = r.getAttribute('TargetMode') || 'Internal'
    out.push({ id: r.getAttribute('Id'), type: r.getAttribute('Type'), target: r.getAttribute('Target'), mode, resolved: mode === 'External' ? null : resolve(part, r.getAttribute('Target')) })
  }
  return out
}

/** The slide parts in presentation order. */
async function slideParts(zip) {
  const pres = parse(await partText(zip, 'ppt/presentation.xml'), 'ppt/presentation.xml')
  const rels = await readRels(zip, 'ppt/presentation.xml')
  const byId = new Map(rels.map((r) => [r.id, r]))
  const ids = pres.getElementsByTagNameNS(NS_P, 'sldId')
  const out = []
  for (let i = 0; i < ids.length; i += 1) {
    const rid = ids[i].getAttributeNS(NS_R, 'id')
    const rel = byId.get(rid)
    out.push({ rid, sldId: ids[i].getAttribute('id'), part: rel ? rel.resolved : null })
  }
  return out
}

function childrenNS(el, ns, local) {
  const out = []
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.namespaceURI === ns && n.localName === local) out.push(n)
  }
  return out
}

function firstNS(el, ns, local) {
  const list = el.getElementsByTagNameNS(ns, local)
  return list.length > 0 ? list[0] : null
}

/** The paragraphs of a text body: `{ level, text }` each, runs joined, line breaks kept. */
function paragraphsOf(txBody) {
  const out = []
  for (const p of childrenNS(txBody, NS_A, 'p')) {
    const pPr = childrenNS(p, NS_A, 'pPr')[0]
    const level = pPr ? Number(pPr.getAttribute('lvl') || 0) : 0
    let text = ''
    for (let n = p.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1 || n.namespaceURI !== NS_A) continue
      if (n.localName === 'r' || n.localName === 'fld') {
        const t = firstNS(n, NS_A, 't')
        if (t) text += t.textContent
      } else if (n.localName === 'br') text += '\n'
    }
    out.push({ level, text })
  }
  return out
}

function shapesOf(tree, into) {
  for (let n = tree.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1 || n.namespaceURI !== NS_P) continue
    if (n.localName === 'grpSp') { shapesOf(n, into); continue }
    if (n.localName === 'sp') {
      const cNvPr = firstNS(n, NS_P, 'cNvPr')
      const ph = firstNS(n, NS_P, 'ph')
      const txBody = childrenNS(n, NS_P, 'txBody')[0]
      const paragraphs = txBody ? paragraphsOf(txBody) : []
      if (paragraphs.some((p) => p.text.trim() !== '')) {
        // The largest run size in the box, in points: what tells a title from a caption in a
        // deck that uses no placeholders (every deck this tool writes, for one).
        let size = 0
        const rPr = txBody.getElementsByTagNameNS(NS_A, 'rPr')
        for (let i = 0; i < rPr.length; i += 1) {
          const sz = Number(rPr[i].getAttribute('sz') || 0) / 100
          if (sz > size) size = sz
        }
        // Where the box sits, in inches from the top: titles are the topmost large text.
        const spPr = childrenNS(n, NS_P, 'spPr')[0]
        const off = spPr ? firstNS(spPr, NS_A, 'off') : null
        const y = off ? Number(off.getAttribute('y') || 0) / 914400 : null
        into.texts.push({ name: cNvPr ? cNvPr.getAttribute('name') : '', placeholder: ph ? (ph.getAttribute('type') || 'body') : null, size, y, paragraphs })
      }
    } else if (n.localName === 'graphicFrame') {
      const cNvPr = firstNS(n, NS_P, 'cNvPr')
      const tbl = firstNS(n, NS_A, 'tbl')
      if (tbl) {
        const rows = []
        for (const tr of childrenNS(tbl, NS_A, 'tr')) {
          rows.push(childrenNS(tr, NS_A, 'tc').map((tc) => {
            const body = childrenNS(tc, NS_A, 'txBody')[0]
            return body ? paragraphsOf(body).map((p) => p.text).join(' ').trim() : ''
          }))
        }
        into.tables.push({ name: cNvPr ? cNvPr.getAttribute('name') : '', rows })
      } else if (firstNS(n, NS_C, 'chart')) {
        into.charts.push(cNvPr ? cNvPr.getAttribute('name') : 'chart')
      } else {
        into.others.push(cNvPr ? cNvPr.getAttribute('name') : 'graphic')
      }
    } else if (n.localName === 'pic') {
      const cNvPr = firstNS(n, NS_P, 'cNvPr')
      into.pictures.push({ name: cNvPr ? cNvPr.getAttribute('name') : 'picture', descr: cNvPr ? (cNvPr.getAttribute('descr') || '') : '' })
    }
  }
}

/** Every slide as structured content. */
async function outline(file) {
  const zip = await openZip(file)
  const slides = await slideParts(zip)
  const out = []
  for (let i = 0; i < slides.length; i += 1) {
    const s = slides[i]
    const entry = { n: i + 1, part: s.part, title: '', texts: [], tables: [], charts: [], pictures: [], others: [], notes: '' }
    if (!s.part || !zip.file(s.part)) { entry.title = '(missing slide part)'; out.push(entry); continue }
    const doc = parse(await partText(zip, s.part), s.part)
    const tree = firstNS(doc, NS_P, 'spTree')
    if (tree) shapesOf(tree, entry)
    // A title placeholder when the deck has one; otherwise the largest text that is words —
    // not a section number, not a quotation mark — which is how a reader finds it too.
    const wordy = entry.texts.filter((t) => { const s = t.paragraphs.map((p) => p.text).join(' ').trim(); return s.length >= 3 && /[\p{L}]/u.test(s) })
    const large = wordy.filter((t) => t.size >= 18)
    const titled = entry.texts.find((t) => t.placeholder === 'title' || t.placeholder === 'ctrTitle')
      ?? (large.length > 0
        ? large.reduce((best, t) => (best === null || (t.y ?? 99) < (best.y ?? 99) - 0.01 || (Math.abs((t.y ?? 99) - (best.y ?? 99)) <= 0.01 && t.size > best.size) ? t : best), null)
        : wordy.reduce((best, t) => (best === null || t.size > best.size ? t : best), null))
    entry.title = (titled ?? entry.texts[0])?.paragraphs.map((p) => p.text).join(' ').trim() ?? ''
    const rels = await readRels(zip, s.part)
    const notes = rels.find((r) => r.type === REL_NOTES)
    if (notes && zip.file(notes.resolved)) {
      const nd = parse(await partText(zip, notes.resolved), notes.resolved)
      const body = { texts: [], tables: [], charts: [], pictures: [], others: [] }
      const ntree = firstNS(nd, NS_P, 'spTree')
      if (ntree) shapesOf(ntree, body)
      entry.notes = body.texts.filter((t) => t.placeholder === 'body').flatMap((t) => t.paragraphs.map((p) => p.text)).join('\n').trim()
    }
    out.push(entry)
  }
  return out
}

function formatOutline(slides) {
  const lines = []
  for (const s of slides) {
    lines.push(`Slide ${s.n} — ${s.title || '(no title)'}`)
    for (const t of s.texts) {
      if (t.placeholder === 'title' || t.placeholder === 'ctrTitle') continue
      if (t.placeholder === 'sldNum' || t.placeholder === 'ftr' || t.placeholder === 'dt') continue
      const label = t.placeholder ? t.placeholder : t.name
      const paras = t.paragraphs.filter((p) => p.text.trim() !== '')
      if (paras.length === 1) lines.push(`  [${label}] ${paras[0].text.replace(/\n/g, ' / ')}`)
      else {
        lines.push(`  [${label}]`)
        for (const p of paras) lines.push(`    ${'  '.repeat(p.level)}- ${p.text.replace(/\n/g, ' / ')}`)
      }
    }
    for (const tb of s.tables) {
      lines.push(`  [table ${tb.rows.length}×${tb.rows[0]?.length ?? 0}]`)
      for (const r of tb.rows) lines.push(`    | ${r.join(' | ')} |`)
    }
    for (const c of s.charts) lines.push(`  [chart] ${c}`)
    for (const p of s.pictures) lines.push(`  [picture] ${p.name}${p.descr ? ` — ${p.descr}` : ''}`)
    if (s.notes) lines.push(`  [notes] ${s.notes.replace(/\n/g, ' / ')}`)
    lines.push('')
  }
  return lines.join('\n')
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&')
const encode = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function textParts(zip) {
  const slides = await slideParts(zip)
  const names = []
  for (const s of slides) {
    if (!s.part || !zip.file(s.part)) continue
    names.push(s.part)
    const rels = await readRels(zip, s.part)
    for (const r of rels) if (r.type === REL_NOTES && zip.file(r.resolved)) names.push(r.resolved)
  }
  return names
}

/**
 * Replace text in every run of every slide and notes page. Each pair is `[from, to]`;
 * the count per pair says how many runs changed — zero means the phrase is split across
 * differently formatted runs, and the outline is where to look for the pieces.
 */
async function replace(inFile, outFile, pairs) {
  const zip = await openZip(inFile)
  const counts = pairs.map(() => 0)
  for (const name of await textParts(zip)) {
    let xml = await partText(zip, name)
    let changed = false
    xml = xml.replace(/(<a:t(?:\s[^>]*)?>)([^<]*)(<\/a:t>)/g, (m, open, body, close) => {
      let text = decode(body)
      pairs.forEach(([from, to], i) => {
        if (from === '' || !text.includes(from)) return
        counts[i] += text.split(from).length - 1
        text = text.split(from).join(to)
        changed = true
      })
      const needsSpace = /^\s|\s$/.test(text) && !/xml:space="preserve"/.test(open)
      return `${needsSpace ? open.replace(/^<a:t/, '<a:t xml:space="preserve"') : open}${encode(text)}${close}`
    })
    if (changed) zip.file(name, xml)
  }
  await writeZip(zip, outFile)
  return counts
}

async function writeZip(zip, outFile) {
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  fs.writeFileSync(outFile, buf)
}

/** "1,3-5,8" → [1,3,4,5,8]; validated against the slide count. */
function parseRange(text, count) {
  const out = []
  for (const piece of String(text).split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(piece)
    if (!m) throw new Error(`"${piece}" is not a slide number or a range like 3-5`)
    const a = Number(m[1])
    const b = m[2] !== undefined ? Number(m[2]) : a
    if (a < 1 || b > count || a > b) throw new Error(`"${piece}" is outside 1–${count}`)
    for (let i = a; i <= b; i += 1) out.push(i)
  }
  return out
}

/**
 * Keep, drop or reorder slides. `order` is the new sequence of current slide numbers; slides
 * not named are removed along with their notes pages, relationships and content-type entries.
 */
async function reorder(inFile, outFile, order) {
  const zip = await openZip(inFile)
  const slides = await slideParts(zip)
  const seen = new Set()
  for (const n of order) {
    if (seen.has(n)) throw new Error(`slide ${n} is listed twice`)
    seen.add(n)
  }
  const keep = order.map((n) => slides[n - 1])
  const dropped = slides.filter((_, i) => !seen.has(i + 1))

  let pres = await partText(zip, 'ppt/presentation.xml')
  const lst = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(pres)
  if (!lst) throw new Error('ppt/presentation.xml has no <p:sldIdLst>')
  const entries = new Map()
  for (const m of lst[1].matchAll(/<p:sldId\b[^>]*\/>/g)) {
    const rid = /r:id="([^"]+)"/.exec(m[0])
    if (rid) entries.set(rid[1], m[0])
  }
  const rebuilt = keep.map((s) => entries.get(s.rid)).filter(Boolean).join('')
  pres = pres.replace(lst[0], `<p:sldIdLst>${rebuilt}</p:sldIdLst>`)
  zip.file('ppt/presentation.xml', pres)

  const removedParts = []
  for (const s of dropped) {
    if (!s.part) continue
    removedParts.push(s.part)
    const rels = await readRels(zip, s.part)
    for (const r of rels) if (r.type === REL_NOTES && r.resolved) removedParts.push(r.resolved)
  }
  // Presentation relationships to the dropped slides.
  const presRelsName = relsName('ppt/presentation.xml')
  let presRels = await partText(zip, presRelsName)
  for (const s of dropped) {
    presRels = presRels.replace(new RegExp(`<Relationship\\b[^>]*\\bId="${s.rid}"[^>]*/>`), '')
  }
  zip.file(presRelsName, presRels)
  // The parts themselves, their own rels, and their content-type overrides.
  let ct = await partText(zip, '[Content_Types].xml')
  for (const part of removedParts) {
    zip.remove(part)
    const rn = relsName(part)
    if (zip.file(rn)) zip.remove(rn)
    ct = ct.replace(new RegExp(`<Override\\b[^>]*PartName="/${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`), '')
  }
  zip.file('[Content_Types].xml', ct)
  await writeZip(zip, outFile)
  return { kept: keep.length, removed: dropped.length }
}

/**
 * Package-level checks, each naming what to fix: every XML part parses, every internal
 * relationship resolves, every part has a content type, every slide in the list exists and
 * has one layout, and every chart declares the axes it references (the fault PowerPoint
 * reports as "needs repair" and discards the chart for).
 */
async function validate(file) {
  const problems = []
  const zip = await openZip(file)
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  const required = ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml']
  for (const r of required) if (!zip.file(r)) problems.push(`missing part ${r} — this is not a .pptx package`)
  if (problems.length > 0) return { ok: false, problems, slides: 0, parts: names.length }

  // 1. Every XML part is well-formed.
  const docs = new Map()
  for (const n of names) {
    if (!/\.(xml|rels)$/i.test(n)) continue
    try { docs.set(n, parse(await partText(zip, n), n)) } catch (e) { problems.push(`${e.message} — fix the XML of that part`) }
  }
  // 2. Content types cover every part.
  const ct = docs.get('[Content_Types].xml')
  if (ct) {
    const defaults = new Set()
    const overrides = new Set()
    const d = ct.getElementsByTagName('Default')
    for (let i = 0; i < d.length; i += 1) defaults.add(String(d[i].getAttribute('Extension')).toLowerCase())
    const o = ct.getElementsByTagName('Override')
    for (let i = 0; i < o.length; i += 1) overrides.add(o[i].getAttribute('PartName'))
    for (const n of names) {
      if (n === '[Content_Types].xml') continue
      // `.rels` is a dot-file to path.extname; the extension is the whole name after the dot.
      const base = path.posix.basename(n)
      const ext = (base.startsWith('.') ? base.slice(1) : path.posix.extname(base).slice(1)).toLowerCase()
      if (!overrides.has(`/${n}`) && !defaults.has(ext)) problems.push(`${n} has no content type — add an <Override> for it in [Content_Types].xml`)
    }
    // An <Override> for a part that does not exist is tolerated by PowerPoint (pptxgenjs
    // writes one slideMaster override per slide, against a single master), so it is not
    // reported: a check that fails every deck this tool writes would teach nothing.
  }
  // 3. Every internal relationship resolves.
  for (const n of names) {
    if (!n.endsWith('.rels')) continue
    const dir = path.posix.dirname(path.posix.dirname(n))
    const source = `${dir === '.' ? '' : `${dir}/`}${path.posix.basename(n, '.rels')}`
    const rels = await readRels(zip, source === '_rels/' ? '' : source)
    for (const r of rels) {
      if (r.mode === 'External' || !r.resolved) continue
      if (!zip.file(r.resolved)) problems.push(`${n}: ${r.id} → ${r.target} does not exist — remove the relationship or restore the part`)
    }
  }
  // 4. Slides: listed, present, one layout each, notes resolve.
  let slides = []
  try { slides = await slideParts(zip) } catch (e) { problems.push(e.message) }
  for (const s of slides) {
    if (!s.part) { problems.push(`presentation.xml lists ${s.rid}, which has no relationship — remove the <p:sldId> or add the rel`); continue }
    if (!zip.file(s.part)) { problems.push(`${s.part} is listed but missing`); continue }
    const rels = await readRels(zip, s.part)
    const layouts = rels.filter((r) => r.type === REL_LAYOUT)
    if (layouts.length !== 1) problems.push(`${s.part}: ${layouts.length} slideLayout relationships; exactly one is needed`)
    const notes = rels.filter((r) => r.type === REL_NOTES)
    if (notes.length > 1) problems.push(`${s.part}: ${notes.length} notes pages; at most one`)
  }
  // 5. Charts declare their axes, and stacked bars keep labels inside.
  for (const n of names) {
    if (!/^ppt\/charts\/chart\d+\.xml$/.test(n) || !docs.has(n)) continue
    const doc = docs.get(n)
    const declared = new Set()
    for (const kind of ['valAx', 'catAx', 'dateAx', 'serAx']) {
      const axes = doc.getElementsByTagNameNS(NS_C, kind)
      for (let i = 0; i < axes.length; i += 1) {
        const id = firstNS(axes[i], NS_C, 'axId')
        if (id) declared.add(id.getAttribute('val'))
      }
    }
    // Each chart block (barChart, lineChart, …) must reference at least two declared axes.
    // pptxgenjs writes a third, undeclared series-axis id on every bar chart and PowerPoint
    // ignores it, so a stray id is not the fault; a block whose axes are ALL undeclared is —
    // that is what a combo chart with a secondary axis but no `valAxes`/`catAxes` produces,
    // and PowerPoint discards the chart for it.
    const plotArea = firstNS(doc, NS_C, 'plotArea')
    if (plotArea) {
      for (let b = plotArea.firstChild; b; b = b.nextSibling) {
        if (b.nodeType !== 1 || !/Chart$/.test(b.localName) || b.localName === 'pieChart' || b.localName === 'doughnutChart' || b.localName === 'ofPieChart') continue
        const refs = childrenNS(b, NS_C, 'axId').map((r) => r.getAttribute('val'))
        if (refs.length > 0 && refs.filter((v) => declared.has(v)).length < 2) {
          problems.push(`${n}: <c:${b.localName}> references axes ${refs.join(', ')}, of which ${refs.filter((v) => declared.has(v)).length} are declared — PowerPoint discards this chart; declare both axes (valAxes and catAxes) or drop the secondary axis`)
        }
      }
    }
    const grouping = doc.getElementsByTagNameNS(NS_C, 'grouping')
    for (let i = 0; i < grouping.length; i += 1) {
      const g = grouping[i].getAttribute('val')
      if (g === 'stacked' || g === 'percentStacked') {
        const pos = grouping[i].parentNode.getElementsByTagNameNS(NS_C, 'dLblPos')
        for (let j = 0; j < pos.length; j += 1) {
          if (pos[j].getAttribute('val') === 'outEnd') problems.push(`${n}: a stacked chart has data labels at outEnd — PowerPoint refuses it; use ctr, inEnd or inBase`)
        }
      }
    }
  }
  const unique = [...new Set(problems)]
  return { ok: unique.length === 0, problems: unique, slides: slides.length, parts: names.length }
}

module.exports = { outline, formatOutline, replace, reorder, parseRange, validate, slideParts }
