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

export interface ServerProps {
  buildInfo?: string
  modelPath?: string
  contextLength?: number
  totalSlots?: number
}
