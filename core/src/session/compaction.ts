import type { LlamaClient } from '../llama/client.js'
import type { ChatMessage, ChatRequest } from '../llama/types.js'

export interface CompactionInput {
  messages: readonly ChatMessage[] // the full current transcript
  workspaceRoot: string
}
export interface CompactionResult {
  /** The summary text the new transcript opens with. */
  summary: string
  promptTokens?: number
  completionTokens?: number
  wallSeconds: number
}

/** First attempt's budget for the briefing. */
const MAX_TOKENS = 3000
/** Retry budget after a `length` finish -- see `generateCompaction`. */
const RETRY_MAX_TOKENS = 4500

/**
 * The five required sections, in the order the model must produce them. Kept as a
 * standalone list (rather than only inline in the prose below) so the exact header
 * wording used here is the one thing a smoke check greps for.
 */
const REQUIRED_SECTIONS = [
  'Task state',
  'Files touched',
  'Decisions and constraints',
  'Open todos',
  'Next step',
] as const

const COMPACTION_INSTRUCTION = `The conversation above is about to be compacted to free up context space. \
Write a continuation briefing for the session to resume from. Write it for yourself: you \
will continue this session with ONLY this briefing and the last few messages.

Cover exactly these five sections, in this order:

1. ${REQUIRED_SECTIONS[0]}: what was asked, what is done, what remains.
2. ${REQUIRED_SECTIONS[1]}: every path touched so far, one line each on what changed and why.
3. ${REQUIRED_SECTIONS[2]}: anything agreed with the user that must not be silently revisited.
4. ${REQUIRED_SECTIONS[3]}: verbatim, in the user's or your own original wording -- do not \
summarize or drop any of them.
5. ${REQUIRED_SECTIONS[4]}: the single next action to take.

Be concrete: exact file paths, exact function/variable names, exact remaining steps. Omit \
nothing a continuation would need and add nothing it would not.`

/**
 * Builds the compaction request by APPENDING one user message to `input.messages` --
 * never editing the existing list. `input.messages` (and every message in it) is left
 * completely untouched; the returned request's `messages` is a fresh array.
 *
 * This append-only shape is not just tidiness: it is what makes the summary generation
 * cheap. llama.cpp's prompt cache matches on longest-common-prefix, and appending keeps
 * this request's prefix byte-identical to every prior request's prefix in the session --
 * so the whole existing transcript is served from the already-warm KV cache and only the
 * one new briefing instruction needs prefill (DESIGN.md §4, "context full": "summarising
 * runs on top of the already-warm cache: prefill ~= 0, ~2500 generated tokens ~= 80s").
 * Editing or trimming history here instead would force a full re-prefill on top of that
 * generation cost (Transcript's own measurement: 27.7s to change one early word in a
 * ~14.9k-token history, vs 0.5s to append).
 *
 * No tools are offered and `toolChoice` is `'none'`: this call's only job is prose.
 */
export function buildCompactionRequest(input: CompactionInput): ChatRequest {
  const briefing: ChatMessage = { role: 'user', content: COMPACTION_INSTRUCTION }
  return {
    messages: [...input.messages, briefing],
    maxTokens: MAX_TOKENS,
    toolChoice: 'none',
  }
}

/**
 * Runs the compaction request (non-streaming) and returns the briefing text.
 *
 * A `length` finish is retried exactly once at a larger budget (`RETRY_MAX_TOKENS`). If
 * the retry ALSO truncates, this throws rather than returning a briefing that silently
 * cuts off mid-section -- a truncated summary would corrupt every future turn built on
 * top of it, whereas a caller that catches this and keeps the session uncompacted has
 * lost nothing but the space compaction would have freed. An empty (or whitespace-only)
 * summary throws for the same reason: a blank briefing is not a usable continuation.
 */
