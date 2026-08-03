import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage } from '../llama/types.js'
import type { AgentMode } from '../permissions/engine.js'
import { Transcript } from '../transcript/transcript.js'

export interface SessionMeta {
  id: string
  title: string
  createdAt: string // ISO
  updatedAt: string // ISO
  workspaceRoot: string
  mode: AgentMode
}

/** One compaction swap's audit-trail marker line -- see the class doc comment below. */
export interface CompactionMarker {
  __event: 'compaction'
  summary: string
  droppedMessages: number
  at: string // ISO
}

function isCompactionMarker(parsed: unknown): parsed is CompactionMarker {
  return typeof parsed === 'object' && parsed !== null &&
    (parsed as { __event?: unknown }).__event === 'compaction'
}

/**
 * The `.jsonl` file is the FULL audit trail, never trimmed -- but everything up to and
 * including the LAST compaction marker is history, not live state. Only the lines after it
 * are the transcript a resumed `Session` actually rebuilds. With no marker at all (the
 * common case: most sessions never compact) this returns the whole text unchanged.
 *
 * A line that fails to parse as JSON, or parses but isn't a marker, is simply not a
 * marker -- it is left for `Transcript.fromJSONL`'s own pass to validate (and to report,
 * with a precise line number, if it turns out to be corrupt); this scan only ever needs
 * to find markers, so it tolerates everything else silently.
 */
function liveTextAfterLastMarker(text: string): string {
  const lines = text.split('\n')
  let lastMarkerLine = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim()) continue
    try {
      if (isCompactionMarker(JSON.parse(line))) lastMarkerLine = i
    } catch {
      // Not a marker -- see doc comment above.
    }
  }
  if (lastMarkerLine === -1) return text
  return lines.slice(lastMarkerLine + 1).join('\n')
}

/**
 * On-disk home for multi-turn sessions: `<workspaceRoot>/.privatecode/sessions/`, one
 * `<id>.jsonl` (the transcript, one JSON message per line, appended incrementally as the
 * conversation grows) and one `<id>.meta.json` (pretty-printed) per session.
 *
 * Compaction (Task 9) adds one more kind of line to the `.jsonl`: a `CompactionMarker`,
 * written by `appendCompactionMarker` at swap time, immediately followed by the ENTIRE
 * new (post-swap) transcript's messages appended as ordinary fresh lines via
 * `appendMessages`. The marker line is never a `ChatMessage` and is never fed to
 * `Transcript.fromJSONL` -- `load()` strips everything up to and including the LAST
 * marker before parsing, so the file keeps growing (nothing already written is ever
 * edited or removed -- append-only, same law as `Transcript` itself) while `load()`
 * always rebuilds exactly the live post-swap state, never the history a marker folded
 * away.
 *
 * This directory is workspace-internal state, not a model-directed path -- tools may read
 * it freely and it is deliberately outside the `Workspace` jail (which exists to bound
 * what a *model* can reach, not what the host application manages on the model's behalf).
 * Plain synchronous `node:fs` calls are used throughout for the same reason.
 */
export class SessionStore {
  /**
   * Problems found by the most recent `list()` call only -- each call clears and
   * repopulates this array, it does not accumulate across calls. `load()` never writes
   * here: a single session failing to load is the caller's problem to handle (it throws),
   * not a background diagnostic.
   */
  readonly problems: string[] = []

  private readonly dir: string

