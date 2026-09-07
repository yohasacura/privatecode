import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LlamaClient } from '../llama/client.js'
import type { ChatMessage } from '../llama/types.js'
import { forcedJson } from '../session/forced-json.js'
import {
  ANSWERS_SCHEMA, FILE_NOTE_SCHEMA, MODULE_NOTE_SCHEMA, PROJECT_NOTE_SCHEMA, QUESTIONS_SCHEMA, VAULT_README, VERDICTS_SCHEMA,
  noteName, renderFileNote, renderModuleNote, renderProjectNote,
  type FileNote, type MapIndex, type ModuleNote, type ProjectNote,
} from './notes.js'
import { absoluteOf, buildSkeleton, type MapFileNode, type MapModuleNode, type MapMount, type MapSkeleton } from './skeleton.js'

/**
 * Builds the project map: the skeleton from the code, then a note per file, per module and
 * for the project, written by the model on the machine's idle time — and, when asked, a
 * self-check of each file note against the source it describes.
 *
 * Incremental by content hash: a file whose hash matches its note's is skipped, a module is
 * rewritten only when a note below it changed, and the project note only when a module did.
 * A repository the size of this one is a few hours the first time and minutes after.
 *
 * The model is the session's own client on the session's own server, which has ONE slot: a
 * build never starts a request while a turn is running (`isBusy`), and it yields between
 * notes so a turn the person starts waits for at most one note.
 */

export type MapPhase = 'skeleton' | 'files' | 'modules' | 'project' | 'verify' | 'done' | 'stopped' | 'failed'

export interface MapProgress {
  phase: MapPhase
  done: number
  total: number
  current?: string
  message?: string
}

export interface MapStatus {
  exists: boolean
  builtAt: string | null
  files: number
  modules: number
  /** Files with a note whose hash still matches. */
  noted: number
  /** Files with no note, or a note for a previous version. */
  stale: number
  verified: number
  /** Mean fidelity over verified notes, or null. */
  fidelity: number | null
  commits: number
  building: boolean
  last: MapProgress | null
  /** Where the vault is, for "open in Obsidian". */
  dir: string
}

export interface MapBuildOptions {
  /** Only files under this root-relative directory (their modules and the project still
   * get notes). */
  scope?: string
  /** Stop after this many file notes — for a first look, or a short idle window. */
  limit?: number
  /** Self-check every new file note against its source (three model calls per note). */
  verify?: boolean
  signal?: AbortSignal
}

export interface MapBuildResult {
  phase: MapPhase
  filesWritten: number
  modulesWritten: number
  projectWritten: boolean
  verified: number
  failed: string[]
}

/** Source handed to the model per file: enough for a real note, bounded for the slot's sake. */
const MAX_SOURCE_CHARS = 24_000
const NOTE_TOKENS = 1_400
const MODULE_TOKENS = 1_400
const PROJECT_TOKENS = 1_600
/** A second attempt, when the first answer did not parse, gets this much more room and a
 * plea for brevity: a form cut off mid-field is the one failure mode a bigger form fixes. */
const RETRY_GROWTH = 1.5
const BRIEFER = 'Answer more briefly: one sentence per field, fewer items.'
const BUSY_POLL_MS = 2_000

const SYSTEM = [
  'You are writing the project map — a wiki about this codebase for the developers who work in it and for an AI agent that will edit it.',
  'Be exact and terse. Use symbol and file names verbatim as given. Never invent a symbol, a file or a behaviour; when the material does not say, say "unknown".',
  'Write for someone who will change this code next week: contracts, invariants and traps matter more than restating the code.',
].join(' ')

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function emptyIndex(skeleton: MapSkeleton): MapIndex {
  return { version: 1, builtAt: skeleton.builtAt, skeleton, notes: { files: {}, modules: {} } }
}

export function readIndex(dir: string): MapIndex | null {
  try {
    const raw = readFileSync(join(dir, 'index.json'), 'utf8')
    const parsed = JSON.parse(raw) as MapIndex
    return parsed.version === 1 ? parsed : null
  } catch {
    return null
  }
}

function writeNoteFile(dir: string, name: string, markdown: string): void {
  const path = join(dir, `${name}.md`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, markdown, 'utf8')
}

