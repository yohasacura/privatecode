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

/**
 * On-disk home for multi-turn sessions: `<workspaceRoot>/.privatecode/sessions/`, one
 * `<id>.jsonl` (the transcript, one JSON message per line, appended incrementally as the
 * conversation grows) and one `<id>.meta.json` (pretty-printed) per session.
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
        const parsed = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as Partial<SessionMeta>
        if (
          typeof parsed.id !== 'string' ||
          typeof parsed.title !== 'string' ||
          typeof parsed.createdAt !== 'string' ||
          typeof parsed.updatedAt !== 'string' ||
          typeof parsed.workspaceRoot !== 'string' ||
          typeof parsed.mode !== 'string'
        ) {
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
      meta = JSON.parse(readFileSync(metaFile, 'utf8')) as SessionMeta
    } catch (e) {
      throw new Error(
        `session "${id}" metadata is corrupt (${metaFile}): ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    const jsonlFile = this.jsonlPath(id)
    const text = existsSync(jsonlFile) ? readFileSync(jsonlFile, 'utf8') : ''
    const transcript = Transcript.fromJSONL(text)
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
}
