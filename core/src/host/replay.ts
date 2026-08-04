import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage } from '../llama/types.js'
import { PRIVATE_DIR } from '../private-dir.js'
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

export function replayEntries(
  messages: readonly ChatMessage[],
  outcomes: ReadonlyMap<string, boolean> = new Map(),
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const nameById = new Map<string, string>()
  let step = 0

  for (const message of messages) {
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
          entries.push({ kind: 'tool-call', name: call.function.name, args: call.function.arguments })
        }
        break
      }

      case 'tool': {
        const id = message.tool_call_id ?? ''
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

  return entries
}