/** The status of a map folder without a builder around — what the tool and the tab read. */
export function mapStatus(dir: string, skeleton?: MapSkeleton): Omit<MapStatus, 'building' | 'last'> {
  const index = readIndex(dir)
  if (index === null) {
    return { exists: false, builtAt: null, files: 0, modules: 0, noted: 0, stale: 0, verified: 0, fidelity: null, commits: 0, dir }
  }
  const live = skeleton ?? index.skeleton
  let noted = 0
  let verified = 0
  let fidelitySum = 0
  for (const f of live.files) {
    const note = index.notes.files[f.path]
    if (note !== undefined && note.hash === f.hash) {
      noted += 1
      if (note.fidelity !== undefined) { verified += 1; fidelitySum += note.fidelity }
    }
  }
  return {
    exists: true,
    builtAt: index.builtAt,
    files: live.files.length,
    modules: live.modules.length,
    noted,
    stale: live.files.length - noted,
    verified,
    fidelity: verified === 0 ? null : Math.round((fidelitySum / verified) * 100) / 100,
    commits: live.commits,
    dir,
  }
}

export class MapBuilder {
  private building = false
  private last: MapProgress | null = null
  private stop: AbortController | null = null

  private skeleton: MapSkeleton | null = null

  constructor(private readonly opts: {
    /** The primary folder — where the map lives. */
    root: string
    /** Every writable folder of the workspace; one entry, the primary, for a single-folder one. */
    mounts?: readonly MapMount[]
    dir: string
    client: LlamaClient
    model: string
    onProgress: (p: MapProgress) => void
    /** True while the session's slot is taken by a turn. */
    isBusy: () => boolean
  }) {}

  private get mounts(): MapMount[] {
    const given = this.opts.mounts
    return given === undefined || given.length === 0 ? [{ name: '', root: this.opts.root }] : [...given]
  }

  get isBuilding(): boolean {
    return this.building
  }

  async status(): Promise<MapStatus> {
    const base = mapStatus(this.opts.dir)
    return { ...base, building: this.building, last: this.last }
  }

  cancel(): void {
    this.stop?.abort()
  }

  private report(p: MapProgress): void {
    this.last = p
    this.opts.onProgress(p)
  }

  /** Waits for the slot: a build must never race the person's own turn for it. */
  private async idle(signal: AbortSignal): Promise<void> {
    while (this.opts.isBusy() && !signal.aborted) {
      await new Promise((r) => setTimeout(r, BUSY_POLL_MS))
    }
  }

  private async ask(messages: ChatMessage[], name: string, schema: Record<string, unknown>, maxTokens: number, signal: AbortSignal): Promise<unknown | null> {
    await this.idle(signal)
    if (signal.aborted) return null
    return forcedJson(this.opts.client, {
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      name, schema, maxTokens, disableThinking: true, signal,
    })
  }

