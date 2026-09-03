'use strict'
/**
 * Text measurement without a renderer.
 *
 * PowerPoint lays the text out on the reader's machine, so nothing here can be exact. It is a
 * per-character advance-width model, calibrated against Calibri and Cambria renders of Latin
 * and Cyrillic text, and biased a little wide on purpose: "fits here" must mean "fits there",
 * and a line that wraps one word early is invisible while a line that overflows its box is
 * the most common defect a generated deck has.
 */

const NARROW_LATIN = new Set('ijlt')
const THIN_LATIN = new Set('fr')
const WIDE_LATIN = new Set('mw')
const NARROW_CAPS = new Set('IJ')
const WIDE_CAPS = new Set('MW')
const WIDE_CYR = new Set('шщжмюфыдц')
const WIDE_CYR_CAPS = new Set('ШЩЖМЮФЫДЦ')

/** Advance width of one character as a fraction of the font size. */
function advance(ch) {
  const c = ch.codePointAt(0)
  if (ch === ' ' || ch === ' ') return 0.24
  if (c >= 0x30 && c <= 0x39) return 0.51
  if (c >= 0x41 && c <= 0x5a) return NARROW_CAPS.has(ch) ? 0.30 : WIDE_CAPS.has(ch) ? 0.88 : 0.63
  if (c >= 0x61 && c <= 0x7a) return NARROW_LATIN.has(ch) ? 0.27 : THIN_LATIN.has(ch) ? 0.34 : WIDE_LATIN.has(ch) ? 0.80 : 0.51
  if (c >= 0x0410 && c <= 0x042f) return WIDE_CYR_CAPS.has(ch) ? 0.90 : 0.68
  if (c >= 0x0430 && c <= 0x044f) return WIDE_CYR.has(ch) ? 0.76 : 0.55
  if (c === 0x0401 || c === 0x0404 || c === 0x0406 || c === 0x0407) return 0.65
  if (c === 0x0451 || c === 0x0454 || c === 0x0456 || c === 0x0457) return 0.45
  if ('.,:;!|\'`'.includes(ch)) return 0.27
  if ('"“”«»'.includes(ch)) return 0.42
  if ('-()[]{}/'.includes(ch)) return 0.36
  if (ch === '–') return 0.51
  if (ch === '—') return 1.0
  if (ch === '%') return 0.78
  if ('+=<>~^*&#$€£₴'.includes(ch)) return 0.58
  if (c >= 0x2e80) return 1.05 // CJK, emoji and other wide symbols
  if (c >= 0x2000) return 0.7 // arrows, bullets, misc symbols
  return 0.6
}

/** Width of one line of text, in points. */
function widthPt(text, size, { bold = false, serif = false } = {}) {
  let w = 0
  for (const ch of String(text)) w += advance(ch)
  return w * size * (bold ? 1.05 : 1) * (serif ? 1.04 : 1)
}

/**
 * How many lines `text` takes when wrapped to `widthPt` — greedy word wrap, a word longer than
 * the line taking as many lines as it needs. Never fewer than one.
 */
function lineCount(text, boxWidthPt, size, style) {
  const words = String(text).split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return 1
  const space = widthPt(' ', size, style)
  let lines = 1
  let used = 0
  for (const word of words) {
    const w = widthPt(word, size, style)
    if (used === 0) {
      if (w > boxWidthPt) { lines += Math.ceil(w / boxWidthPt) - 1; used = w % boxWidthPt } else used = w
      continue
    }
    if (used + space + w <= boxWidthPt) {
      used += space + w
    } else {
      lines += 1
      if (w > boxWidthPt) { lines += Math.ceil(w / boxWidthPt) - 1; used = w % boxWidthPt } else used = w
    }
  }
  return lines
}

/**
 * Height of a block of paragraphs at one size, in inches. A paragraph is
 * `{ text, level?, bold? }`; each level indents and drops the size a little, the way the
 * bullet layouts render it. `paraGapPt` is the space after every paragraph but the last.
 */
function blockHeightIn(paragraphs, boxWidthIn, size, opts = {}) {
  const lineSpacing = opts.lineSpacing ?? 1.12
  const paraGapPt = opts.paraGapPt ?? size * 0.45
  const indentIn = opts.indentIn ?? 0.28
  const levelDrop = opts.levelDrop ?? 2
  const style = { bold: opts.bold ?? false, serif: opts.serif ?? false }
  let total = 0
  paragraphs.forEach((p, i) => {
    const level = p.level ?? 0
    const s = Math.max(6, size - level * levelDrop)
    const width = (boxWidthIn - indentIn * (level + (opts.bulleted ? 1 : 0))) * 72
    const lines = lineCount(p.text, width, s, { bold: p.bold ?? style.bold, serif: style.serif })
    total += lines * s * 1.2 * lineSpacing
    if (i < paragraphs.length - 1) total += paraGapPt
  })
  return total / 72
}

/**
 * The largest size in [min, max] at which the block fits the box, stepping down by `step`.
 * `fits` is false when even `min` overflows; the caller decides whether that is an error.
 */
function fitBlock(paragraphs, boxWidthIn, boxHeightIn, { max, min, step = 0.5, ...opts } = {}) {
  let size = max
  let height = blockHeightIn(paragraphs, boxWidthIn, size, opts)
  while (height > boxHeightIn && size - step >= min) {
    size -= step
    height = blockHeightIn(paragraphs, boxWidthIn, size, opts)
  }
  return { size, heightIn: height, fits: height <= boxHeightIn, fill: boxHeightIn > 0 ? height / boxHeightIn : 1 }
}

/** The largest size in [min, max] at which `text` stays on ONE line of `boxWidthIn`. */
function fitLine(text, boxWidthIn, { max, min, step = 1, bold = false, serif = false } = {}) {
  let size = max
  while (size - step >= min && widthPt(text, size, { bold, serif }) > boxWidthIn * 72) size -= step
  return { size, fits: widthPt(text, size, { bold, serif }) <= boxWidthIn * 72 }
}

/** A single paragraph's height at a size, in inches (title bands, captions, callouts). */
function lineHeightIn(text, boxWidthIn, size, { lineSpacing = 1.1, bold = false, serif = false } = {}) {
  const lines = lineCount(text, boxWidthIn * 72, size, { bold, serif })
  return { lines, heightIn: (lines * size * 1.2 * lineSpacing) / 72 }
}

module.exports = { widthPt, lineCount, blockHeightIn, fitBlock, fitLine, lineHeightIn }
