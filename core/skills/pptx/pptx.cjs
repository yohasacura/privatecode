#!/usr/bin/env node
'use strict'
/**
 * PrivateCode's PowerPoint tool — one command for the whole job.
 *
 *   node pptx.cjs check    spec.json                  validate a deck spec and show the layout plan
 *   node pptx.cjs build    spec.json out.pptx [--force]   build the deck (refuses on fit errors)
 *   node pptx.cjs render   deck.pptx [-o dir] [--width 1600] [--pdf] [--grid] [--prefix slide]
 *   node pptx.cjs outline  deck.pptx [--json]         what an existing deck says, slide by slide
 *   node pptx.cjs replace  in.pptx out.pptx "old=>new" ["old2=>new2" ...]
 *   node pptx.cjs slides   in.pptx out.pptx --keep 1,3-5 | --drop 2,4 | --order 3,1,2
 *   node pptx.cjs validate deck.pptx                  package checks, each naming its fix
 *   node pptx.cjs themes                              the palettes
 *   node pptx.cjs example  [out.json]                 the sample spec, every slide type
 *
 * Exit codes: 0 fine; 1 the file or spec has problems (listed); 2 usage, or nothing on this
 * machine can do it (no PowerPoint to render with).
 *
 * The heavy lifting is in lib/: spec.cjs validates, theme.cjs + draw.cjs + layouts.cjs draw,
 * ooxml.cjs reads and edits existing files, render.cjs drives render.ps1.
 */
const fs = require('node:fs')
const path = require('node:path')

const SKILL_DIR = __dirname

const USAGE = `PrivateCode's PowerPoint tool

  node pptx.cjs check    spec.json                     validate a deck spec and show the layout plan
  node pptx.cjs build    spec.json out.pptx [--force]  build the deck (refuses on fit errors)
  node pptx.cjs render   deck.pptx [-o dir] [--width 1600] [--pdf] [--grid] [--prefix slide]
  node pptx.cjs outline  deck.pptx [--json]            what an existing deck says, slide by slide
  node pptx.cjs replace  in.pptx out.pptx "old=>new" ["old2=>new2" ...]
  node pptx.cjs slides   in.pptx out.pptx --keep 1,3-5 | --drop 2,4 | --order 3,1,2
  node pptx.cjs validate deck.pptx                     package checks, each naming its fix
  node pptx.cjs themes                                 the palettes
  node pptx.cjs example  [out.json]                    the sample spec, every slide type

Exit codes: 0 fine; 1 the file or spec has problems (listed); 2 usage, or nothing on this
machine can do it (no PowerPoint to render with).
`

function usage(code = 2) {
  process.stderr.write(USAGE)
  process.exit(code)
}

