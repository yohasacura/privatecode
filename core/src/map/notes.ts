import type { MapFileNode, MapModuleNode, MapSkeleton } from './skeleton.js'

/**
 * The notes of the project map, and how they are written to disk.
 *
 * A note is typed, not free text: every file note has the same fields, every module note
 * the same, so the model fills a form rather than composing an essay — the one thing this
 * model reliably does when the shape is enforced (docs/MAP.md). The structured record is the
 * truth and lives in `index.json`; the markdown beside it is RENDERED from the record, with
 * Obsidian-style `[[wikilinks]]` between notes, so the folder opens as a vault and every link
 * lands on a note that exists.
 *
 * The levels carry different knowledge, not the same knowledge summarised again:
 *
 *   file    — what it does, why it exists (from the commits that touched it), the contracts
 *             of its symbols, invariants, the traps
 *   module  — how its files work together: entry points, the flows through them, what it
 *             talks to outside itself
 *   project — the map of modules, the conventions, where to start reading
 */

export interface FileNote {
  kind: 'file'
  path: string
  /** The file's hash when the note was written; a different hash on disk means stale. */
  hash: string
  what: string
  why: string
  contracts: { symbol: string; guarantees: string }[]
  invariants: string[]
  gotchas: string[]
  builtAt: string
  model: string
  /** Share of questions about the source the note alone could answer — see `verify`. */
  fidelity?: number
}

export interface ModuleNote {
  kind: 'module'
  path: string
  /** A hash over the child notes' hashes: stale when any file below changed. */
  hash: string
  purpose: string
  entryPoints: { symbol: string; path: string; role: string }[]
  flows: { name: string; steps: string[] }[]
  interactions: string[]
  builtAt: string
  model: string
}

export interface ProjectNote {
  kind: 'project'
  hash: string
  overview: string
  subsystems: { path: string; role: string }[]
  conventions: string[]
  startHere: { path: string; why: string }[]
  builtAt: string
  model: string
}

export interface MapIndex {
  version: 1
  builtAt: string
  skeleton: MapSkeleton
  notes: {
    files: Record<string, FileNote>
    modules: Record<string, ModuleNote>
    project?: ProjectNote
  }
}

// ---- the forms the model fills --------------------------------------------------------------

const STRINGS = { type: 'array', items: { type: 'string' } }

export const FILE_NOTE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    what: { type: 'string', description: 'What the file does, one or two sentences, concrete.' },
    why: { type: 'string', description: 'Why it exists and what shaped it — from the commit subjects when they say; "unknown" when they do not.' },
    contracts: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'A symbol name exactly as in the outline.' },
          guarantees: { type: 'string', description: 'What it guarantees to a caller and what it requires, one sentence.' },
        },
        required: ['symbol', 'guarantees'],
      },
    },
    invariants: { ...STRINGS, maxItems: 6, description: 'Things that must stay true for this file to be correct.' },
    gotchas: { ...STRINGS, maxItems: 6, description: 'Traps a person editing this file would fall into — non-obvious only.' },
  },
  required: ['what', 'why', 'contracts', 'invariants', 'gotchas'],
}

export const MODULE_NOTE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    purpose: { type: 'string', description: 'What this directory is for, as a whole, two sentences at most.' },
    entryPoints: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          path: { type: 'string', description: 'The file, exactly as listed.' },
          role: { type: 'string', description: 'Why a reader starts here.' },
        },
        required: ['symbol', 'path', 'role'],
      },
    },
    flows: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A scenario that runs through several files.' },
          steps: { ...STRINGS, maxItems: 8, description: 'Each step names the file and what happens there.' },
        },
        required: ['name', 'steps'],
      },
    },
    interactions: { ...STRINGS, maxItems: 8, description: 'What this module talks to outside itself, and how.' },
  },
  required: ['purpose', 'entryPoints', 'flows', 'interactions'],
}

export const PROJECT_NOTE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    overview: { type: 'string', description: 'What the project is and how it is put together, a short paragraph.' },
    subsystems: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: { path: { type: 'string', description: 'A module path exactly as listed.' }, role: { type: 'string' } },
        required: ['path', 'role'],
      },
    },
    conventions: { ...STRINGS, maxItems: 10, description: 'Rules the code follows everywhere, stated so an editor can follow them.' },
    startHere: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: { path: { type: 'string', description: 'A file or module path exactly as listed.' }, why: { type: 'string' } },
        required: ['path', 'why'],
      },
    },
  },
  required: ['overview', 'subsystems', 'conventions', 'startHere'],
}

/** Self-check: questions a note should be able to answer, drawn from the source. */
export const QUESTIONS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'A question a developer would ask about this file whose answer is in the source.' },
          a: { type: 'string', description: 'The answer, short and specific.' },
        },
        required: ['q', 'a'],
      },
    },
  },
  required: ['questions'],
}

export const ANSWERS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { answers: { ...STRINGS, minItems: 3, maxItems: 3, description: 'One answer per question, from the note alone; "not in the note" when it is not.' } },
  required: ['answers'],
}

export const VERDICTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { verdicts: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'boolean' }, description: 'Whether each given answer matches the expected one in substance.' } },
  required: ['verdicts'],
}

// ---- the vault on disk ------------------------------------------------------------------------

/** Where a note lives inside the map folder, without the extension. */
export function noteName(kind: 'file' | 'module' | 'project', path = ''): string {
  if (kind === 'project') return 'Project'
  if (kind === 'file') return `files/${path}`
  return path === '' ? 'modules/root' : `modules/${path}`
}

