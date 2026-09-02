import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRIVATE_DIR } from '../private-dir.js'

/**
 * What the agent has worked out about this project, and cannot quietly get wrong.
 *
 * `AGENTS.md` is what the USER wrote and is static. The repository map is derived and
 * structural. Neither accumulates what a session LEARNED — so working on the same project
 * every day, the agent re-derives the same architecture from the same files every time, and
 * a measured two thirds of a long run's wall clock goes into that re-derivation.
 *
 * The obvious fix is a file the agent appends to, and the obvious failure is that the file
 * becomes folklore: confident sentences about code that has since changed, which are worse
 * than no file at all because they are read first and trusted.
 *
 * So the whole design is one rule: **a note must name the files it was learned from, and it
 * dies when they change.** Each note records a content hash per file; loading re-hashes and
 * drops any note whose evidence moved. A note that names no files cannot be stored at all —
 * an unfalsifiable claim is exactly the thing this must not accumulate.
 *
 * That is what makes it safe to let the model write here on its own, which is the point:
 * knowledge that needs a human in the loop to be recorded does not get recorded.
 */

const NOTES_FILE = 'project-notes.md'

/** Permanent prompt cost, like the other message-0 blocks. ~10k tokens at worst — sized
 * to fit a couple of full-length notes plus the usual short ones, per the project's own
 * caps rule: watched live, the model kept losing genuinely important long write-ups to a
 * 400-char cap, and a note that cannot be recorded is a session re-deriving it tomorrow. */
const NOTES_BUDGET = 40_000
/** Past this the file is not a set of notes, it is a wiki nobody reads. Oldest go first. */
const MAX_NOTES = 60
/** Long enough for a real write-up (a subsystem map, a measured law with its numbers);
 * the refusal message still nudges toward the fact itself. */
const MAX_NOTE_CHARS = 20_000
/** Past this a note renders as an indented block instead of one bullet line: flattening a
 * page of structured prose into a single line destroys exactly the structure that made it
 * worth recording. */
const LONG_NOTE_CHARS = 200
/** Evidence beyond this is not evidence, it is a directory listing. */
const MAX_FILES_PER_NOTE = 6

export interface ProjectNote {
  text: string
  /** Workspace-relative paths this was learned from, with their hash at that time. */
  evidence: { path: string; hash: string }[]
  /** ISO date, for eviction order and for the reader. */
  learned: string
}

export interface LoadedNotes {
  /** Notes whose evidence still hashes the same. These are the only ones the model sees. */
  fresh: ProjectNote[]
  /** Notes whose files changed or vanished. Kept in the file, kept out of the prompt. */
  stale: ProjectNote[]
  problems: string[]
  /** The block for the system message, or '' when there is nothing fresh to say. */
  text: string
}

export function notesPath(workspaceRoot: string): string {
  return join(workspaceRoot, PRIVATE_DIR, NOTES_FILE)
}

/** First 12 hex characters of the SHA-256 of the file's bytes — enough that a change is
 * certain to show and short enough to read in the file. */
function hashFile(absolute: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(absolute)).digest('hex').slice(0, 12)
  } catch {
    return null
  }
}

/**
 * How an evidence path becomes a file on disk. The `Workspace` in production — and it has
 * to be, because a workspace-addressed path is NOT a path relative to the primary folder.
 *
 * This was the whole of the "none of those files could be read" bug. Evidence was located
 * with `join(workspaceRoot, path)`, and `workspaceRoot` is the FIRST folder; in a
 * multi-folder workspace every path the model has ever seen carries its folder's name
 * (`api/src/server.ts`), because that is how `Workspace.display` writes them. Joining that
 * onto the primary folder produced `…/primary/api/src/server.ts`, which exists nowhere —
 * so every note naming a real file was refused, in exactly the workspaces where notes are
 * worth most. An absolute path failed the same way. `Workspace.resolve` is the one thing
 * that already knows all of this, jail included.
 */
export interface EvidenceLocator {
  /** Throws for a path outside the workspace, which is a miss, not a crash. */
  resolve(relativePath: string): string
}

