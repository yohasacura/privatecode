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

export function searchNotes(index: MapIndex, query: string): MapHit[] {
  const words = query.toLowerCase().split(/[^a-z0-9_]+/i).filter((w) => w.length >= 3)
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

export const projectMapTool: Tool<ProjectMapArgs> = {
  name: 'ProjectMap',
  readOnly: true,
  description:
    'The project map: a wiki of this codebase written from its code (what each file does and why, contracts, invariants, traps, ' +
    'who uses what, tests, what changes together; how each module fits; the project overview and conventions). ' +
    'Call with no arguments for the project note, with `path` (a file or a directory) for its note, or with `query` to find the notes about a topic. ' +
    'Read the map before opening files: one note answers what several reads would.',
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
    if (args.query !== undefined) {
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
