'use strict'
/**
 * Rendering, for the eyes: PNG per slide and/or a PDF, through render.ps1 and the PowerPoint
 * on the machine. Without PowerPoint there is no faithful renderer here; LibreOffice, when
 * present, can still make a PDF, and the message says which case this is.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function powershell() {
  const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return fs.existsSync(sys) ? sys : 'powershell'
}

function soffice() {
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['soffice'], { encoding: 'utf8' })
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).find((l) => l.trim() !== '')
    if (first) return first.trim()
  }
  return null
}

/**
 * Returns `{ ok, pngs, pdf, grid, slides, message }`. `ok: false` with `code: 'no-powerpoint'`
 * when nothing on the machine can render.
 */
function render(deck, { outDir = '.', width = 1600, pdf = false, png = true, grid = false, prefix = 'slide' } = {}) {
  const abs = path.resolve(deck)
  if (!fs.existsSync(abs)) return { ok: false, code: 'not-found', message: `not found: ${abs}` }
  const out = path.resolve(outDir)
  fs.mkdirSync(out, { recursive: true })
  if (process.platform !== 'win32') return { ok: false, code: 'no-powerpoint', message: 'rendering needs PowerPoint on Windows' }

  // Beside this file's parent from a checkout (lib/render.cjs), beside the file itself once
  // bundle.mjs has folded lib/ into one pptx.cjs.
  const script = [path.join(__dirname, 'render.ps1'), path.join(__dirname, '..', 'render.ps1')].find((p) => fs.existsSync(p))
  if (!script) return { ok: false, code: 'no-script', message: 'render.ps1 is missing beside the tool' }
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', abs, '-OutDir', out, '-Width', String(width), '-Prefix', prefix]
  if (pdf) args.push('-Pdf')
  if (png) args.push('-Png')
  if (grid) args.push('-Grid')
  const r = spawnSync(powershell(), args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  const result = { ok: false, pngs: [], pdf: null, grid: [], slides: 0, message: '' }
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let obj
    try { obj = JSON.parse(t) } catch { continue }
    if (obj.png) result.pngs.push(obj.png)
    if (obj.pdf) result.pdf = obj.pdf
    if (obj.grid) result.grid.push(obj.grid)
    if (obj.done) { result.ok = true; result.slides = obj.slides }
    if (obj.error) { result.message = obj.error; result.code = obj.code }
  }
  if (r.status === 2 || result.code === 'no-powerpoint') {
    const lo = soffice()
    if (lo && pdf) {
      const conv = spawnSync(lo, ['--headless', '--convert-to', 'pdf', '--outdir', out, abs], { encoding: 'utf8', windowsHide: true })
      const pdfPath = path.join(out, `${path.basename(abs, path.extname(abs))}.pdf`)
      if (conv.status === 0 && fs.existsSync(pdfPath)) {
        return { ok: true, pngs: [], pdf: pdfPath, grid: [], slides: 0, message: 'rendered with LibreOffice (fonts may be substituted); PNGs need PowerPoint' }
      }
    }
    return { ok: false, code: 'no-powerpoint', message: `${result.message || 'PowerPoint is not installed'}${lo ? '; LibreOffice was found and can make a PDF with --pdf' : '; no LibreOffice either — the deck cannot be rendered here, say so rather than guessing how it looks'}` }
  }
  if (!result.ok && !result.message) result.message = `render.ps1 exited with ${r.status}: ${(r.stderr ?? '').trim().split(/\r?\n/).slice(-3).join(' ')}`
  return result
}

module.exports = { render, powershell, soffice }