/** An Obsidian link to a note, labelled by the path's last segment. */
export function wikilink(kind: 'file' | 'module' | 'project', path = ''): string {
  const label = kind === 'project' ? 'Project' : path === '' ? 'root' : (path.split('/').pop() ?? path)
  return `[[${noteName(kind, path)}|${label}]]`
}

function yaml(value: string | number | boolean): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function frontMatter(fields: Record<string, string | number | boolean | undefined>): string {
  const lines = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${yaml(v as string | number | boolean)}`)
  return `---\n${lines.join('\n')}\n---\n`
}

function list(items: readonly string[], empty = '_none_'): string {
  return items.length === 0 ? `${empty}\n` : `${items.map((i) => `- ${i}`).join('\n')}\n`
}

export function renderFileNote(note: FileNote, node: MapFileNode): string {
  const symbols = node.symbols.filter((s) => s.kind !== '...').map((s) => `\`${s.kind}\` **${s.name}** (line ${s.line})`)
  return [
    frontMatter({ kind: 'file', path: note.path, language: node.language, lines: node.lines, hash: note.hash, fidelity: note.fidelity, built: note.builtAt, model: note.model }),
    `# ${note.path}\n`,
    `${wikilink('module', note.path.split('/').slice(0, -1).join('/'))} · ${node.lines} lines · ${node.language}\n`,
    `## What\n${note.what}\n`,
    `## Why\n${note.why}\n`,
    `## Contracts\n${list(note.contracts.map((c) => `**${c.symbol}** — ${c.guarantees}`))}`,
    `## Invariants\n${list(note.invariants)}`,
    `## Gotchas\n${list(note.gotchas)}`,
    `## Symbols\n${list(symbols)}`,
    `## Uses\n${list(node.uses.map((p) => wikilink('file', p)))}`,
    `## Used by\n${list(node.usedBy.map((p) => wikilink('file', p)))}`,
    `## Tests\n${list(node.tests.map((p) => wikilink('file', p)))}`,
    `## Changes together with\n${list(node.coChanges.map((c) => `${wikilink('file', c.path)} (${c.count})`))}`,
    `## History\n${list(node.history)}`,
  ].join('\n')
}

export function renderModuleNote(note: ModuleNote, node: MapModuleNode, files: ReadonlyMap<string, FileNote>): string {
  const parent = node.path === '' ? wikilink('project') : wikilink('module', node.path.split('/').slice(0, -1).join('/'))
  return [
    frontMatter({ kind: 'module', path: node.path === '' ? '.' : node.path, hash: note.hash, built: note.builtAt, model: note.model }),
    `# ${node.path === '' ? 'root' : node.path}/\n`,
    `up: ${parent}\n`,
    `## Purpose\n${note.purpose}\n`,
    // A link only where a note can exist: an entry point the model placed in a file that is
    // not in this directory is named, not linked, so no link in the vault leads nowhere.
    `## Entry points\n${list(note.entryPoints.map((e) => `**${e.symbol}** in ${node.files.includes(e.path) ? wikilink('file', e.path) : `\`${e.path}\``} — ${e.role}`))}`,
    `## Flows\n${note.flows.length === 0 ? '_none_\n' : note.flows.map((f) => `### ${f.name}\n${f.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`).join('\n')}`,
    `## Interactions\n${list(note.interactions)}`,
    `## Modules\n${list(node.children.map((c) => wikilink('module', c)))}`,
    `## Files\n${list(node.files.map((p) => { const n = files.get(p); return `${wikilink('file', p)}${n !== undefined ? ` — ${n.what}` : ''}` }))}`,
  ].join('\n')
}

export function renderProjectNote(note: ProjectNote, skeleton: MapSkeleton): string {
  const root = skeleton.modules.find((m) => m.path === '')
  const isModule = (p: string): boolean => skeleton.modules.some((m) => m.path === p)
  const isFile = (p: string): boolean => skeleton.files.some((f) => f.path === p)
  // A path the model wrote that is neither a file nor a module of the skeleton is named in
  // code, not linked: a vault whose links all land is worth more than a prettier line.
  const link = (p: string): string => (isFile(p) ? wikilink('file', p) : isModule(p) ? wikilink('module', p) : `\`${p === '' ? '.' : p}\``)
  return [
    frontMatter({ kind: 'project', hash: note.hash, built: note.builtAt, model: note.model, files: skeleton.files.length, modules: skeleton.modules.length, commits: skeleton.commits }),
    '# Project\n',
    `## Overview\n${note.overview}\n`,
    `## Subsystems\n${list(note.subsystems.map((s) => `${link(s.path)} — ${s.role}`))}`,
    `## Conventions\n${list(note.conventions)}`,
    `## Start here\n${list(note.startHere.map((s) => `${link(s.path)} — ${s.why}`))}`,
    `## Top-level modules\n${list((root?.children ?? []).map((c) => wikilink('module', c)))}`,
  ].join('\n')
}

export const VAULT_README = `# Project map

Written by PrivateCode from the code itself: the structure — files, symbols, who uses whom,
tests, what changes together, the commit history — is computed by parsers and git, and the
words on top are written by the local model while the machine is idle. Open this folder as
an Obsidian vault; every [[link]] lands on a note. Start at [[Project]].

The markdown here is generated from index.json on every build; edits to it are overwritten.
`
