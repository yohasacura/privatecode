import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OUTCOMES_SUFFIX, SESSIONS_DIR, STATE_DIR, ensurePrivateDir, planFileFor, safeSessionId, statePath,
} from '../private-dir.js'
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
  /** The distilled task contract, when this session carries a complex task — see
   * `session/contract.ts`. In the meta rather than the transcript because it must survive
   * every compaction swap verbatim and be re-promotable into each rebuilt system prompt. */
  contract?: import('./contract.js').TaskContract
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
    this.dir = statePath(workspaceRoot, SESSIONS_DIR)
  }

  private ensureDir(): void {
    // Not a bare mkdir: `.privatecode/` also gets a self-ignore so this tool's state never
    // shows up in the user's `git status`. See private-dir.ts.
    ensurePrivateDir(this.workspaceRoot, join(STATE_DIR, SESSIONS_DIR))
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
    // A malformed contract is DROPPED, not fatal: it reaches `renderContract` inside the
    // compaction swap and `checkAcceptance`'s prompt build, where a bad shape from a
    // hand-edited file would throw after the turn's work was already done. The session is
    // fine without it — it simply runs the way every session ran before contracts.
    if (obj.contract !== undefined) {
      const c = obj.contract as Partial<SessionMeta['contract'] & object>
      if (typeof c !== 'object' || c === null ||
          typeof c.goal !== 'string' || !Array.isArray(c.criteria) ||
          !c.criteria.every((x: unknown) => typeof x === 'string') ||
          !Array.isArray(c.constraints)) {
        delete (obj as { contract?: unknown }).contract
      }
    }
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

  /**
   * Best-effort, like `TodoStore.set` and for the same reason: what this session RUNS on is
   * the in-memory `meta`, and the file is how the next one starts.
   *
   * It used to throw. Several callers sit on paths where a throw is far more expensive than
   * a stale file — the premise and understanding gates call it from inside `onBeforeTool`,
   * which runs between an assistant tool-call message and the reply that answers it, so a
   * OneDrive lock, an AV hold or a full disk turned a lost checkpoint into an unanswered
   * call written to disk, poisoning every later request of the session. Losing the write
   * costs at most one re-run of a check on resume.
   */
  saveMeta(meta: SessionMeta): void {
    try {
      this.ensureDir()
      writeFileSync(this.metaPath(meta.id), JSON.stringify(meta, null, 2))
      this.lastWriteError = null
    } catch (e) {
      // Swallowed, and REMEMBERED. Swallowing is right — see above — but it used to lose the
      // signal as well as the write, and `list()` keys entirely off `*.meta.json`, so a
      // session whose very first save failed is a session that never appears in the rail at
      // all. It normally self-heals on one of the ~8 saves a turn makes; when it does not,
      // this is the only place that knows.
      this.lastWriteError = (e as Error).message
    }
  }

  /**
   * The last `saveMeta` failure, or null once one has succeeded.
   *
   * Read by whoever wants to tell the user their sessions are not being written down. Kept
   * as state rather than thrown because the alternative — failing the turn over a checkpoint
   * file — costs more than it saves; `appendMessages` still throws, so the transcript itself
   * is never silently lost.
   */
  lastWriteError: string | null = null

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

  /**
   * Everything ONE session owns on disk. Four files, written by four different modules, and
   * the reason they are enumerated here rather than at each site is that a "delete" which
   * misses one is worse than no delete at all: the rail stops listing the session while its
   * transcript stays on disk, so the person believes it is gone.
   *
   *   <id>.meta.json   this store — title, mode, contract; what `list()` reads
   *   <id>.jsonl       this store — the full transcript, the actual content
   *   <id>.ui.jsonl    host/replay.ts — per-call outcomes, so a restored view is not guesswork
   *   plan-<id>.json   interaction.ts — that session's todo plan, one level up in state/
   *
   * The last two are written by other modules, so their names moved into `private-dir.ts`
   * when this was added — one definition each, imported by both the writer and this. A
   * re-derived copy here would go stale silently, and the symptom of going stale is a file
   * left behind after a delete that reported success.
   */
  private ownedPaths(id: string): string[] {
    // Session ids are generated filename-safe, and this does not trust that. A `..` arriving
    // from a hand-edited file or a future id scheme must not let a delete walk out of the
    // sessions directory -- the same guard `TodoStore.file()` applies for the same reason.
    const safe = safeSessionId(id)
    return [
      join(this.dir, `${safe}.meta.json`),
      join(this.dir, `${safe}.jsonl`),
      join(this.dir, `${safe}${OUTCOMES_SUFFIX}`),
      statePath(this.workspaceRoot, planFileFor(safe)),
    ]
  }

  /**
   * Deletes one session and everything it owns.
   *
   * Returns what could not be removed, empty on success. Reported rather than thrown: three
   * of the four files are optional (a session that never ran has no transcript, one from
   * before outcomes existed has no `.ui.jsonl`), so "missing" is the ordinary case and only
   * a real refusal — a lock, a permission — is worth telling anyone about.
   *
   * Never call this for the LIVE session without tearing it down first. The running `Session`
   * appends to the transcript on every turn, so deleting underneath it recreates the file
   * moments later and leaves a half-session with no meta.
   */
  delete(id: string): { removed: number; problems: string[] } {
    const problems: string[] = []
    let removed = 0
    for (const path of this.ownedPaths(id)) {
      // Asked BEFORE the removal, because `force: true` makes a missing file a silent no-op
      // and counting the calls instead would report four removals for a session that was
      // never there. `removed` is what the caller uses to say whether anything happened.
      const wasThere = existsSync(path)
      try {
        // `maxRetries` because this is Windows: a virus scanner or an indexer holding a
        // handle for a moment is the ordinary reason a delete fails here, and it passes.
        rmSync(path, { force: true, maxRetries: 3, retryDelay: 50 })
        if (wasThere) removed++
      } catch (e) {
        problems.push(`${path}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return { removed, problems }
  }

  /**
   * Deletes every session this workspace has.
   *
   * Driven off the directory rather than off `list()`, because `list()` skips anything whose
   * meta is corrupt — and a session damaged enough to be unlistable is exactly the one a
   * person is trying to get rid of. Anything in `sessions/` shaped like a session file goes;
   * `ids` reports what was recognised so the caller can say how many.
   */
  deleteAll(): { ids: string[]; problems: string[] } {
    const { ids, problems } = this.storedIds()
    for (const id of ids) problems.push(...this.delete(id).problems)
    return { ids, problems }
  }

  /**
   * Which sessions exist on disk, INCLUDING ones `list()` will not show.
   *
   * Separate from `deleteAll` because the host needs the answer BEFORE it creates the
   * replacement session. Sweeping after the switch would include that replacement, and
   * deleting the live session's files underneath it is the one thing `delete` warns against;
   * "clear every conversation" would then leave the new one half-erased.
   */
  storedIds(): { ids: string[]; problems: string[] } {
    if (!existsSync(this.dir)) return { ids: [], problems: [] }
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch (e) {
      return { ids: [], problems: [`${this.dir}: ${e instanceof Error ? e.message : String(e)}`] }
    }
    const ids = new Set<string>()
    for (const name of names) {
      // `.ui.jsonl` is tested before `.jsonl`, since it ends in one.
      const id = name.endsWith('.meta.json') ? name.slice(0, -'.meta.json'.length)
        : name.endsWith(OUTCOMES_SUFFIX) ? name.slice(0, -OUTCOMES_SUFFIX.length)
        : name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length)
        : null
      if (id !== null && id !== '') ids.add(id)
    }
    return { ids: [...ids], problems: [] }
  }
}
