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
  maxTokens: number
  /** Optional override; defaults to the fixed Qwen sampling profile. */
  sampling?: Sampling
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
  draft_n?: number
  draft_n_accepted?: number
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
   * running app, diagnosed by the user: "я в чате увижу это только тогда когда полное
   * изменение будет сгенерированно, а до этого у меня чат просто замирает."
   *
   * A fragment is a slice of a JSON document, so it is not parseable on its own -- consumers
   * concatenate and may only read it once the call completes. What it IS good for is showing
   * that generation is happening and how far along it is.
   */
  toolCallArguments?: string
  /** Which call a `toolCallName`/`toolCallArguments` fragment belongs to. Parallel calls
   * share one stream and interleave by index. */
  toolCallIndex?: number
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