function flag(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

function option(args, name, fallback) {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  const v = args[i + 1]
  if (v === undefined) { process.stderr.write(`${name} needs a value\n`); process.exit(2) }
  args.splice(i, 2)
  return v
}

function readSpec(file) {
  if (!fs.existsSync(file)) { process.stderr.write(`spec not found: ${file}\n`); process.exit(2) }
  let raw
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch (e) {
    process.stderr.write(`${file} is not valid JSON: ${e.message}\n`)
    process.exit(1)
  }
  return raw
}

function kb(file) { return `${Math.round(fs.statSync(file).size / 1024)} KB` }

function printPlan(spec, reports, problems) {
  const { THEMES } = require('./lib/theme.cjs')
  const lines = []
  lines.push(`Deck "${spec.title}" — theme ${spec.theme} (${THEMES[spec.theme].label}), ${spec.slides.length} slides`)
  for (const r of reports) {
    const title = (r.title || '').replace(/\s+/g, ' ')
    lines.push(`${String(r.n).padStart(3)}  ${r.type.padEnd(10)} ${JSON.stringify(title.length > 44 ? `${title.slice(0, 42)}…` : title).padEnd(48)} ${r.layout}`)
    if (r.fit.length > 0) lines.push(`     fit: ${r.fit.join('; ')}`)
    for (const w of r.warnings) lines.push(`     ! ${w}`)
    for (const e of r.errors) lines.push(`     ✖ ${e}`)
  }
  if (problems.warnings.length > 0) {
    lines.push('')
    lines.push(`Warnings (${problems.warnings.length}):`)
    for (const w of problems.warnings) lines.push(`  ! ${w}`)
  }
  return lines.join('\n')
}

/** Validate + lay out (into a throwaway presentation) so `check` reports exactly what `build` would. */
function plan(specFile) {
  const { normalize } = require('./lib/spec.cjs')
  const raw = readSpec(specFile)
  const norm = normalize(raw, specFile)
  if (norm.spec === undefined) {
    process.stdout.write(`The spec has ${norm.errors.length} error${norm.errors.length > 1 ? 's' : ''}:\n`)
    for (const e of norm.errors) process.stdout.write(`  ✖ ${e}\n`)
    for (const w of norm.warnings) process.stdout.write(`  ! ${w}\n`)
    process.exit(1)
  }
  const pptxgen = require('pptxgenjs')
  const { resolveTheme } = require('./lib/theme.cjs')
  const layouts = require('./lib/layouts.cjs')
  const T = resolveTheme(norm.spec.theme, norm.spec.font)
  const pres = new pptxgen()
  pres.layout = 'LAYOUT_WIDE'
  pres.title = norm.spec.title
  if (norm.spec.author) pres.author = norm.spec.author
  if (norm.spec.organization) pres.company = norm.spec.organization
  const reports = layouts.build(pres, T, norm.spec)
  const fitErrors = reports.flatMap((r) => r.errors.map((e) => `slides[${r.n - 1}] (${r.type} "${(r.title || '').slice(0, 40)}"): ${e}`))
  return { spec: norm.spec, pres, reports, problems: norm, fitErrors }
}

async function cmdCheck(args) {
  const [specFile] = args
  if (!specFile) usage()
  const p = plan(specFile)
  process.stdout.write(`${printPlan(p.spec, p.reports, p.problems)}\n`)
  if (p.fitErrors.length > 0) {
    process.stdout.write(`\n${p.fitErrors.length} slide${p.fitErrors.length > 1 ? 's do' : ' does'} not fit — fix the spec and check again:\n`)
    for (const e of p.fitErrors) process.stdout.write(`  ✖ ${e}\n`)
    process.exit(1)
  }
  process.stdout.write(`\nOK — ${p.spec.slides.length} slides fit. Build with: node "${path.join(SKILL_DIR, 'pptx.cjs')}" build ${specFile} out.pptx\n`)
}

async function cmdBuild(args) {
  const force = flag(args, '--force')
  const quiet = flag(args, '--quiet')
  const [specFile, outFile] = args
  if (!specFile || !outFile) usage()
  if (!/\.pptx$/i.test(outFile)) { process.stderr.write('the output must end in .pptx\n'); process.exit(2) }
  const p = plan(specFile)
  if (!quiet) process.stdout.write(`${printPlan(p.spec, p.reports, p.problems)}\n`)
  if (p.fitErrors.length > 0 && !force) {
    process.stdout.write(`\nNot written: ${p.fitErrors.length} slide${p.fitErrors.length > 1 ? 's do' : ' does'} not fit. Fix the spec (or pass --force to write it anyway):\n`)
    for (const e of p.fitErrors) process.stdout.write(`  ✖ ${e}\n`)
    process.exit(1)
  }
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
  await p.pres.writeFile({ fileName: path.resolve(outFile) })
  const { validate } = require('./lib/ooxml.cjs')
  const v = await validate(outFile)
  if (!v.ok) {
    process.stdout.write(`\nWrote ${outFile} but it fails validation — this is a bug in the generator, report it:\n`)
    for (const e of v.problems) process.stdout.write(`  ✖ ${e}\n`)
    process.exit(1)
  }
  process.stdout.write(`\nWrote ${outFile} (${kb(outFile)}, ${v.slides} slides, package valid).${p.fitErrors.length > 0 ? ' Forced: some text overflows.' : ''}\n`)
  process.stdout.write(`Next: node "${path.join(SKILL_DIR, 'pptx.cjs')}" render ${outFile} -o qa   (PNG per slide, needs PowerPoint)\n`)
}

async function cmdOutline(args) {
  const json = flag(args, '--json')
  const [deck] = args
  if (!deck) usage()
  const { outline, formatOutline } = require('./lib/ooxml.cjs')
  const slides = await outline(deck)
  process.stdout.write(json ? `${JSON.stringify(slides, null, 2)}\n` : `${deck}: ${slides.length} slides\n\n${formatOutline(slides)}`)
}

async function cmdReplace(args) {
  const [inFile, outFile, ...pairsRaw] = args
  if (!inFile || !outFile || pairsRaw.length === 0) usage()
  if (path.resolve(inFile) === path.resolve(outFile)) { process.stderr.write('write to a new file; the input is not overwritten\n'); process.exit(2) }
  const pairs = pairsRaw.map((p) => {
    const i = p.indexOf('=>')
    if (i <= 0) { process.stderr.write(`"${p}" is not of the form old=>new\n`); process.exit(2) }
    return [p.slice(0, i), p.slice(i + 2)]
  })
  const { replace } = require('./lib/ooxml.cjs')
  const counts = await replace(inFile, outFile, pairs)
  pairs.forEach(([from, to], i) => {
    process.stdout.write(`${counts[i]} × "${from}" → "${to}"${counts[i] === 0 ? '   (not found as one run — see the outline; the phrase may be split across formatting)' : ''}\n`)
  })
  process.stdout.write(`Wrote ${outFile}\n`)
  if (counts.every((c) => c === 0)) process.exit(1)
}

async function cmdSlides(args) {
  const keep = option(args, '--keep', null)
  const drop = option(args, '--drop', null)
  const order = option(args, '--order', null)
  const [inFile, outFile] = args
  if (!inFile || !outFile || [keep, drop, order].filter((x) => x !== null).length !== 1) usage()
  if (path.resolve(inFile) === path.resolve(outFile)) { process.stderr.write('write to a new file; the input is not overwritten\n'); process.exit(2) }
  const { slideParts, parseRange, reorder } = require('./lib/ooxml.cjs')
  const JSZip = require('jszip')
  const count = (await slideParts(await JSZip.loadAsync(fs.readFileSync(inFile)))).length
  let sequence
  if (keep !== null) sequence = parseRange(keep, count)
  else if (drop !== null) {
    const gone = new Set(parseRange(drop, count))
    sequence = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !gone.has(n))
  } else {
    sequence = parseRange(order, count)
    if (sequence.length !== count) process.stdout.write(`note: --order names ${sequence.length} of ${count} slides; the others are removed\n`)
  }
  if (sequence.length === 0) { process.stderr.write('that would leave no slides\n'); process.exit(2) }
  const r = await reorder(inFile, outFile, sequence)
  process.stdout.write(`Wrote ${outFile}: ${r.kept} slides kept (order ${sequence.join(', ')}), ${r.removed} removed\n`)
}