  /** `ask`, and once more with more room and a plea for brevity when the answer did not parse. */
  private async askAgain(messages: ChatMessage[], name: string, schema: Record<string, unknown>, maxTokens: number, signal: AbortSignal): Promise<unknown | null> {
    const first = await this.ask(messages, name, schema, maxTokens, signal)
    if (first !== null || signal.aborted) return first
    const last = messages[messages.length - 1]
    const retry = last !== undefined && typeof last.content === 'string'
      ? [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${BRIEFER}` }]
      : messages
    return this.ask(retry, name, schema, Math.round(maxTokens * RETRY_GROWTH), signal)
  }

  async build(options: MapBuildOptions = {}): Promise<MapBuildResult> {
    if (this.building) throw new Error('the map is already being built')
    this.building = true
    this.stop = new AbortController()
    const signal = this.stop.signal
    if (options.signal !== undefined) options.signal.addEventListener('abort', () => this.stop?.abort(), { once: true })
    const result: MapBuildResult = { phase: 'skeleton', filesWritten: 0, modulesWritten: 0, projectWritten: false, verified: 0, failed: [] }
    try {
      mkdirSync(this.opts.dir, { recursive: true })
      writeFileSync(join(this.opts.dir, 'README.md'), VAULT_README, 'utf8')
      this.report({ phase: 'skeleton', done: 0, total: 0, message: 'reading the code' })
      const skeleton = await buildSkeleton(this.mounts)
      this.skeleton = skeleton
      const previous = readIndex(this.opts.dir)
      const index: MapIndex = previous === null ? emptyIndex(skeleton) : { ...previous, skeleton, builtAt: skeleton.builtAt }
      this.save(index)

      // ---- file notes ---------------------------------------------------------------------
      const scope = options.scope === undefined || options.scope === '' ? '' : `${options.scope.replace(/\\/g, '/').replace(/\/+$/, '')}/`
      const stale = skeleton.files.filter((f) => (scope === '' || f.path.startsWith(scope)) && index.notes.files[f.path]?.hash !== f.hash)
      const todo = options.limit !== undefined ? stale.slice(0, options.limit) : stale
      result.phase = 'files'
      let done = 0
      for (const file of todo) {
        if (signal.aborted) break
        this.report({ phase: 'files', done, total: todo.length, current: file.path })
        const note = await this.fileNote(file, signal)
        if (note === null) {
          if (!signal.aborted) result.failed.push(file.path)
        } else {
          index.notes.files[file.path] = note
          writeNoteFile(this.opts.dir, noteName('file', file.path), renderFileNote(note, file))
          result.filesWritten += 1
          if (options.verify === true && !signal.aborted) {
            this.report({ phase: 'verify', done, total: todo.length, current: file.path })
            const fidelity = await this.verify(file, note, signal)
            if (fidelity !== null) {
              note.fidelity = fidelity
              result.verified += 1
              writeNoteFile(this.opts.dir, noteName('file', file.path), renderFileNote(note, file))
            }
          }
        }
        done += 1
        if (done % 5 === 0) this.save(index)
      }
      // Every fresh file note is re-rendered: the links under it come from the skeleton, which
      // moves with the code (and with the rules that read it) while the note's words stay.
      for (const file of skeleton.files) {
        const note = index.notes.files[file.path]
        if (note !== undefined && note.hash === file.hash) writeNoteFile(this.opts.dir, noteName('file', file.path), renderFileNote(note, file))
      }
      this.save(index)
      if (signal.aborted) { result.phase = 'stopped'; this.report({ phase: 'stopped', done, total: todo.length }); return result }

      // ---- module notes, bottom-up, only where something below changed ------------------------
      result.phase = 'modules'
      const fileNotes = new Map(Object.entries(index.notes.files))
      const fresh = (p: string): boolean => {
        const note = index.notes.files[p]
        return note !== undefined && note.hash === skeleton.files.find((f) => f.path === p)?.hash
      }
      // Deepest first, decided one at a time: whether a module is covered — every file in it
      // has a fresh note and every child module has one — depends on what the loop wrote just
      // before. A module described from half its files is a module the model makes up: it
      // waits until it can be described from all of them.
      const depth = (p: string): number => (p === '' ? 0 : p.split('/').length)
      const deepestFirst = [...skeleton.modules].sort((a, b) => depth(b.path) - depth(a.path) || a.path.localeCompare(b.path))
      const moduleHashes = new Map<string, string>()
      const moduleTotal = deepestFirst.length
      let mdone = 0
      for (const module of deepestFirst) {
        if (signal.aborted) break
        const hash = this.moduleHash(module, index, moduleHashes)
        moduleHashes.set(module.path, hash)
        const covered = module.files.every(fresh) && module.children.every((c) => index.notes.modules[c] !== undefined)
        mdone += 1
        if (!covered || index.notes.modules[module.path]?.hash === hash) continue
        this.report({ phase: 'modules', done: mdone - 1, total: moduleTotal, current: module.path === '' ? '.' : module.path })
        const note = await this.moduleNote(module, index, hash, signal)
        if (note === null) {
          if (!signal.aborted) result.failed.push(`${module.path || '.'}/`)
        } else {
          index.notes.modules[module.path] = note
          writeNoteFile(this.opts.dir, noteName('module', module.path), renderModuleNote(note, module, fileNotes))
          result.modulesWritten += 1
        }
      }
      // Every module note is re-rendered: the file lines under it carry the latest "what".
      for (const module of skeleton.modules) {
        const note = index.notes.modules[module.path]
        if (note !== undefined) writeNoteFile(this.opts.dir, noteName('module', module.path), renderModuleNote(note, module, fileNotes))
      }
      this.save(index)
      if (signal.aborted) { result.phase = 'stopped'; this.report({ phase: 'stopped', done: mdone, total: moduleTotal }); return result }

      // ---- the project note ----------------------------------------------------------------------
      result.phase = 'project'
      const projectHash = sha1(Object.values(index.notes.modules).map((m) => `${m.path}:${m.hash}`).sort().join('|'))
      // The root module has a note only once everything under it has one: the project note
      // is written from the whole, never from the part that happened to be built first.
      if (index.notes.modules[''] !== undefined && index.notes.project?.hash !== projectHash) {
        this.report({ phase: 'project', done: 0, total: 1, current: 'Project' })
        const note = await this.projectNote(index, projectHash, signal)
        if (note === null) {
          if (!signal.aborted) result.failed.push('Project')
        } else {
          index.notes.project = note
          result.projectWritten = true
        }
      }
      if (index.notes.project !== undefined) writeNoteFile(this.opts.dir, noteName('project'), renderProjectNote(index.notes.project, skeleton))
      this.save(index)
      result.phase = signal.aborted ? 'stopped' : 'done'
      const failed = result.failed.length === 0 ? '' : `; ${result.failed.length} failed (${result.failed.slice(0, 3).join(', ')}${result.failed.length > 3 ? ', …' : ''})`
      this.report({ phase: result.phase, done: todo.length, total: todo.length, message: `${result.filesWritten} file notes, ${result.modulesWritten} module notes${result.projectWritten ? ', the project note' : ''}${failed}` })
      return result
    } catch (e) {
      result.phase = 'failed'
      this.report({ phase: 'failed', done: 0, total: 0, message: (e as Error).message })
      return result
    } finally {
      this.building = false
      this.stop = null
    }
  }

  private save(index: MapIndex): void {
    writeFileSync(join(this.opts.dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  }

  private moduleHash(module: MapModuleNode, index: MapIndex, childHashes: Map<string, string>): string {
    const parts = [
      ...module.files.map((p) => `${p}:${index.notes.files[p]?.hash ?? 'none'}`),
      ...module.children.map((c) => `${c}/:${childHashes.get(c) ?? index.notes.modules[c]?.hash ?? 'none'}`),
    ]
    return sha1(parts.sort().join('|'))
  }

  private async source(file: MapFileNode): Promise<string> {
    try {
      const abs = absoluteOf(this.skeleton ?? { mounts: this.mounts }, file.path)
      if (abs === null) return ''
      const text = await readFile(abs, 'utf8')
      return text.length > MAX_SOURCE_CHARS ? `${text.slice(0, MAX_SOURCE_CHARS)}\n… (truncated; ${file.lines} lines in all — the outline below covers the rest)` : text
    } catch {
      return ''
    }
  }

  private async fileNote(file: MapFileNode, signal: AbortSignal): Promise<FileNote | null> {
    const source = await this.source(file)
    if (source === '') return null
    const outline = file.symbols.filter((s) => s.kind !== '...').map((s) => `${'  '.repeat(s.depth)}${s.kind} ${s.name} (line ${s.line})`).join('\n')
    const user = [
      `File: ${file.path} (${file.language}, ${file.lines} lines)`,
      `Symbols:\n${outline || '(none parsed)'}`,
      `Uses (files whose names this one mentions): ${file.uses.join(', ') || 'none'}`,
      `Used by: ${file.usedBy.join(', ') || 'none'}`,
      `Tests: ${file.tests.join(', ') || 'none'}`,
      `Changes together with: ${file.coChanges.map((c) => `${c.path} (${c.count})`).join(', ') || 'unknown'}`,
      `Commit subjects that touched it, newest first:\n${file.history.map((h) => `- ${h}`).join('\n') || '- unknown'}`,
      `Source:\n\`\`\`${file.language}\n${source}\n\`\`\``,
      'Fill the note for this file.',
    ].join('\n\n')
    const raw = await this.askAgain([{ role: 'user', content: user }], 'file_note', FILE_NOTE_SCHEMA, NOTE_TOKENS, signal)
    const parsed = parseFileNote(raw)
    if (parsed === null) return null
    return { kind: 'file', path: file.path, hash: file.hash, ...parsed, builtAt: new Date().toISOString(), model: this.opts.model }
  }

