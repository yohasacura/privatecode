import { readFileSync } from 'node:fs'
import { statePath } from '../private-dir.js'
import type { SessionMeta } from '../session/store.js'

/**
 * Finding the conversation where you did this before.
 *
 * Sessions were found by eye, down a list of titles taken from their first message — which
 * is the worst possible summary of what a long session turned into. The thing you remember
 * is never the opening line; it is a file name, an error string, a command that finally
 * worked.
 *
 * Plain substring matching over the stored transcripts, not an index: a few hundred sessions
 * of a few hundred kilobytes is milliseconds to scan, and an index would be a second copy of
 * the truth to keep in step with an append-only file. If this ever gets slow, ripgrep is
 * already a dependency.
 *
 * It grew a second caller — the MODEL, through `search_history` — which wants the same scan
 * asked different questions: as a regular expression, from one speaker, inside one session,
 * since a date. Those are `SearchOptions`, and every one of them defaults to exactly what
 * the palette has always done, so the picker's behaviour is unchanged by construction.
 */

/** Per session, so one enormous transcript cannot make a search feel broken. */
const MAX_SCAN_BYTES = 4 * 1024 * 1024
const SNIPPET_CONTEXT = 60

/**
 * Wall-clock ceiling on one search.
 *
 * Substring scanning cannot run away, but a model-written REGULAR EXPRESSION can:
 * JavaScript's engine backtracks, and `(a+)+b` over a few megabytes of transcript does not
 * finish this year. `search_code` has no such problem because ripgrep's engine has no
 * backtracking; this one does, so the guard is a clock rather than a promise. Partial
 * results are returned and SAID to be partial — a search that quietly stopped early is the
 * one failure worse than a slow one.
 */
const SEARCH_BUDGET_MS = 3_000

export interface SessionHit {
  sessionId: string
  title: string
  updatedAt: string
  /** How many messages matched — a session that mentions it once and one that is about it. */
  count: number
  /** The first match, with a little text either side. */
  snippet: string
  /** Every kept match, `snippet` included and first. One entry unless the caller asked for
   * more — see `SearchOptions`. */
  snippets: string[]
}

export interface SearchOptions {
  /**
   * How many matching passages to keep per session, and how much text either side.
   *
   * The palette's defaults are one short snippet: it is a picker, and the row only has to be
   * recognisable enough to click. The model reading the answer wants the opposite — it is
   * not choosing a row, it is trying to remember what was decided, and one collapsed
   * 120-character line rarely carries a decision.
   */
  snippets?: number
  context?: number
  /** Treat the query as a regular expression rather than a literal. Case-insensitive either
   * way; an unparseable pattern is reported rather than silently matching nothing. */
  regex?: boolean
  /**
   * Whose words to search.
   *
   * "Where did I ask for this" and "where did I explain this" are different questions with
   * different answers, and asking them separately is most of what makes a search of a
   * conversation better than a search of a file.
   */
  speaker?: 'user' | 'assistant' | 'any'
  /** Only sessions updated at or after this ISO timestamp. */
  since?: string
  /** Only sessions updated at or before this ISO timestamp. */
  until?: string
  /** Only this session — the "what did we decide twenty steps ago" case, after the middle
   * of the conversation has been compacted away. */
  sessionId?: string
  /**
   * Search tool RESULTS too.
   *
   * Off by default and worth keeping off: results are the bulk of a transcript by an order
   * of magnitude, so a search for `stats.ts` that matched every directory listing containing
   * it would return every session ever, ranked by nothing. On, it answers a real and
   * different question — which session ran that command, which one saw that error.
   */
  includeToolResults?: boolean
}

export interface SearchOutcome {
  hits: SessionHit[]
  /** Set when the scan hit its clock or a session was clipped, so the caller can say the
   * answer is partial instead of presenting it as complete. */
  problem?: string
}

/** One line of context around the match, collapsed: a transcript line can be a 2000-line
 * file dump, and a snippet that pastes half of it is not a search result. */
function snippetAround(text: string, at: number, length: number, context: number): string {
  const from = Math.max(0, at - context)
  const to = Math.min(text.length, at + length + context)
  const cut = text.slice(from, to).replace(/\s+/g, ' ').trim()
  return `${from > 0 ? '…' : ''}${cut}${to < text.length ? '…' : ''}`
}

/** Where the needle is in this text, and how long the match is — or null. One shape for
 * both modes, so everything downstream is written once. */
type Finder = (text: string) => { at: number; length: number } | null