function locate(
  workspaceRoot: string, rel: string, where: EvidenceLocator | undefined,
): string | null {
  // No locator is the CLI's one-shot mode and the tests that predate this: one folder,
  // where a plain join is the same answer.
  if (where === undefined) return join(workspaceRoot, rel)
  try {
    return where.resolve(rel)
  } catch {
    return null
  }
}

const EVIDENCE = /^<!-- from: (.+) -->$/

/**
 * Markdown, because a person has to be able to read and delete these.
 *
 * Each note is a `## ` heading with its body, followed by one HTML comment carrying the
 * evidence. The comment is invisible in any renderer and trivially parseable, so the file is
 * a document first and a data structure second — which is the right way round for something
 * whose main safety property is that a human can look at it.
 */
function renderNotes(notes: readonly ProjectNote[]): string {
  const lines = [
    '# What PrivateCode has learned about this project',
    '',
    'Written by the agent as it works. Every note names the files it was learned from and the',
    'content hash of each at that moment — when one of those files changes, the note stops',
    'being loaded, so nothing here can quietly describe code that has moved on.',
    '',
    'Delete anything that is wrong or no longer interesting; it will not come back unless it',
    'is learned again.',
    '',
  ]
  for (const note of notes) {
    lines.push(`## ${note.learned}`, note.text,
      `<!-- from: ${note.evidence.map((e) => `${e.path}@${e.hash}`).join(' ')} -->`, '')
  }
  return lines.join('\n')
}

