import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CONTINUE_NUDGE, MAX_STEPS_PREFIX, STEP_TIMEOUT_PREFIX, TALKED_INSTEAD_OF_ACTING,
  TRUNCATED_TWICE,
} from '../agent/loop.js'
import type { ChatMessage } from '../llama/types.js'
import { OUTCOMES_SUFFIX, SESSIONS_DIR, statePath } from '../private-dir.js'
import { attachmentUserText } from '../session/attachment-text.js'
import { REVERT_FILE_PREFIX, ROLLBACK_PREFIX } from '../session/checkpoint-notices.js'
import {
  COMPACTION_ACK_TEXT, COMPACTION_BRIEFING_PREFIX, OVERFLOW_RETRY_NOTE,
} from '../session/compaction.js'
import { ACCEPTANCE_FIXER_PREFIX, REVIEW_FIXER_PREFIX } from '../session/contract.js'
import { PREMISE_FAILURE_PREFIX } from '../session/premises.js'
import { VERIFY_FAILED_PREFIX, VERIFY_PROBLEM_PREFIX } from '../verify/runner.js'
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

interface Outcome { id: string; ok: boolean }

function outcomesPath(workspaceRoot: string, sessionId: string): string {
  return statePath(workspaceRoot, SESSIONS_DIR, `${sessionId}${OUTCOMES_SUFFIX}`)
}

/**
 * Records how one tool call ended, appended as it happens.
 *
 * The directory is created first, and that line is the whole reason this function ever
 * recorded anything. Outcomes are written DURING a turn, from inside the agent loop; the
 * transcript is written when the turn's messages are flushed, which is what creates
 * `sessions/`. So on the first turn of a new session the directory did not exist yet, every
 * `appendFileSync` threw ENOENT, and the `catch` below turned each one into silence. Turn two
 * onwards worked, because by then the transcript had made the directory — which is why this
 * looked fine in every test that ran more than one turn, and in casual use.
 *
 * What it cost: a session's opening turn is the one most likely to be read back later, and
 * with no outcomes on disk `assumedOk` guesses from the result text. Every failed call in it
 * restored with a tick.
 *
 * Failures are still swallowed, for the original reason: a session whose ok-flags cannot be
 * written is a session whose restored tool cards look neutral, which is a cosmetic loss.
 * Refusing to run the turn over it would not be.
 */
export function recordToolOutcome(
  workspaceRoot: string, sessionId: string, callId: string, ok: boolean,
): void {
  const path = outcomesPath(workspaceRoot, sessionId)
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify({ id: callId, ok })}\n`, 'utf8')
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

/**
 * Whether a user-role message was written by the HARNESS rather than by the person, and
 * what the person actually said if both are in there.
 *
 * The two share a role because the chat template has nowhere else to put a plan-focus note,
 * a mid-turn verify result or a contract preamble — the model has to read them as
 * instructions. On screen they are not the same thing, and treating them as the same thing
 * is why a resumed session showed four "your messages" where two had been sent.
 *
 * The convention is the harness's own and has been consistent since these notes existed:
 * every one of them is wrapped in square brackets. That gives two shapes:
 *
 *   [note]                  — the whole message is the harness talking. Marked.
 *   [note]\n\nwhat you said — a note PREFIXED to a real message, which is how a contract
 *                             preamble rides along (session.ts folds them into one message
 *                             because two adjacent user messages deviate from the template).
 *                             The person's own words are what the row should show, so the
 *                             preamble is stripped for display and the message stays theirs.
 *
 * Deliberately conservative: the bracket has to open at the very first character and the
 * matching close has to be found by counting depth, so a message that merely CONTAINS
 * brackets, or opens one and never closes it, is left alone and stays the person's. Being
 * wrong in that direction shows a note as a message, which is where we started; being wrong
 * the other way would hide something a person wrote, which is not recoverable by scrolling.
 */
/**
 * The harness messages that do NOT open with a bracket, listed because they exist.
 *
 * The bracket convention covers the notes; it never covered the FIXER messages, which are
 * the harness talking just as much: the acceptance gate's list of unmet criteria, the diff
 * reviewer's findings, a failed premise check, a build log from the verify runner, and the
 * post-compaction retry note. All five open with plain prose, so on resume they rendered in
 * the `›` caret row as things the PERSON said — `conversationAsMarkdown` exported them under
 * "## You", and session search returned them as what a person had asked for. The session's
 * own plan-focus note IS correctly bracketed, which is what shows the convention was meant
 * to cover these too.
 *
 * Matched on an exported constant rather than a copied string, so a reworded message cannot
 * quietly fall out of the list.
 */
const HARNESS_OPENERS: readonly string[] = [
  ACCEPTANCE_FIXER_PREFIX,
  REVIEW_FIXER_PREFIX,
  PREMISE_FAILURE_PREFIX,
  VERIFY_FAILED_PREFIX,
  VERIFY_PROBLEM_PREFIX,
  OVERFLOW_RETRY_NOTE,
  // The agent loop's own six. Each was measured replaying as the person's message, under a
  // `## You` heading, with no test covering any of them: the app suite is green and does not
  // look at harness attribution at all.
  CONTINUE_NUDGE,
  TRUNCATED_TWICE,
  TALKED_INSTEAD_OF_ACTING,
  STEP_TIMEOUT_PREFIX,
  MAX_STEPS_PREFIX,
  REVERT_FILE_PREFIX,
  ROLLBACK_PREFIX,
]