function makeFinder(query: string, regex: boolean): Finder | { problem: string } {
  if (!regex) {
    const needle = query.toLowerCase()
    return (text) => {
      const at = text.toLowerCase().indexOf(needle)
      return at === -1 ? null : { at, length: needle.length }
    }
  }
  let re: RegExp
  try {
    // Not global: the state a `g` flag carries between calls is exactly the bug that makes
    // every other search silently miss.
    re = new RegExp(query, 'i')
  } catch (e) {
    return { problem: `that is not a valid regular expression: ${(e as Error).message}` }
  }
  return (text) => {
    const m = re.exec(text)
    return m === null ? null : { at: m.index, length: m[0].length }
  }
}

/**
 * Searches stored sessions for `query`.
 *
 * Only what a PERSON said or was told is searched by default — user text and assistant
 * answers. Tool results are excluded on purpose; see `SearchOptions.includeToolResults`.
 */
export function searchSessions(
  workspaceRoot: string, metas: readonly SessionMeta[], query: string, limit = 20,
  options: SearchOptions = {},
): SessionHit[] {
  return searchSessionsDetailed(workspaceRoot, metas, query, limit, options).hits
}

/** The same search, with whatever went wrong alongside the results. */
export function searchSessionsDetailed(
  workspaceRoot: string, metas: readonly SessionMeta[], query: string, limit = 20,
  options: SearchOptions = {},
): SearchOutcome {
  const trimmed = query.trim()
  if (trimmed === '') return { hits: [] }

  const finder = makeFinder(trimmed, options.regex === true)
  if (typeof finder !== 'function') return { hits: [], problem: finder.problem }

  const wanted = Math.max(1, options.snippets ?? 1)
  const around = Math.max(1, options.context ?? SNIPPET_CONTEXT)
  const speaker = options.speaker ?? 'any'
  const deadline = Date.now() + SEARCH_BUDGET_MS

  const roles = new Set<string>(
    speaker === 'any' ? ['user', 'assistant'] : [speaker],
  )
  if (options.includeToolResults === true) roles.add('tool')

  // Narrowed BEFORE any file is opened: a date range or one session id is the cheapest
  // filter there is, and applying it after the scan would pay for reading transcripts the
  // caller had already ruled out.
  const chosen = metas.filter((m) => {
    if (options.sessionId !== undefined && m.id !== options.sessionId) return false
    if (options.since !== undefined && m.updatedAt < options.since) return false
    if (options.until !== undefined && m.updatedAt > options.until) return false
    return true
  })

  const hits: SessionHit[] = []
  let clipped = 0
  let ranOut = false

  for (const meta of chosen) {
    if (Date.now() > deadline) { ranOut = true; break }
    let raw: string
    try {
      raw = readFileSync(statePath(workspaceRoot, 'sessions', `${meta.id}.jsonl`), 'utf8')
    } catch {
      continue // a session with no transcript on disk is not an error, just nothing to search
    }
    if (raw.length > MAX_SCAN_BYTES) { raw = raw.slice(0, MAX_SCAN_BYTES); clipped++ }

    let count = 0
    const found: string[] = []
    for (const line of raw.split('\n')) {
      if (line === '') continue
      // Checked per LINE, not per session: one transcript can be four megabytes, and a
      // pathological regex reaches its budget inside a single file.
      if (Date.now() > deadline) { ranOut = true; break }
      let msg: { role?: string; content?: unknown }
      try {
        msg = JSON.parse(line) as { role?: string; content?: unknown }
      } catch {
        continue
      }
      if (typeof msg.role !== 'string' || !roles.has(msg.role)) continue
      if (typeof msg.content !== 'string' || msg.content === '') continue
      const m = finder(msg.content)
      if (m === null) continue
      count++
      if (found.length < wanted) found.push(snippetAround(msg.content, m.at, m.length, around))
    }
    if (count > 0) {
      hits.push({
        sessionId: meta.id, title: meta.title, updatedAt: meta.updatedAt, count,
        // `snippet` stays the FIRST one, so every existing caller reads exactly what it
        // always did; `snippets` is the whole set for callers that asked for more.
        snippet: found[0] ?? '', snippets: found,
      })
    }
    if (ranOut) break
  }

  // Most mentions first, then most recent: a session that discussed the thing at length
  // beats one that mentioned it once, and yesterday beats last month.
  hits.sort((a, b) => (b.count - a.count) || (a.updatedAt < b.updatedAt ? 1 : -1))

  const problems: string[] = []
  if (ranOut) {
    problems.push(
      `the search ran past ${SEARCH_BUDGET_MS / 1000}s and stopped early, so this is a ` +
      'partial answer — narrow it with a session, a date or a simpler pattern',
    )
  }
  if (clipped > 0) {
    problems.push(
      `${clipped} transcript${clipped === 1 ? ' was' : 's were'} too large to scan whole and ` +
      'only the first few megabytes were searched',
    )
  }
  return {
    hits: hits.slice(0, limit),
    ...(problems.length > 0 ? { problem: problems.join('; ') } : {}),
  }
}
