import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage } from '../llama/types.js'
import { PRIVATE_DIR } from '../private-dir.js'
import { COMPACTION_ACK_TEXT, COMPACTION_BRIEFING_PREFIX } from '../session/compaction.js'
import type { TranscriptEntry } from './protocol.js'

/**
 * Turning a stored conversation back into something the window can show.
 *
 * The transcript on disk is the model's context, not a view: it is a list of chat messages
 * in wire format. Everything the UI needs is in there — what you asked, what the model
 * reasoned, which tool it called with which arguments, what came back — with exactly one
 * exception, which is whether each tool call SUCCEEDED. `ToolResult.ok` never reaches the
 * transcript, because the model is given the result text and nothing else.
 *
 * That one missing bit is what `toolOutcomes` records, in a small file beside the session
 * rather than inside it. Inside would have meant adding a non-standard key to a message that
 * gets sent verbatim to llama.cpp on the next turn; the append-only transcript is the
 * model's, and this is the window's.
 */

const OUTCOMES_SUFFIX = '.ui.jsonl'

interface Outcome { id: string; ok: boolean }

function outcomesPath(workspaceRoot: string, sessionId: string): string {
  return join(workspaceRoot, PRIVATE_DIR, 'sessions', `${sessionId}${OUTCOMES_SUFFIX}`)
}

/**
 * Records how one tool call ended, appended as it happens.
 *
 * Failures here are swallowed on purpose: a session whose ok-flags cannot be written is a
 * session whose restored tool cards look neutral, which is a cosmetic loss. Refusing to run
 * the turn over it would not be.
 */
export function recordToolOutcome(
  workspaceRoot: string, sessionId: string, callId: string, ok: boolean,
): void {
  try {
    appendFileSync(outcomesPath(workspaceRoot, sessionId), `${JSON.stringify({ id: callId, ok })}\n`, 'utf8')
  } catch { /* see above */ }
}

/** Every recorded outcome for a session, by tool-call id. Absent file, unreadable file and
 * corrupt line all degrade the same way: fewer known outcomes, never a throw. */
export function toolOutcomes(workspaceRoot: string, sessionId: string): Map<string, boolean> {
  const out = new Map<string, boolean>()
  let raw: string
  try {
    raw = readFileSync(outcomesPath(workspaceRoot, sessionId), 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as Outcome
      if (typeof parsed.id === 'string' && typeof parsed.ok === 'boolean') out.set(parsed.id, parsed.ok)
    } catch { /* one bad line loses one tick mark */ }
  }
  return out
}

/**
 * The conversation, as entries the UI can fold.
 *
 * The system prompt is dropped: it is not part of the conversation, it is the instrument the
 * conversation is played on, and showing it would push every real message a screenful down.
 * Nudges the unattended runner sent as user messages are NOT dropped, because they genuinely
 * were sent and a morning review that hid them would be lying about what drove the run.
 *
 * Within one assistant message the order is reasoning, then answer, then tool calls, which
 * is the order they were produced in and the order the live events arrive in.
 */
/**
 * Whether a call with no recorded outcome worked.
 *
 * `Not run:` is not a guess — the agent loop writes exactly that prefix for every call the
 * permission gate refused, deferred or cancelled, always with `ok: false`, and the work log
 * already treats it as a contract for the same reason. A blocked call is also the single
 * most common failure in a long unattended run, so recovering it is most of what a session
 * that predates the outcomes file loses.
 *
 * Everything else reads as success. It is the honest default of the two available: a real
 * run's calls mostly succeeded, and painting them all red would invent failures, which is
 * worse than failing to mark the real ones. Sessions recorded from now on know the truth.
 */
function assumedOk(content: string): boolean {
  return !content.startsWith('Not run:') && !content.startsWith('Not executed:')
}

/**
 * The two synthetic messages a compaction swap inserts, recognised so they can be shown as
 * what they are.
 *
 * Recognition is by the briefing's own opening line rather than by position, because
 * position is not reliable: `load()` slices at the LAST marker, so the pair is usually at
 * the front, but a transcript assembled any other way would put it anywhere. The prefix is
 * a constant this codebase writes itself, exported from `compaction.ts` for exactly this.
 *
 * The `assistant` acknowledgement that follows is dropped rather than rendered: it is the
 * other half of one synthetic round-trip, and a model that "said" it never generated a word.
 */
