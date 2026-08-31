import { readFileSync } from 'node:fs'
import { COMPACTION_ACK_TEXT, COMPACTION_BRIEFING_PREFIX } from '../session/compaction.js'
import type { ChatMessage } from '../llama/types.js'
import { SESSIONS_DIR, statePath } from '../private-dir.js'

/**
 * One stored session, read WHOLE and read once.
 *
 * `SessionStore.load()` deliberately reads only the live tail — it slices at the last
 * compaction marker, because what it is building is the transcript the next turn will be
 * sent. Anything that wants the HISTORY has to read the file itself, and the file is not
 * what it looks like.
 *
 * ============================================================================
 * WHY THIS IS A MODULE AND NOT A `readFileSync` AT EACH SITE
 * ============================================================================
 *
 * The `.jsonl` is append-only and a compaction swap appends the ENTIRE new transcript after
 * its marker — a fresh system message, the briefing, an acknowledgement, and then the
 * RETAINED TAIL of the old one. Those tail messages are already above the marker. Read
 * naively, every one of them is counted, quoted and attributed twice.
 *
 * That cost real money once already: the diagnosis reported a check as having refused twice
 * running and its fix as having failed, about a check that fired once and was satisfied,
 * because two copies of one hand-back landed in the same turn. An inflated count is bad in a
 * report somebody forwards as evidence; an invented failure is worse.
 *
 * The length is recoverable exactly, and without comparing any text. `selectCompactionTail`
 * returns `droppedMessages = start - floor`, where `floor` is 1 whenever the transcript
 * opened on a system message, so
 *
 *     tail length = (messages in this segment) - droppedMessages - 1
 *
 * and the duplicates are the next that many NON-SYNTHETIC messages after the marker.
 * Counted rather than matched: `clipToBudget` and `collapseSupersededReads` rewrite the
 * content of some tail messages on the way out, so a byte comparison would silently miss
 * exactly the largest ones.
 *
 * It lives here so that every consumer gets the same answer. Two readers of one file, each
 * with its own idea of what is in it, is the shape this codebase has already been bitten by
 * — and the diagnosis and a person reading their own history disagreeing about what happened
 * would be the worst possible version of it.
 */

/** One message as stored, plus what the reader had to work out about it. */
export interface StoredMessage extends ChatMessage {
  /** Written by a compaction swap rather than by the model or the person. Kept — it is a
   * real event in the conversation — but marked, because nobody said it. */
  synthetic?: true
}

export interface StoredSession {
  messages: StoredMessage[]
  /** Compaction swaps this session went through. */
  compactions: number
  /** How many re-appended duplicates were dropped. Reported rather than silent: it is the
   * one number that says the reader understood the file. */
  duplicatesSkipped: number
  /** Anything the read itself could not do, so a thin result is never mistaken for a short
   * session. */
  problems: string[]
}

/** Whether a stored line is one of the three messages a compaction swap writes itself. */
function isSynthetic(m: ChatMessage): boolean {
  return m.role === 'system'
    || m.content === COMPACTION_ACK_TEXT
    || (m.role === 'user' && typeof m.content === 'string'
      && m.content.startsWith(COMPACTION_BRIEFING_PREFIX))
}

/**
 * Reads a session's whole history, with the swap's re-appended tails removed.
 *
 * A missing file is not an error — a meta with no transcript is a session opened and never
 * used — and returns an empty result rather than throwing.
 */
export function readStoredSession(workspaceRoot: string, sessionId: string): StoredSession {
  const problems: string[] = []
  let raw: string
  try {
    raw = readFileSync(statePath(workspaceRoot, SESSIONS_DIR, `${sessionId}.jsonl`), 'utf8')
  } catch {
    return { messages: [], compactions: 0, duplicatesSkipped: 0, problems }
  }

  const messages: StoredMessage[] = []
  let compactions = 0
  let duplicatesSkipped = 0
  let segmentMessages = 0
  let skipDuplicates = 0

  for (const line of raw.split('\n')) {
    if (line === '') continue
    let m: ChatMessage
    try {
      m = JSON.parse(line) as ChatMessage
    } catch {
      // One unreadable line loses one message, not the session. The append-only law means
      // a torn last line is a real state on disk after a crash mid-write.
      problems.push('one line of this session could not be read')
      continue
    }

    if ((m as { __event?: string }).__event === 'compaction') {
      compactions++
      const dropped = (m as { droppedMessages?: unknown }).droppedMessages
      if (typeof dropped === 'number' && Number.isFinite(dropped)) {
        skipDuplicates = Math.max(0, segmentMessages - dropped - 1)
      } else {
        // A marker with no count cannot be reconciled, and guessing is the one thing this
        // module refuses. Say so: a doubled number a reader has been warned about is
        // recoverable, a silent one is not.
        problems.push(
          'this session compacted without recording how much history it folded away, so ' +
          'the messages the swap re-appended appear twice in it',
        )
      }
      segmentMessages = 0
      continue
    }

    segmentMessages++
    if (skipDuplicates > 0 && !isSynthetic(m)) {
      skipDuplicates--
      duplicatesSkipped++
      continue
    }
    messages.push(isSynthetic(m) && m.role !== 'system' ? { ...m, synthetic: true } : m)
  }

  return { messages, compactions, duplicatesSkipped, problems: [...new Set(problems)] }
}
