import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRIVATE_DIR } from '../private-dir.js'
import type { Tool } from '../tools/types.js'
import { readIndex } from './builder.js'
import { matchingLines } from './digest.js'
import { noteName, type MapIndex } from './notes.js'

/**
 * `ProjectMap`: the model reads the map the way a person reads a wiki — the project note
 * first, then down a link. One tool, three moves: no argument is the project note, a path
 * is that file's or module's note, a query is a search over every note's words. The notes
 * were written for exactly this reader, so a lookup here replaces several file reads.
 */

export interface ProjectMapArgs {
  path?: string
  query?: string
}

export const MAP_DIR = 'map'

export function mapDirOf(workspaceRoot: string): string {
  return join(workspaceRoot, PRIVATE_DIR, MAP_DIR)
}

const MAX_HITS = 8

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/** Reads the rendered note; the markdown is what the person sees too. */
function readNote(dir: string, kind: 'file' | 'module' | 'project', path = ''): string | null {
  try {
    return readFileSync(join(dir, `${noteName(kind, path)}.md`), 'utf8')
  } catch {
    return null
  }
}

/** Every note, scored by how many query words its text carries; symbols count double. */
export interface MapHit {
  kind: 'file' | 'module'
  path: string
  score: number
  what: string
  /** The note's own lines that carry the words — the answer in the hit, not behind it. */
  lines: string[]
}

/** A word in more than this share of the notes tells them apart no better than "the" does. */
const VOCABULARY_SHARE = 0.3
/** Below this many notes the share above means nothing, and every word counts. */
const VOCABULARY_FLOOR = 10

/**
 * The words of a query worth matching on. A request is a sentence, and a sentence is mostly
 * words every note contains — "the", "when", "file" — so a word found in a third of the
 * notes is dropped once there are enough notes to say so; what is left is what the request
 * is about.
 */
export function queryWords(index: MapIndex, query: string): string[] {
  const raw = [...new Set(query.toLowerCase().split(/[^a-z0-9_]+/i).filter((w) => w.length >= 3))]
  const notes = Object.values(index.notes.files)
  if (notes.length < VOCABULARY_FLOOR) return raw
  const texts = notes.map((n) => [n.what, n.why, ...n.contracts.map((c) => `${c.symbol} ${c.guarantees}`), ...n.invariants, ...n.gotchas].join(' ').toLowerCase())
  return raw.filter((w) => texts.filter((t) => t.includes(w)).length <= notes.length * VOCABULARY_SHARE)
}

