import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRIVATE_DIR } from '../private-dir.js'
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
 */

/** Per session, so one enormous transcript cannot make a search feel broken. */
const MAX_SCAN_BYTES = 4 * 1024 * 1024
const SNIPPET_CONTEXT = 60

export interface SessionHit {
  sessionId: string
  title: string
  updatedAt: string
  /** How many messages matched — a session that mentions it once and one that is about it. */
  count: number
  /** The first match, with a little text either side. */
  snippet: string
}

/** One line of context around the match, collapsed: a transcript line can be a 2000-line
 * file dump, and a snippet that pastes half of it is not a search result. */
function snippetAround(text: string, at: number, query: string): string {
  const from = Math.max(0, at - SNIPPET_CONTEXT)
  const to = Math.min(text.length, at + query.length + SNIPPET_CONTEXT)
  const cut = text.slice(from, to).replace(/\s+/g, ' ').trim()
  return `${from > 0 ? '…' : ''}${cut}${to < text.length ? '…' : ''}`
}

/**
 * Searches every stored session for `query`.
 *
 * Only what a PERSON said or was told is searched — user text and assistant answers. Tool
 * results are excluded on purpose: they are the bulk of a transcript by an order of
 * magnitude, and a search for `stats.ts` that matched every directory listing which happened
 * to contain it would return every session ever, ranked by nothing.
 */
export function searchSessions(
  workspaceRoot: string, metas: readonly SessionMeta[], query: string, limit = 20,
): SessionHit[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []

  const hits: SessionHit[] = []
  for (const meta of metas) {
    let raw: string
    try {
      raw = readFileSync(join(workspaceRoot, PRIVATE_DIR, 'sessions', `${meta.id}.jsonl`), 'utf8')
    } catch {
      continue // a session with no transcript on disk is not an error, just nothing to search
    }
    if (raw.length > MAX_SCAN_BYTES) raw = raw.slice(0, MAX_SCAN_BYTES)

    let count = 0
    let snippet = ''
    for (const line of raw.split('\n')) {
      if (line === '') continue
      let msg: { role?: string; content?: unknown }
      try {
        msg = JSON.parse(line) as { role?: string; content?: unknown }
      } catch {
        continue
      }
      if (msg.role !== 'user' && msg.role !== 'assistant') continue
      if (typeof msg.content !== 'string' || msg.content === '') continue
      const at = msg.content.toLowerCase().indexOf(needle)
      if (at === -1) continue
      count++
      if (snippet === '') snippet = snippetAround(msg.content, at, needle)
    }

    if (count > 0) hits.push({ sessionId: meta.id, title: meta.title, updatedAt: meta.updatedAt, count, snippet })
  }

  // Most mentions first, then most recent: a session that discussed the thing at length
  // beats one that mentioned it once, and yesterday beats last month.
  hits.sort((a, b) => (b.count - a.count) || (a.updatedAt < b.updatedAt ? 1 : -1))
  return hits.slice(0, limit)
}
