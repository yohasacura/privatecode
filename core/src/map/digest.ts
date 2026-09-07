import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { FileNote, MapIndex } from './notes.js'
import type { MapFileNode } from './skeleton.js'

/**
 * The map, delivered where the model already looks.
 *
 * Measured on the first live questions (`spike/map-help-probe.mts`): told in the repo map
 * that a map exists and to read it first, the model read the code instead — one question
 * cost 21 reads with the map sitting there unopened, and when it did search the map it
 * took the file names from the answer and read the files anyway. An instruction does not
 * route this model; the shape of what it receives does (docs/DESIGN.md). So the note rides
 * along with the file: a `Read` of a file that has a fresh note returns the note's digest
 * on top of the text — what, contracts, invariants, traps, neighbours — and a search hit
 * carries the lines that matched rather than a pointer to them.
 *
 * Fresh means the note's hash is the hash of the bytes being returned. A note about an
 * older version of the file is worse than none, because it is read first and believed.
 */

const DIGEST_ITEMS = 4
const DIGEST_ITEM_CHARS = 220

interface Cached { mtimeMs: number; index: MapIndex | null }
const cache = new Map<string, Cached>()

/** The map's index for a workspace, re-read only when index.json changed on disk. */
export function mapIndexFor(mapDir: string): MapIndex | null {
  const file = join(mapDir, 'index.json')
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    cache.delete(mapDir)
    return null
  }
  const hit = cache.get(mapDir)
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.index
  let index: MapIndex | null = null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as MapIndex
    index = parsed.version === 1 ? parsed : null
  } catch {
    index = null
  }
  cache.set(mapDir, { mtimeMs, index })
  return index
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function clip(s: string, max = DIGEST_ITEM_CHARS): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

const last = (p: string): string => p.split('/').pop() ?? p

/**
 * The digest of a file's note, or null when the file has no note or the note is not about
 * these bytes. `content` is the file exactly as read from disk (BOM included) — the hash
 * the builder wrote was taken over the same bytes.
 */
export function fileDigest(index: MapIndex, path: string, content: string): string | null {
  const note: FileNote | undefined = index.notes.files[path]
  if (note === undefined || note.hash !== sha1(content)) return null
  const node: MapFileNode | undefined = index.skeleton.files.find((f) => f.path === path)
  return renderDigest(note, node)
}

export function renderDigest(note: FileNote, node: MapFileNode | undefined): string {
  const lines: string[] = [`[Project map — a note written from this exact version of ${note.path}]`, `What: ${clip(note.what)}`]
  if (note.contracts.length > 0) {
    lines.push(`Contracts: ${note.contracts.slice(0, DIGEST_ITEMS).map((c) => `${c.symbol} — ${clip(c.guarantees, 160)}`).join('; ')}`)
  }
  if (note.invariants.length > 0) lines.push(`Invariants: ${note.invariants.slice(0, DIGEST_ITEMS).map((s) => clip(s, 160)).join(' | ')}`)
  if (note.gotchas.length > 0) lines.push(`Gotchas: ${note.gotchas.slice(0, DIGEST_ITEMS).map((s) => clip(s, 200)).join(' | ')}`)
  if (node !== undefined) {
    const related: string[] = []
    if (node.uses.length > 0) related.push(`uses ${node.uses.slice(0, 5).map(last).join(', ')}`)
    if (node.usedBy.length > 0) related.push(`used by ${node.usedBy.slice(0, 5).map(last).join(', ')}`)
    if (node.tests.length > 0) related.push(`tests ${node.tests.slice(0, 3).map(last).join(', ')}`)
    if (node.coChanges.length > 0) related.push(`changes with ${node.coChanges.slice(0, 3).map((c) => last(c.path)).join(', ')}`)
    if (related.length > 0) lines.push(`Related: ${related.join('; ')}`)
  }
  const dir = note.path.split('/').slice(0, -1).join('/')
  lines.push(`More: ProjectMap path "${note.path}" for the full note, "${dir === '' ? '.' : dir}" for how the module fits together.`)
  return lines.join('\n')
}

/**
 * For a search hit: the note's lines that carry any of the words, so the answer is in the
 * hit rather than behind it.
 */
export function matchingLines(note: FileNote, words: readonly string[]): string[] {
  const candidates: { label: string; text: string }[] = [
    ...note.contracts.map((c) => ({ label: 'contract', text: `${c.symbol} — ${c.guarantees}` })),
    ...note.invariants.map((s) => ({ label: 'invariant', text: s })),
    ...note.gotchas.map((s) => ({ label: 'gotcha', text: s })),
  ]
  const out: string[] = []
  for (const c of candidates) {
    const low = c.text.toLowerCase()
    if (words.some((w) => low.includes(w))) out.push(`  · ${c.label}: ${clip(c.text, 240)}`)
    if (out.length === 3) break
  }
  return out
}