function parseNotes(text: string): ProjectNote[] {
  const notes: ProjectNote[] = []
  const blocks = text.split(/^## /m).slice(1)
  for (const block of blocks) {
    const lines = block.split('\n')
    const learned = (lines.shift() ?? '').trim()
    const evidenceLine = lines.find((l) => EVIDENCE.test(l.trim()))
    if (evidenceLine === undefined) continue
    const body = lines.filter((l) => !EVIDENCE.test(l.trim())).join('\n').trim()
    if (body === '') continue
    const evidence = (EVIDENCE.exec(evidenceLine.trim())?.[1] ?? '').split(/\s+/)
      .map((token) => {
        const at = token.lastIndexOf('@')
        return at === -1 ? null : { path: token.slice(0, at), hash: token.slice(at + 1) }
      })
      .filter((e): e is { path: string; hash: string } => e !== null)
    if (evidence.length === 0) continue
    notes.push({ text: body, evidence, learned })
  }
  return notes
}

/**
 * Reads the notes and re-checks every one against the code it claims to describe.
 *
 * Never throws. A missing file is the normal state; an unreadable or malformed one yields
 * no notes and a problem, because the alternative — guessing at half a parse — is how a
 * note ends up in the prompt with the wrong evidence attached.
 */
export function loadProjectNotes(workspaceRoot: string, where?: EvidenceLocator): LoadedNotes {
  const problems: string[] = []
  const path = notesPath(workspaceRoot)
  if (!existsSync(path)) return { fresh: [], stale: [], problems, text: '' }

  let parsed: ProjectNote[]
  try {
    parsed = parseNotes(readFileSync(path, 'utf8'))
  } catch (e) {
    problems.push(`Could not read ${PRIVATE_DIR}/${NOTES_FILE}: ${(e as Error).message}`)
    return { fresh: [], stale: [], problems, text: '' }
  }

  const fresh: ProjectNote[] = []
  const stale: ProjectNote[] = []
  for (const note of parsed) {
    // Located the same way it was stored. Locating it differently is how a note that is
    // perfectly fresh reads as stale and silently stops being loaded.
    const unchanged = note.evidence.every((e) => {
      const abs = locate(workspaceRoot, e.path, where)
      return abs !== null && hashFile(abs) === e.hash
    })
    ;(unchanged ? fresh : stale).push(note)
  }

  return { fresh, stale, problems, text: frame(fresh, stale.length) }
}

/**
 * The framing. Load-bearing in the same way `project-memory.ts`'s is, and for one more
 * reason: these sentences were written by the model itself, and it must not read its own
 * past conclusions as though they were the code. They are a head start, not an authority.
 */
function frame(fresh: readonly ProjectNote[], staleCount: number): string {
  if (fresh.length === 0) return ''
  const parts = [
    '--- What you have learned about this project ---',
    'Notes you wrote in earlier sessions, each still matching the code it came from — any',
    'whose files changed have been dropped. Use them to skip re-deriving what you already',
    'worked out. They are a head start, not an authority: if one contradicts the code in',
    'front of you, the code is right and the note is out of date.',
    '',
  ]
  let used = 0
  let shown = 0
  // Newest first: the most recent understanding is the most likely to still be true.
  for (const note of [...fresh].reverse()) {
    const files = note.evidence.map((e) => e.path).join(', ')
    // A short note is a bullet; a long one keeps its own lines, indented under its files —
    // flattening a page of structured prose destroys exactly the structure that made it
    // worth recording at 20k instead of 400.
    const line = note.text.length <= LONG_NOTE_CHARS
      ? `- ${note.text.replace(/\n+/g, ' ')} [${files}]`
      : `- [${files}]\n${note.text.split('\n').map((l) => `  ${l}`).join('\n')}`
    if (used + line.length > NOTES_BUDGET) break
    parts.push(line)
    used += line.length
    shown++
  }
  if (shown < fresh.length) parts.push(`(${fresh.length - shown} older notes not shown here.)`)
  if (staleCount > 0) {
    parts.push('', `(${staleCount} note(s) were dropped because the files they described have ` +
      'changed. If you re-establish one of those facts, record it again.)')
  }
  parts.push('--- end ---')
  return parts.join('\n')
}

export interface AddResult { ok: boolean; problem?: string; note?: ProjectNote }

/**
 * Appends one note, hashing its evidence now.
 *
 * Refuses a note with no readable evidence. That refusal is the whole safety property: a
 * claim that names no file can never be invalidated, so it would sit in the prompt forever
 * being trusted. Better to lose the note than to keep an immortal one.
 */
export function addProjectNote(
  workspaceRoot: string, text: string, files: readonly string[], where?: EvidenceLocator,
): AddResult {
  // A leading space neutralises the one sequence the file format reserves (`^## ` starts
  // the next note's block) while staying invisible in markdown. Long notes legitimately
  // contain headings; silently losing everything after one is not an option.
  const body = text.trim().replace(/^(#{1,6} )/gm, ' $1')
  if (body === '') return { ok: false, problem: 'a note needs some text' }
  if (body.length > MAX_NOTE_CHARS) {
    return { ok: false, problem: `a note must be under ${MAX_NOTE_CHARS} characters; this one is ${body.length}. Keep it to the fact itself.` }
  }
  if (files.length === 0) {
    return { ok: false, problem: 'a note must name the files it was learned from — a claim with no evidence can never be checked, so it is not stored' }
  }

  const evidence: { path: string; hash: string }[] = []
  const missing: string[] = []
  for (const raw of files.slice(0, MAX_FILES_PER_NOTE)) {
    const rel = raw.replace(/\\/g, '/').trim()
    const abs = locate(workspaceRoot, rel, where)
    const hash = abs === null ? null : hashFile(abs)
    if (hash === null) missing.push(rel)
    else evidence.push({ path: rel, hash })
  }
  if (evidence.length === 0) {
    return {
      ok: false,
      // Says what to do differently. The old wording named the files and stopped there,
      // which left one repair available — try again with the same paths — and that is what
      // it got, turn after turn.
      problem:
        `none of those files could be read (${missing.join(', ')}), so there is nothing to ` +
        'tie this note to. Name each file exactly as the tools address it — the same ' +
        'spelling Read and Grep use, folder prefix included in a multi-folder ' +
        'workspace — and only files that exist right now.',
    }
  }

  const existing = loadProjectNotes(workspaceRoot, where)
  const all = [...existing.stale, ...existing.fresh]
  const note: ProjectNote = { text: body, evidence, learned: new Date().toISOString().slice(0, 10) }
  // Oldest first out. A stale note is evicted before a fresh one: it has already been
  // superseded by the code.
  const kept = [...existing.stale, ...existing.fresh, note].slice(-MAX_NOTES)
  void all

  try {
    writeFileSync(notesPath(workspaceRoot), renderNotes(kept), 'utf8')
  } catch (e) {
    return { ok: false, problem: `could not write the notes file: ${(e as Error).message}` }
  }
  return { ok: true, note, ...(missing.length > 0 ? { problem: `ignored unreadable: ${missing.join(', ')}` } : {}) }
}