export async function generateCompaction(
  client: LlamaClient,
  input: CompactionInput,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  const request = buildCompactionRequest(input)
  if (signal) request.signal = signal

  const started = performance.now()
  let result = await client.chat(request)

  if (result.finishReason === 'length') {
    const retryRequest: ChatRequest = { ...request, maxTokens: RETRY_MAX_TOKENS }
    result = await client.chat(retryRequest)
    if (result.finishReason === 'length') {
      throw new Error(
        `compaction summary truncated (finish_reason "length") even after retrying at ` +
        `maxTokens=${RETRY_MAX_TOKENS}; caller should treat compaction as failed and carry ` +
        'on uncompacted',
      )
    }
  }

  const wallSeconds = (performance.now() - started) / 1000
  const summary = result.message.content ?? ''
  if (summary.trim().length === 0) {
    throw new Error(
      'compaction summary was empty; caller should treat compaction as failed and carry on uncompacted',
    )
  }

  return {
    summary,
    ...(result.usage?.prompt_tokens !== undefined ? { promptTokens: result.usage.prompt_tokens } : {}),
    ...(result.usage?.completion_tokens !== undefined
      ? { completionTokens: result.usage.completion_tokens }
      : {}),
    wallSeconds,
  }
}

// --- Task 9: swap helpers -------------------------------------------------------------
//
// The generator above only produces the briefing text; everything below decides what a
// post-compaction Transcript looks like. Kept in this file (not session.ts) because it is
// pure array/string logic with no dependency on Agent, Transcript, or Session -- easy to
// smoke-check in isolation, and this is where the plan's file structure puts "swap logic
// helpers" for Task 9.

/** Opens the one synthetic user message a swap inserts in place of the dropped history. */
export const COMPACTION_BRIEFING_PREFIX =
  'Session briefing from the earlier part of this conversation (auto-compacted):'
/** The one synthetic assistant message that follows it, closing the round-trip. */
export const COMPACTION_ACK_TEXT = 'Understood; continuing from the briefing.'

export interface CompactionTail {
  /** The old transcript's trailing messages, to be copied verbatim (still needs `structuredClone`
   * at the point they're re-appended -- `Transcript.append` does that; this array itself
   * is just a view, a `slice()` of the caller's own array). */
  tail: readonly ChatMessage[]
  /** How many of the OLD transcript's messages were actually summarised away --
   * EXCLUDING the old leading system message (it is rebuilt fresh by the swap either way,
   * never fed to the summary, so counting it as "dropped" would overstate what the
   * briefing covers). The count a host reports as "N earlier messages summarised". */
  droppedMessages: number
}

/**
 * A message a compacted tail may safely open on: a `user` message, or an `assistant`
 * message that is not itself waiting on any `tool` replies. Anything else -- a bare
 * `tool` reply, or an `assistant` message that still has `tool_calls` pending -- would
 * leave the tail's first message dangling on a round-trip whose other half got cut.
 */
function isCleanTailStart(m: ChatMessage): boolean {
  return m.role === 'user' || (m.role === 'assistant' && !(m.tool_calls && m.tool_calls.length > 0))
}

/**
 * Selects the messages a compaction swap keeps verbatim from the OLD transcript: the last
 * `keepRecent` of them, walked BACK (never forward -- only ever including MORE history,
 * never less) until the slice opens on a clean boundary per `isCleanTailStart`.
 *
 * The walk never reaches back past index 1: index 0 is assumed to be the transcript's
 * leading `system` message (true of every `Transcript` a live `Session` ever builds, via
 * `Agent`'s constructor), and a swap always rebuilds its OWN fresh system message rather
 * than copying the old one forward -- so index 0 itself is never a candidate, and the
 * worst case is walking all the way back to index 1, the session's very first `user`
 * message, which is clean by construction (the first thing `Agent.runTurn` ever appends).
 * A `messages` array with no leading `system` message at all (not how `Session` ever
 * builds one, but not assumed away either) falls back to floor 0 and trusts index 0
 * as-is, since there is nothing more conservative to walk back to.
 */
export function selectCompactionTail(
  messages: readonly ChatMessage[], keepRecent: number,
): CompactionTail {
  const floor = messages.length > 0 && messages[0]!.role === 'system' ? 1 : 0
  const desiredStart = Math.max(floor, messages.length - keepRecent)
  let start = desiredStart
  while (start > floor && !isCleanTailStart(messages[start]!)) start--
  // `start - floor` excludes the old leading system message from the count -- `floor` is
  // 1 exactly when one was present, 0 otherwise, so this is a no-op subtraction when
  // there was nothing to exclude.
  return { tail: messages.slice(start), droppedMessages: start - floor }
}