  private async moduleNote(module: MapModuleNode, index: MapIndex, hash: string, signal: AbortSignal): Promise<ModuleNote | null> {
    const files = module.files.map((p) => {
      const n = index.notes.files[p]
      const node = index.skeleton.files.find((f) => f.path === p)
      const contracts = n?.contracts.slice(0, 4).map((c) => `${c.symbol}: ${c.guarantees}`).join('; ') ?? ''
      return `- ${p}: ${n?.what ?? '(no note yet)'}${contracts !== '' ? `\n  contracts: ${contracts}` : ''}${node !== undefined && node.usedBy.length > 0 ? `\n  used by: ${node.usedBy.slice(0, 6).join(', ')}` : ''}`
    })
    const children = module.children.map((c) => `- ${c}/: ${index.notes.modules[c]?.purpose ?? '(no note yet)'}`)
    const user = [
      `Directory: ${module.path === '' ? '. (the project root)' : `${module.path}/`}`,
      `Files directly inside, with their notes:\n${files.join('\n') || '(none)'}`,
      `Subdirectories, with their notes:\n${children.join('\n') || '(none)'}`,
      'Describe how these work together. Entry points and flow steps must name files from the lists above, exactly.',
    ].join('\n\n')
    const raw = await this.askAgain([{ role: 'user', content: user }], 'module_note', MODULE_NOTE_SCHEMA, MODULE_TOKENS, signal)
    const parsed = parseModuleNote(raw)
    if (parsed === null) return null
    return { kind: 'module', path: module.path, hash, ...parsed, builtAt: new Date().toISOString(), model: this.opts.model }
  }