function briefingIn(message: ChatMessage): string | null {
  if (message.role !== 'user' || typeof message.content !== 'string') return null
  if (!message.content.startsWith(COMPACTION_BRIEFING_PREFIX)) return null
  return message.content.slice(COMPACTION_BRIEFING_PREFIX.length).trim()
}

function isCompactionAck(message: ChatMessage): boolean {
  return message.role === 'assistant' && message.content === COMPACTION_ACK_TEXT
}

export function replayEntries(
  messages: readonly ChatMessage[],
  outcomes: ReadonlyMap<string, boolean> = new Map(),
  /** The swap the transcript opens on, from `SessionStore.load`. Only its `droppedMessages`
   * is used; everything else the card shows is recoverable from the messages themselves. */
  compaction: { droppedMessages: number } | null = null,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const nameById = new Map<string, string>()
  /**
   * Calls announced by the assistant message but not yet answered.
   *
   * They are held rather than emitted with their message because the window pairs a result
   * with a call by RECENCY — `lastPendingTool` scans backwards for the newest card still
   * without one. That is exact for the live stream, where the loop announces a call, runs it,
   * answers it, and only then moves to the next. A literal replay is the opposite shape: all
   * of a step's calls, then all of its results. With three calls in a step the newest card
   * was the LAST call and the first result went to it, so a restored session showed every
   * multi-call step's results in reverse — the third file's diff under the first file's name.
   *
   * So the entries are interleaved back into the order the events really happened in. It
   * cost nothing while the loop ran one call per step and refused the rest; it runs them all
   * now, and this is the shape every long turn produces.
   */
  const pending: { id: string; name: string; args: string }[] = []
  const flushPending = (): void => {
    for (const call of pending.splice(0)) {
      entries.push({ kind: 'tool-call', name: call.name, args: call.args })
    }
  }
  let step = 0
  // Only the FIRST briefing takes the marker's count. A transcript containing two would mean
  // a file whose slice point moved, and the marker describes exactly one of them; guessing
  // which for the others would be inventing numbers.
  let markerSpent = false

  for (const message of messages) {
    if (isCompactionAck(message)) continue
    // Anything that is not a tool reply ends the step's answers. Whatever is still pending
    // was never answered — a file truncated mid-turn, or a transcript from before every call
    // was answered — and is emitted here so it appears in the place it was proposed.
    if (message.role !== 'tool') flushPending()
    const briefing = briefingIn(message)
    if (briefing !== null) {
      entries.push({
        kind: 'compaction',
        summary: briefing,
        ...(compaction !== null && !markerSpent ? { droppedMessages: compaction.droppedMessages } : {}),
      })
      markerSpent = true
      continue
    }

    switch (message.role) {
      case 'system':
        break

      case 'user':
        if (message.content !== null && message.content !== '') {
          entries.push({ kind: 'user', text: message.content })
        }
        break

      case 'assistant': {
        step += 1
        const reasoning = message.reasoning_content
        if (reasoning !== undefined && reasoning.trim() !== '') {
          entries.push({ kind: 'reasoning', step, text: reasoning })
        }
        if (message.content !== null && message.content !== '') {
          entries.push({ kind: 'assistant', text: message.content })
        }
        for (const call of message.tool_calls ?? []) {
          nameById.set(call.id, call.function.name)
          pending.push({ id: call.id, name: call.function.name, args: call.function.arguments })
        }
        break
      }

      case 'tool': {
        const id = message.tool_call_id ?? ''
        // The call this answers, emitted immediately before it. Found by id rather than taken
        // off the head: the replies are written in call order, but a hand-edited or
        // partially-recovered file need not be, and pairing the wrong two is the whole defect
        // this avoids. An id with nothing pending (a transcript older than `tool_call_id`)
        // emits the result alone, exactly as it always did.
        const at = pending.findIndex((c) => c.id === id)
        if (at !== -1) {
          const call = pending.splice(at, 1)[0]!
          entries.push({ kind: 'tool-call', name: call.name, args: call.args })
        }
        entries.push({
          kind: 'tool-result',
          // The message's own `name` is what the loop wrote; the id lookup is the fallback
          // for transcripts written before it carried one.
          name: message.name ?? nameById.get(id) ?? 'tool',
          ok: outcomes.get(id) ?? assumedOk(message.content ?? ''),
          content: message.content ?? '',
        })
        break
      }

      default:
        break
    }
  }
  // A transcript that ends on an unanswered call: the process died between the assistant
  // message and the tool reply, which is a real state on disk (see `store.load`).
  flushPending()

  return entries
}