export function searchNotes(index: MapIndex, query: string): MapHit[] {
  const words = queryWords(index, query)
  if (words.length === 0) return []
  const hits: MapHit[] = []
  for (const note of Object.values(index.notes.files)) {
    const node = index.skeleton.files.find((f) => f.path === note.path)
    const text = [note.what, note.why, ...note.contracts.map((c) => `${c.symbol} ${c.guarantees}`), ...note.invariants, ...note.gotchas].join(' ').toLowerCase()
    const symbols = (node?.symbols ?? []).map((s) => s.name.toLowerCase())
    const pathWords = note.path.toLowerCase()
    let score = 0
    for (const w of words) {
      if (text.includes(w)) score += 1
      if (symbols.some((s) => s.includes(w))) score += 2
      if (pathWords.includes(w)) score += 2
    }
    if (score > 0) hits.push({ kind: 'file', path: note.path, score, what: note.what, lines: matchingLines(note, words) })
  }
  for (const note of Object.values(index.notes.modules)) {
    const text = [note.purpose, ...note.interactions, ...note.flows.map((f) => `${f.name} ${f.steps.join(' ')}`)].join(' ').toLowerCase()
    let score = 0
    for (const w of words) {
      if (text.includes(w)) score += 1
      if (note.path.toLowerCase().includes(w)) score += 2
    }
    if (score > 0) {
      const lines = [
        ...note.flows.filter((f) => words.some((w) => `${f.name} ${f.steps.join(' ')}`.toLowerCase().includes(w))).map((f) => `  · flow: ${f.name}`),
        ...note.interactions.filter((i) => words.some((w) => i.toLowerCase().includes(w))).map((i) => `  · ${i.replace(/\s+/g, ' ').slice(0, 240)}`),
      ].slice(0, 3)
      hits.push({ kind: 'module', path: note.path, score, what: note.purpose, lines })
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, MAX_HITS)
}

/** A hit is worth putting in front of the model unasked from this score: two words of the
 * request in the note, or one in its path or symbols and one in its text. */
const MIN_ORIENTATION_SCORE = 3
const ORIENTATION_FILES = 3
const ORIENTATION_MODULES = 1

/**
 * The first move, made by the harness: the notes nearest a request, as a block the session
 * folds into the user message. Measured before it existed (`spike/map-help-probe.mts`):
 * offered, the map was read in 2 of 6 questions; under a first-move rule in 3 of 5; the
 * model greps first for a concept it can name and reads first for a file it can name, and
 * both are cases the note would have shortened. Null when nothing in the map is close —
 * a request about an unmapped area gets no block, and no cost.
 *
 * Square brackets inside the lines become round: the block lives inside one bracket the
 * window strips on replay by counting depth, and a contract line quoting `files['']` must
 * not unbalance it.
 */
export function orientationFor(index: MapIndex, request: string): string | null {
  const hits = searchNotes(index, request).filter((h) => h.score >= MIN_ORIENTATION_SCORE)
  const files = hits.filter((h) => h.kind === 'file').slice(0, ORIENTATION_FILES)
  const modules = hits.filter((h) => h.kind === 'module').slice(0, ORIENTATION_MODULES)
  if (files.length === 0 && modules.length === 0) return null
  const flat = (s: string): string => s.replace(/\[/g, '(').replace(/\]/g, ')')
  // A note about an earlier version of the file is still the nearest thing to the request,
  // and still worth a line — said so, because it is read first and believed.
  const stale = (h: MapHit): boolean => {
    if (h.kind !== 'file') return false
    const note = index.notes.files[h.path]
    const node = index.skeleton.files.find((f) => f.path === h.path)
    return note !== undefined && node !== undefined && note.hash !== node.hash
  }
  const lines = [
    'Project map — the notes nearest this request, written from the code; ProjectMap reads any of them in full:',
    ...[...files, ...modules].map((h) => [
      `- ${h.kind === 'module' ? `${h.path || '.'}/` : h.path}${stale(h) ? ' (note from an earlier version of the file)' : ''} — ${flat(h.what)}`,
      ...h.lines.slice(0, 2).map(flat),
    ].join('\n')),
  ]
  return lines.join('\n')
}

export const projectMapTool: Tool<ProjectMapArgs> = {
  name: 'ProjectMap',
  readOnly: true,
  description:
    'The project map: notes on this codebase written from its code — what a file or folder does and why, its contracts, ' +
    'invariants and traps, who uses it, its tests, what changes with it. Use it to check a detail or to see the overall structure: ' +
    '`path` — a file or folder ("." for the whole project); `query` — words to search the notes for; no arguments — the project overview.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A workspace-relative file or directory; "." for the root module.' },
      query: { type: 'string', description: 'Words to search the notes for — a symbol, a concept, a feature.' },
    },
  },
  validate(raw) {
    const r = (raw ?? {}) as Partial<ProjectMapArgs>
    const args: ProjectMapArgs = {}
    if (r.path !== undefined) {
      if (typeof r.path !== 'string') return { ok: false, error: 'path must be a string' }
      args.path = r.path
    }
    if (r.query !== undefined) {
      if (typeof r.query !== 'string' || r.query.trim() === '') return { ok: false, error: 'query must be a non-empty string' }
      args.query = r.query.trim()
    }
    return { ok: true, args }
  },
  async execute(args, ctx) {
    const dir = mapDirOf(ctx.workspace.root)
    const index = readIndex(dir)
    if (index === null) {
      return { ok: false, content: 'No project map has been built for this workspace yet — the person builds it from the Map tab. Read the code directly.' }
    }
    // Both given — the live model does that ("core/src/map", "builder rewrite note") — the
    // path wins: the note it names is the fuller answer, and the words were its reason.
    if (args.query !== undefined && args.path === undefined) {
      const hits = searchNotes(index, args.query)
      if (hits.length === 0) return { ok: true, content: `Nothing in the map mentions "${args.query}". Try other words, or Grep the code.` }
      return {
        ok: true,
        content: hits.map((h) => [`${h.kind === 'module' ? `${h.path || '.'}/` : h.path} — ${h.what}`, ...h.lines].join('\n')).join('\n'),
      }
    }
    if (args.path === undefined) {
      const project = readNote(dir, 'project')
      return project === null
        ? { ok: false, content: 'The map has file notes but no project note yet — build it again from the Map tab, or ask for a path.' }
        : { ok: true, content: project }
    }
    const path = normalise(args.path)
    if (path === '' || path === '.') {
      const root = readNote(dir, 'module', '')
      return root === null ? { ok: false, content: 'No note for the root module yet.' } : { ok: true, content: root }
    }
    const file = readNote(dir, 'file', path)
    if (file !== null) return { ok: true, content: file }
    const module = readNote(dir, 'module', path)
    if (module !== null) return { ok: true, content: module }
    const known = index.skeleton.files.some((f) => f.path === path) || index.skeleton.modules.some((m) => m.path === path)
    return {
      ok: false,
      content: known
        ? `${path} is on the map but has no note yet (the build has not reached it, or it changed since). Read it directly.`
        : `${path} is not on the map — not a source file the map indexes, or spelled differently. Try ProjectMap with a query.`,
    }
  },
}