/**
 * The folder prefix a multi-folder workspace puts in front of a verify failure, as a matcher
 * rather than a constant — the folder name is the user's.
 *
 * `HARNESS_OPENERS` matches with `startsWith`, so `In the "api" folder: Automatic
 * verification failed...` did not match `VERIFY_FAILED_PREFIX` and the whole build log
 * replayed as something a person had typed. Single-folder workspaces were fine, which is why
 * this survived: the prefix is empty there.
 */
const FOLDER_PREFIX = /^In the "[^"]*" folder: /

export function splitUserMessage(content: string): { kind: 'user'; text: string; harness?: true } {
  // Openers FIRST, and against the text with any folder prefix removed — the prefix is the
  // harness's own, so it must not be able to hide the harness's own message.
  const unprefixed = content.replace(FOLDER_PREFIX, '')
  if (HARNESS_OPENERS.some((opener) => unprefixed.startsWith(opener))) {
    return { kind: 'user', text: content, harness: true }
  }
  // Then the attachment wrapper, which is the one case where the stored message legitimately
  // contains more than the person wrote and the row should show LESS. Checked after the
  // openers because an opener is never inside one.
  const attached = attachmentUserText(content)
  if (attached !== null) return { kind: 'user', text: attached }
  // The bracket analysis runs on the unprefixed text for the same reason: the escalation turn
  // writes a folder name, then a bracketed note, then a blank line, then the build log — and
  // a leading folder name is not something the person put there.
  if (!unprefixed.startsWith('[')) return { kind: 'user', text: content }
  let depth = 0
  let end = -1
  for (let i = 0; i < unprefixed.length; i++) {
    const ch = unprefixed[i]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return { kind: 'user', text: content }
  const after = unprefixed.slice(end + 1)
  const rest = after.trim()
  // Nothing after the bracket: the message IS the note -- as long as the bracket holds a
  // SENTENCE. Every note the harness writes is one ("[Plan focus — step 2 of 5: ...]",
  // "[Context is about 80% full...]", "[dotnet build: ok, 3.2s]"), and a lone bracketed
  // TOKEN is the shape of something a person types: `[HttpGet]`, `[Fact]`, `[TODO]`. Those
  // were being dimmed and marked as the harness talking.
  if (rest === '') {
    const inside = unprefixed.slice(1, end)
    return /\s/.test(inside.trim())
      ? { kind: 'user', text: content, harness: true }
      : { kind: 'user', text: content }
  }
  // A note PREFIXED to a real message is separated by a blank line, because the one site
  // that produces this shape writes `[${renderContract(contract)}]\n\n${userText}`.
  // Requiring that separator is what makes the test positive instead of "it starts with a
  // bracket": `[HttpGet] is missing on the controller` and
  // `[2026-08-21 10:33:02] ERROR NullReferenceException` are ordinary things to type, and
  // both were silently losing their first token on every resume -- in the transcript, in
  // the row's title, and in the markdown export. Live was fine, so it only appeared later.
  if (!/^\r?\n\r?\n/.test(after)) return { kind: 'user', text: content }
  // What the note was prefixed TO is usually the person's message — that is what this shape
  // exists for. It is not always: the verify escalation writes a bracketed "pick a different
  // approach" note in front of the build log, and both halves are the harness. Re-asking the
  // opener question about the remainder is what tells the two apart.
  if (HARNESS_OPENERS.some((opener) => rest.startsWith(opener))) {
    return { kind: 'user', text: rest, harness: true }
  }
  return { kind: 'user', text: rest }
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
          entries.push(splitUserMessage(message.content))
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
