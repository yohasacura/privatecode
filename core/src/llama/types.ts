export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: Role
  content: string | null
  /** Present because the server runs with --reasoning-format deepseek. */
  reasoning_content?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolSchema[]
  /** 'required' forces an action. See the global constraints. */
  toolChoice?: 'auto' | 'required' | 'none'
  /**
   * A JSON Schema the ANSWER must satisfy, enforced by the sampler rather than by the tool
   * list — which is what makes a forced structured generation affordable.
   *
   * The harness's gates used to get their guarantee by sending a ONE-TOOL `tools` array
   * with `toolChoice: 'required'`. Measured against this server (`spike/gate-cost-probe.mts`):
   * the tool block renders at the very FRONT of the prompt, before the system message, so
   * swapping the array moves the longest common prefix to zero and the whole conversation is
   * re-read — 34,347 tokens, 61.9 s, on a mid-session context. Sending the session's own
   * unchanged array and constraining the sampler instead leaves 88.2% of the prompt cached:
   * 7.5 s for the same answer.
   *
   * A named `tool_choice` would have been the obvious alternative and does NOT work here:
   * this build accepts `{type:'function',function:{name}}` and ignores it, calling whatever
   * the conversation invites (5/5 in `spike/tool-choice-probe.mts`). A GBNF `grammar` is
   * refused outright while `tools` is present ("Cannot use custom grammar constraints with
   * tools"). `response_format` is the one mechanism that both constrains and leaves the
   * prompt alone.
   *
   * The answer arrives as JSON in `message.content`, not as a tool call.
   */
  jsonSchema?: { name: string; schema: Record<string, unknown> }
  maxTokens: number
  /** Optional override; defaults to the fixed Qwen sampling profile. */
  sampling?: Sampling
  /**
   * Turns Qwen3.6's thinking OFF for this one request.
   *
   * The model thinks by default and that is deliberate everywhere it decides something.
   * It is waste on a request that only has to restate material already in front of it,
   * and the waste is not small — measured on this server, same prompt, 900-token budget:
   *
   *   thinking on   20.7 s   3079 chars of thinking,  719 chars of answer
   *   thinking off   5.2 s      0                    1069 chars of answer
   *
   * Four times faster AND more of the thing that was asked for, because with thinking on
   * most of the budget went to the thinking and the answer was what got truncated.
   *
   * Absent means on, so every existing caller is unaffected.
   */
  disableThinking?: boolean
  signal?: AbortSignal
}

export interface Sampling {
  temperature: number
  top_p: number
  top_k: number
  min_p: number
}

export interface Timings {
  prompt_per_second?: number
  predicted_per_second?: number
  prompt_ms?: number
  predicted_ms?: number
  /** Token COUNTS, as opposed to the rates above. Present on every partial chunk once a
   * request opts into `timings_per_token`, which is what makes a live "1,240 tokens so
   * far" possible without counting SSE chunks — a chunk is not a token when the server
   * runs speculative decoding, and this machine's draft acceptance means chunks routinely
   * carry two or three. */
  prompt_n?: number
  predicted_n?: number
  draft_n?: number
  draft_n_accepted?: number
}

/**
 * Where a request has got to, while it is still running.
 *
 * Two phases, and telling them apart is the whole point. Prefill is the server reading the
 * prompt: no token has been produced, nothing streams, and on a long conversation it is by
 * far the longest silence in a turn — measured on this machine, appending to a 14.9k history
 * costs 0.5 s while changing one word near its start costs 27.7 s, because llama.cpp matches
 * its cache by longest common prefix and everything after the divergence is re-read.
 * Generation is what follows, at a completely different and much steadier rate.
 *
 * `cache` is the number that explains the difference: how much of the prompt the server
 * recognised and did not have to process. A drop in it IS the reason a turn suddenly got
 * slow, and it is invisible in every other reading.
 */
export interface StreamProgress {
  /** Prefill, from the server's own `prompt_progress` chunks. */
  prompt?: { processed: number; total: number; cache: number }
  /** Generation, from `timings` on partial chunks. `perSecond` is the server's rate, not
   * one computed here. */
  generated?: { tokens: number; perSecond?: number }
}

export interface ChatResult {
  message: ChatMessage
  finishReason: string
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  timings?: Timings
  /** Wall-clock seconds for the whole request. */
  wallSeconds: number
}

export interface StreamDelta {
  /** Incremental reasoning text, when this chunk carried any. */
  reasoning?: string
  /** Incremental visible text. */
  content?: string
  /** True when the server signalled a tool call is being emitted (first fragment). */
  toolCallStarted?: boolean
  /**
   * The tool being called, on the fragment that names it -- which is the same fragment that
   * sets `toolCallStarted`, since the server sends id/name once and then only arguments.
   */
  toolCallName?: string
  /**
   * Incremental JSON of the call's arguments, exactly as the server emitted it.
   *
   * These were accumulated and never reported, and on the median large edit that is most of
   * a step: the model spends its generation writing a file's new contents into an argument,
   * and the window has nothing to show until the whole call is assembled. Reported from the
   * running app, diagnosed by the user: the chat showed the change only once it had been
   * generated in full — until then the window simply froze.
   *
   * A fragment is a slice of a JSON document, so it is not parseable on its own -- consumers
   * concatenate and may only read it once the call completes. What it IS good for is showing
   * that generation is happening and how far along it is.
   */
  toolCallArguments?: string
  /** Which call a `toolCallName`/`toolCallArguments` fragment belongs to. Parallel calls
   * share one stream and interleave by index. */
  toolCallIndex?: number
  /**
   * How far the request has got — see `StreamProgress`.
   *
   * Carried on the delta channel rather than a callback of its own so a consumer opts in
   * the same way it opts into text: nothing new to wire, and a renderer that ignores it is
   * exactly as correct as it was before this existed.
   */
  progress?: StreamProgress
}

export interface StreamCallbacks {
  onDelta?(d: StreamDelta): void
}

export interface ServerProps {
  buildInfo?: string
  modelPath?: string
  contextLength?: number
  totalSlots?: number
}
