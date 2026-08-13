import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR, ensurePrivateDir, statePath } from '../private-dir.js'
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
 *
 * Also returns `lineOffset`: the number of FILE lines (0-based `lastMarkerLine + 1`, i.e.
 * everything up to and including the marker) that sit before the returned `text` -- so a
 * caller feeding `text` into `Transcript.fromJSONL` can report a corrupt line's number
 * against the actual file, not just against this post-marker slice. Zero when there was
 * no marker at all (the common case), since then `text` IS the whole file.
 *
 * And the marker itself, which this scan has always found and always thrown away. It is the
 * only surviving record of how much history the returned `text` is standing in for: the
 * live messages open on a briefing whose own message cannot say how many messages it
 * replaced. A restored session that did not carry it forward presented the briefing as a
 * user's own words -- see `replayEntries`.
 */
function liveTextAfterLastMarker(
  text: string,
): { text: string; lineOffset: number; marker: CompactionMarker | null } {
  const lines = text.split('\n')
  let lastMarkerLine = -1
  let marker: CompactionMarker | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isCompactionMarker(parsed)) {
        lastMarkerLine = i
        marker = parsed
      }
    } catch {
      // Not a marker -- see doc comment above.
    }
  }
  if (lastMarkerLine === -1) return { text, lineOffset: 0, marker: null }
  return { text: lines.slice(lastMarkerLine + 1).join('\n'), lineOffset: lastMarkerLine + 1, marker }
}

/**
 * On-disk home for multi-turn sessions: `<workspaceRoot>/.privatecode/sessions/`, one
 * `<id>.jsonl` (the transcript, one JSON message per line, appended incrementally as the
 * conversation grows) and one `<id>.meta.json` (pretty-printed) per session.
 *
 * Compaction (Task 9) adds one more kind of line to the `.jsonl`: a `CompactionMarker`,
 * written by `appendCompactionSwap` at swap time, immediately followed by the ENTIRE new
 * (post-swap) transcript's messages -- marker and messages built into ONE string and
 * written with ONE `appendFileSync` call, never two, so a crash or throw mid-swap either
 * lands the whole block or none of it (a marker line with no payload after it, from two
 * separate writes torn apart by a crash, would make `load()` rebuild an empty session --
 * see `appendCompactionSwap`'s doc comment). The marker line is never a `ChatMessage` and
 * is never fed to `Transcript.fromJSONL` -- `load()` strips everything up to and
 * including the LAST marker before parsing, so the file keeps growing (nothing already
 * written is ever edited or removed -- append-only, same law as `Transcript` itself)
 * while `load()` always rebuilds exactly the live post-swap state, never the history a
 * marker folded away.
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

  constructor(private readonly workspaceRoot: string) {
    this.dir = statePath(workspaceRoot, 'sessions')
  }

  private ensureDir(): void {
    // Not a bare mkdir: `.privatecode/` also gets a self-ignore so this tool's state never
    // shows up in the user's `git status`. See private-dir.ts.
    ensurePrivateDir(this.workspaceRoot, join(STATE_DIR, 'sessions'))
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
  load(id: string): { meta: SessionMeta; transcript: Transcript; compaction: CompactionMarker | null } {
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
    const live = liveTextAfterLastMarker(text)
    const transcript = Transcript.fromJSONL(live.text, live.lineOffset)
    // `compaction` describes the transcript being returned, not the session's whole history:
    // it is the LAST swap, the one the live messages open on. Null for the common case of a
    // session that never compacted.
    return { meta, transcript, compaction: live.marker }
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
   * Writes one whole compaction swap -- the marker line immediately followed by the
   * ENTIRE swapped-in transcript's messages -- built into ONE string and written with ONE
   * `appendFileSync` call. This is the fix for a real hazard in the two-call form this
   * replaced (marker via one `appendFileSync`, then messages via another): a crash, or a
   * throw from the second call, between the two writes would leave a marker on disk with
   * nothing (or only a LATER swap's messages, if this ever fired twice) after it --
   * `load()`'s last-marker slicing would then rebuild an empty, or system-message-less,
   * session from a file that looks superficially fine. Building one string first means
   * the write either lands whole or (if `appendFileSync` itself throws, e.g. an
   * unwritable path) not at all -- never half; a caller that catches the throw keeps
   * running on the OLD in-memory transcript, which is exactly what `Session` does.
   */
  appendCompactionSwap(
    id: string,
    marker: { summary: string; droppedMessages: number },
    messages: readonly ChatMessage[],
  ): void {
    this.ensureDir()
    const markerLine: CompactionMarker = {
      __event: 'compaction',
      summary: marker.summary,
      droppedMessages: marker.droppedMessages,
      at: new Date().toISOString(),
    }
    const block = `${JSON.stringify(markerLine)}\n` +
      messages.map((m) => `${JSON.stringify(m)}\n`).join('')
    appendFileSync(this.jsonlPath(id), block)
  }
}
