import type { LlamaClient } from '../llama/client.js'
import type { ChatMessage, ToolSchema } from '../llama/types.js'

/**
 * A forced structured answer that does not cost the prompt cache.
 *
 * Every harness gate needs the same thing: one generation over the live transcript whose
 * SHAPE is guaranteed by the harness rather than requested of the model. The way that was
 * done — send a one-tool `tools` array with `toolChoice: 'required'` — turned out to be the
 * most expensive thing this codebase does.
 *
 * Measured against the live server (`spike/prefix-diagnose.mts`, `spike/gate-cost-probe.mts`):
 * with `--jinja`, the tool block renders at the very FRONT of the prompt, ahead of the system
 * message. Swapping the array therefore moves llama.cpp's longest-common-prefix match to
 * zero and the entire conversation is re-read. On a mid-session context that is 34,347
 * tokens and **61.9 seconds of silence, per gate** — four gates to a task.
 *
 * Two obvious alternatives were tried against this build and both fail:
 *
 *   - a NAMED `tool_choice` (`{type:'function',function:{name}}`) is accepted and then
 *     ignored: offered Read/Grep/report_acceptance and told to call the last, it
 *     called Read 5 times out of 5 when the conversation invited a read
 *     (`spike/tool-choice-probe.mts`). Shipping that would have left every gate quietly
 *     receiving the wrong call and returning null — the gates would stop running while
 *     looking perfectly healthy.
 *   - a GBNF `grammar` is refused outright while `tools` is present: "Cannot use custom
 *     grammar constraints with tools".
 *
 * `response_format: json_schema` is the one mechanism that both constrains and leaves the
 * prompt alone, because it is a SAMPLER constraint and not part of what gets rendered. The
 * caller keeps sending the session's own unchanged tool array, the request becomes a pure
 * append, and the same gate costs **7.5 s instead of 61.9 s** (88.2% of the prompt still
 * cached). It constrained 5/5 in the adversarial case where the named tool choice failed.
 *
 * The answer arrives as JSON in `message.content`; there is no tool call to unwrap.
 *
 * **`tool_choice: 'none'` rides along whenever the tool array does, and it is not optional.**
 * Measured against llama.cpp b10665 (`spike/response-format-check.mts`): `tools` plus
 * `response_format`, in any schema shape, is refused with HTTP 400 *"Failed to initialize
 * samplers: failed to parse grammar"* — the server tries to combine the tool-call grammar
 * with the schema grammar and the result does not parse. The b10202 build this file was
 * measured on accepted the pair. Because this function swallows a refusal into `null` by
 * design, the regression was SILENT: from the server update on 2026-08-28 until this line,
 * every gate — contract, plan, lenses, premises, acceptance, review — asked its question,
 * was refused in 0.2 s, and reported "could not run". `tool_choice: 'none'` drops the
 * tool-call grammar and leaves the rendered prompt byte-identical (the template still
 * renders the tool block), so the request stays the pure append it was meant to be:
 * measured at 10/10 constrained, prompt cached (`spike/response-format-cache-check.mts`).
 */
export async function forcedJson(
  client: LlamaClient,
  opts: {
    messages: ChatMessage[]
    /** Names the schema for the server; only diagnostics read it. */
    name: string
    schema: Record<string, unknown>
    maxTokens: number
    /**
     * The session's OWN tool array, unchanged — which is the whole point: it keeps this
     * request a pure append onto the prompt the conversation already warmed. Omit it only
     * where there is no conversation to stay warm with (a fresh-context reviewer, a test).
     */
    tools?: readonly ToolSchema[]
    disableThinking?: boolean
    signal?: AbortSignal
  },
): Promise<unknown | null> {
  try {
    const result = await client.chat({
      messages: opts.messages,
      jsonSchema: { name: opts.name, schema: opts.schema },
      maxTokens: opts.maxTokens,
      // Both or neither: the array keeps the prefix warm, the `'none'` keeps the server from
      // building a tool-call grammar it cannot merge with the schema's. See the doc comment.
      ...(opts.tools && opts.tools.length > 0 ? { tools: [...opts.tools], toolChoice: 'none' as const } : {}),
      ...(opts.disableThinking ? { disableThinking: true } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    const text = result.message.content
    if (typeof text !== 'string' || text.trim() === '') return null
    return JSON.parse(text) as unknown
  } catch {
    // A gate that cannot run must never block the turn — the same contract every one of
    // these callers already had when the answer came back as a tool call.
    return null
  }
}
