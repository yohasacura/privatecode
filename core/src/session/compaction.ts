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