  private async projectNote(index: MapIndex, hash: string, signal: AbortSignal): Promise<ProjectNote | null> {
    const modules = Object.values(index.notes.modules)
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((m) => `- ${m.path === '' ? '.' : `${m.path}/`}: ${m.purpose}${m.entryPoints.length > 0 ? `\n  entry points: ${m.entryPoints.slice(0, 4).map((e) => `${e.symbol} (${e.path})`).join(', ')}` : ''}`)
    const folders = index.skeleton.mounts.length > 1
      ? `The workspace is ${index.skeleton.mounts.length} folders, each a top-level module: ${index.skeleton.mounts.map((m) => `${m.name}/`).join(', ')}. ` +
        'They may be parts of one product or unrelated projects that happen to be open together — say which in the overview, from what the notes and the cross-folder references show, and describe each folder for what it is.'
      : ''
    const user = [
      `Modules of the project, with their notes:\n${modules.join('\n')}`,
      `${index.skeleton.files.length} source files, ${index.skeleton.commits} commits read.${folders !== '' ? `\n${folders}` : ''}`,
      'Write the project note. Subsystem and start-here paths must be taken from the list above, exactly.',
    ].join('\n\n')
    const raw = await this.askAgain([{ role: 'user', content: user }], 'project_note', PROJECT_NOTE_SCHEMA, PROJECT_TOKENS, signal)
    const parsed = parseProjectNote(raw)
    if (parsed === null) return null
    return { kind: 'project', hash, ...parsed, builtAt: new Date().toISOString(), model: this.opts.model }
  }

  /**
   * How much of the file the note carries: three questions drawn from the source, answered
   * from the note alone, judged against the source's answers. A note that scores low is a
   * note to rewrite; the number is kept on the note so the tab and the tool can show it.
   */
  private async verify(file: MapFileNode, note: FileNote, signal: AbortSignal): Promise<number | null> {
    const source = await this.source(file)
    if (source === '') return null
    const qa = await this.ask([{ role: 'user', content: `File ${file.path}:\n\`\`\`${file.language}\n${source}\n\`\`\`\n\nWrite three questions a developer would ask about this file, each with its answer from the source.` }], 'map_questions', QUESTIONS_SCHEMA, 500, signal)
    const questions = parseQuestions(qa)
    if (questions === null) return null
    const noteText = renderFileNote(note, file)
    const answered = await this.ask([{ role: 'user', content: `You have ONLY this note, not the code:\n\n${noteText}\n\nAnswer these questions from the note alone:\n${questions.map((q, i) => `${i + 1}. ${q.q}`).join('\n')}` }], 'map_answers', ANSWERS_SCHEMA, 400, signal)
    const answers = parseStrings(answered, 'answers')
    if (answers === null || answers.length !== questions.length) return null
    const judged = await this.ask([{ role: 'user', content: `Judge each answer against the expected one; true when it matches in substance.\n${questions.map((q, i) => `${i + 1}. Q: ${q.q}\n   expected: ${q.a}\n   given: ${answers[i]}`).join('\n')}` }], 'map_verdicts', VERDICTS_SCHEMA, 100, signal)
    const verdicts = judged !== null && typeof judged === 'object' && Array.isArray((judged as { verdicts?: unknown }).verdicts)
      ? ((judged as { verdicts: unknown[] }).verdicts.filter((v) => typeof v === 'boolean') as boolean[])
      : null
    if (verdicts === null || verdicts.length !== questions.length) return null
    return Math.round((verdicts.filter(Boolean).length / verdicts.length) * 100) / 100
  }
}

// ---- reading the model's forms, strictly ----------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' ? v.trim() : null
}

