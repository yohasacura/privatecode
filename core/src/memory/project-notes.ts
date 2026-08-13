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

export const NOTES_FILE = 'project-notes.md'

/** Permanent prompt cost, like the other message-0 blocks. ~750 tokens. */
const NOTES_BUDGET = 3_000
/** Past this the file is not a set of notes, it is a wiki nobody reads. Oldest go first. */
const MAX_NOTES = 60
/** A note is a paragraph, not a document. */
const MAX_NOTE_CHARS = 400
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
export function hashFile(absolute: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(absolute)).digest('hex').slice(0, 12)
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
export function renderNotes(notes: readonly ProjectNote[]): string {
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
export function loadProjectNotes(workspaceRoot: string): LoadedNotes {
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
    const unchanged = note.evidence.every((e) => hashFile(join(workspaceRoot, e.path)) === e.hash)
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
    const line = `- ${note.text.replace(/\n+/g, ' ')} [${note.evidence.map((e) => e.path).join(', ')}]`
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
  workspaceRoot: string, text: string, files: readonly string[],
): AddResult {
  const body = text.trim()
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
    const hash = hashFile(join(workspaceRoot, rel))
    if (hash === null) missing.push(rel)
    else evidence.push({ path: rel, hash })
  }
  if (evidence.length === 0) {
    return {
      ok: false,
      problem: `none of those files could be read (${missing.join(', ')}), so there is nothing to tie this note to`,
    }
  }

  const existing = loadProjectNotes(workspaceRoot)
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