async function cmdValidate(args) {
  const [deck] = args
  if (!deck) usage()
  const { validate } = require('./lib/ooxml.cjs')
  const v = await validate(deck)
  if (v.ok) { process.stdout.write(`OK — ${deck}: ${v.slides} slides, ${v.parts} parts, every check passed\n`); return }
  process.stdout.write(`${deck}: ${v.problems.length} problem${v.problems.length > 1 ? 's' : ''}\n`)
  for (const p of v.problems) process.stdout.write(`  ✖ ${p}\n`)
  process.exit(1)
}

async function cmdRender(args) {
  const outDir = option(args, '-o', option(args, '--out', 'qa'))
  const width = Number(option(args, '--width', '1600'))
  const prefix = option(args, '--prefix', 'slide')
  const pdf = flag(args, '--pdf')
  const grid = flag(args, '--grid')
  const pngToo = flag(args, '--png')
  const [deck] = args
  if (!deck) usage()
  const { render } = require('./lib/render.cjs')
  const r = render(deck, { outDir, width, pdf, png: !pdf || pngToo, grid, prefix })
  if (!r.ok) {
    process.stdout.write(`Not rendered: ${r.message}\n`)
    process.exit(r.code === 'no-powerpoint' ? 2 : 1)
  }
  for (const p of r.pngs) process.stdout.write(`${p}\n`)
  if (r.pdf) process.stdout.write(`${r.pdf}\n`)
  for (const g of r.grid) process.stdout.write(`${g}\n`)
  process.stdout.write(`Rendered ${r.slides || r.pngs.length} slide${(r.slides || r.pngs.length) === 1 ? '' : 's'} with PowerPoint${r.message ? ` — ${r.message}` : ''}. PowerPoint opened the file without repair, so it is valid for it.\n`)
}

function cmdThemes() {
  const { THEMES } = require('./lib/theme.cjs')
  for (const [name, t] of Object.entries(THEMES)) {
    process.stdout.write(`${name.padEnd(9)} ${t.label}\n          dark ${t.colors.dark}  accent ${t.colors.accent}  support ${t.colors.support}  paper ${t.colors.paper}  fonts ${t.fonts.head} / ${t.fonts.body}\n`)
  }
  process.stdout.write('\nOverride per deck with "font": { "head": "...", "body": "..." } and "accent": "RRGGBB".\n')
}

function cmdExample(args) {
  const src = path.join(SKILL_DIR, 'examples', 'sample.json')
  const [out] = args
  if (out) {
    fs.copyFileSync(src, out)
    const img = path.join(SKILL_DIR, 'examples', 'figure.png')
    const dst = path.join(path.dirname(path.resolve(out)), 'figure.png')
    if (fs.existsSync(img) && !fs.existsSync(dst)) fs.copyFileSync(img, dst)
    process.stdout.write(`Wrote ${out} (and figure.png beside it). Edit it, then: check → build → render.\n`)
  } else {
    process.stdout.write(fs.readFileSync(src, 'utf8'))
  }
}

async function main() {
  // `| head` closes the pipe early; that is not a failure of the tool, and a stack trace for
  // it would bury the lines that did get through.
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0) })
  const [cmd, ...args] = process.argv.slice(2)
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') usage(cmd ? 0 : 2)
  switch (cmd) {
    case 'check': return cmdCheck(args)
    case 'build': return cmdBuild(args)
    case 'outline': return cmdOutline(args)
    case 'replace': return cmdReplace(args)
    case 'slides': return cmdSlides(args)
    case 'validate': return cmdValidate(args)
    case 'render': return cmdRender(args)
    case 'themes': return cmdThemes()
    case 'example': return cmdExample(args)
    default:
      process.stderr.write(`unknown command "${cmd}"\n\n`)
      usage()
  }
}

main().catch((e) => {
  process.stderr.write(`${e && e.message ? e.message : String(e)}\n`)
  process.exit(1)
})