/** A path as the model writes it (`./core/`, `core\\src`) to the form the skeleton uses. */
function cleanPath(v: unknown): string | null {
  const s = str(v)
  if (s === null) return null
  const p = s.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  return p === '.' ? '' : p
}

/** A flow step without the number the model likes to put in front of it; rendered lists number themselves. */
function unnumber(step: string): string {
  return step.replace(/^\s*(?:\d+|[a-z])[.)]\s+/i, '')
}

function parseStrings(raw: unknown, key: string): string[] | null {
  if (raw === null || typeof raw !== 'object') return null
  const arr = (raw as Record<string, unknown>)[key]
  if (!Array.isArray(arr)) return null
  return arr.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter((s) => s !== '')
}

export function parseFileNote(raw: unknown): Omit<FileNote, 'kind' | 'path' | 'hash' | 'builtAt' | 'model'> | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const what = str(r['what'])
  const why = str(r['why'])
  if (what === null || what === '' || why === null) return null
  const contracts = Array.isArray(r['contracts'])
    ? (r['contracts'] as unknown[]).flatMap((c) => {
      if (c === null || typeof c !== 'object') return []
      const symbol = str((c as Record<string, unknown>)['symbol'])
      const guarantees = str((c as Record<string, unknown>)['guarantees'])
      return symbol !== null && symbol !== '' && guarantees !== null ? [{ symbol, guarantees }] : []
    })
    : []
  return { what, why, contracts, invariants: parseStrings(raw, 'invariants') ?? [], gotchas: parseStrings(raw, 'gotchas') ?? [] }
}

export function parseModuleNote(raw: unknown): Omit<ModuleNote, 'kind' | 'path' | 'hash' | 'builtAt' | 'model'> | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const purpose = str(r['purpose'])
  if (purpose === null || purpose === '') return null
  const entryPoints = Array.isArray(r['entryPoints'])
    ? (r['entryPoints'] as unknown[]).flatMap((e) => {
      if (e === null || typeof e !== 'object') return []
      const o = e as Record<string, unknown>
      const symbol = str(o['symbol']); const path = cleanPath(o['path']); const role = str(o['role'])
      return symbol !== null && path !== null && path !== '' && role !== null ? [{ symbol, path, role }] : []
    })
    : []
  const flows = Array.isArray(r['flows'])
    ? (r['flows'] as unknown[]).flatMap((f) => {
      if (f === null || typeof f !== 'object') return []
      const name = str((f as Record<string, unknown>)['name'])
      const steps = (parseStrings(f, 'steps') ?? []).map(unnumber).filter((s) => s !== '')
      return name !== null && name !== '' ? [{ name, steps }] : []
    })
    : []
  return { purpose, entryPoints, flows, interactions: parseStrings(raw, 'interactions') ?? [] }
}

export function parseProjectNote(raw: unknown): Omit<ProjectNote, 'kind' | 'hash' | 'builtAt' | 'model'> | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const overview = str(r['overview'])
  if (overview === null || overview === '') return null
  const pairs = (key: string, second: 'role' | 'why'): { path: string; role: string }[] | { path: string; why: string }[] => {
    const arr = r[key]
    if (!Array.isArray(arr)) return []
    return arr.flatMap((e) => {
      if (e === null || typeof e !== 'object') return []
      const path = cleanPath((e as Record<string, unknown>)['path'])
      const text = str((e as Record<string, unknown>)[second])
      // The root is a legitimate subsystem ('' after cleaning) — only an absent path is dropped.
      return path !== null && text !== null ? [{ path, [second]: text } as never] : []
    })
  }
  return {
    overview,
    subsystems: pairs('subsystems', 'role') as { path: string; role: string }[],
    conventions: parseStrings(raw, 'conventions') ?? [],
    startHere: pairs('startHere', 'why') as { path: string; why: string }[],
  }
}

function parseQuestions(raw: unknown): { q: string; a: string }[] | null {
  if (raw === null || typeof raw !== 'object') return null
  const arr = (raw as Record<string, unknown>)['questions']
  if (!Array.isArray(arr)) return null
  const out = arr.flatMap((e) => {
    if (e === null || typeof e !== 'object') return []
    const q = str((e as Record<string, unknown>)['q']); const a = str((e as Record<string, unknown>)['a'])
    return q !== null && q !== '' && a !== null ? [{ q, a }] : []
  })
  return out.length === 0 ? null : out
}

/** True when a map folder exists with an index — what decides whether the prompt mentions it. */
export function mapExists(dir: string): boolean {
  return existsSync(join(dir, 'index.json'))
}