  constructor(workspaceRoot: string) {
    this.dir = join(workspaceRoot, '.privatecode', 'sessions')
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true })
  }

  private metaPath(id: string): string {
    return join(this.dir, `${id}.meta.json`)
  }

  private jsonlPath(id: string): string {
    return join(this.dir, `${id}.jsonl`)
  }

  /**
   * Validates that a parsed object has all required SessionMeta fields with correct types.
   * Returns a non-empty string describing the first missing/malformed field, or empty string
   * if valid.
   */
  private validateMeta(parsed: unknown): string {
    const obj = parsed as Partial<SessionMeta>
    if (typeof obj.id !== 'string') return 'id'
    if (typeof obj.title !== 'string') return 'title'
    if (typeof obj.createdAt !== 'string') return 'createdAt'
    if (typeof obj.updatedAt !== 'string') return 'updatedAt'
    if (typeof obj.workspaceRoot !== 'string') return 'workspaceRoot'
    if (typeof obj.mode !== 'string') return 'mode'
    return ''
  }

  /**
   * Every session's metadata, most-recently-updated first. A `*.meta.json` that fails to
   * read, fails to parse, or is missing a required field is skipped and recorded in
   * `problems` instead of aborting the whole listing -- one damaged file must not hide
   * every other session from the picker.
   */
  list(): SessionMeta[] {
    this.problems.length = 0
    if (!existsSync(this.dir)) return []

    const metas: SessionMeta[] = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.meta.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(join(this.dir, name), 'utf8'))
        const invalid = this.validateMeta(parsed)
        if (invalid) {
          this.problems.push(`${name}: missing or malformed session metadata fields, skipped`)
          continue
        }
        metas.push(parsed as SessionMeta)
      } catch (e) {
        this.problems.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // Newest first, by string comparison rather than Date parsing -- every timestamp this
    // store ever writes is `Date.toISOString()`, which sorts correctly as plain text.
    metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    return metas
  }

  /**
   * Loads one session's metadata and full transcript. Throws with a specific, actionable
   * message -- never returns something half-valid -- on a missing session, corrupt
   * metadata JSON, or (via `Transcript.fromJSONL`) a corrupt transcript line: replaying a
   * transcript that silently dropped or misread an entry would be worse than refusing to
   * load it at all.
   */
  load(id: string): { meta: SessionMeta; transcript: Transcript } {
    const metaFile = this.metaPath(id)
    if (!existsSync(metaFile)) {
      throw new Error(`session "${id}" not found: no ${id}.meta.json in ${this.dir}`)
    }
    let meta: SessionMeta
    try {
      const parsed = JSON.parse(readFileSync(metaFile, 'utf8'))
      const invalid = this.validateMeta(parsed)
      if (invalid) {
        throw new Error(
          `session ${id} has a corrupt meta file (${invalid}); delete ${metaFile} to discard it`,
        )
      }
      meta = parsed as SessionMeta
    } catch (e) {
      if (e instanceof Error && e.message.includes('corrupt meta file')) {
        throw e
      }
      throw new Error(
        `session "${id}" metadata is corrupt (${metaFile}): ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    const jsonlFile = this.jsonlPath(id)
    const text = existsSync(jsonlFile) ? readFileSync(jsonlFile, 'utf8') : ''
    const transcript = Transcript.fromJSONL(liveTextAfterLastMarker(text))
    return { meta, transcript }
  }

  saveMeta(meta: SessionMeta): void {
    this.ensureDir()
    writeFileSync(this.metaPath(meta.id), JSON.stringify(meta, null, 2))
  }

  /**
   * Appends new messages as JSONL lines, one `JSON.stringify`'d message per line. A call
   * with nothing new is a no-op that does not even touch the file (so a turn that
   * produced no new messages, e.g. an already-aborted send, never creates an empty file).
   */
  appendMessages(id: string, messages: readonly ChatMessage[]): void {
    if (messages.length === 0) return
    this.ensureDir()
    const lines = messages.map((m) => `${JSON.stringify(m)}\n`).join('')
    appendFileSync(this.jsonlPath(id), lines)
  }

  /**
   * Writes one compaction-swap marker line -- see the class doc comment. Always called
   * (by `Session`) immediately before an `appendMessages` call carrying the entire
   * swapped-in transcript, so the marker and its fresh lines land together, in order, in
   * one uninterrupted block.
   */
  appendCompactionMarker(id: string, info: { summary: string; droppedMessages: number }): void {
    this.ensureDir()
    const marker: CompactionMarker = {
      __event: 'compaction',
      summary: info.summary,
      droppedMessages: info.droppedMessages,
      at: new Date().toISOString(),
    }
    appendFileSync(this.jsonlPath(id), `${JSON.stringify(marker)}\n`)
  }
}
