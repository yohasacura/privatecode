import type { ChatRequest, ChatResult, ServerProps, Sampling } from './types.js'

/** Replaced by the shared, guarded profile in Task 2. */
const DEFAULT_SAMPLING: Sampling = { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 }

export interface LlamaClientOptions {
  baseUrl: string
  model: string
  /** Hard ceiling for a single request, in milliseconds. */
  requestTimeoutMs?: number
}

export class LlamaRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message)
    this.name = 'LlamaRequestError'
  }
}

export class LlamaClient {
  private readonly baseUrl: string
  private readonly model: string
  private readonly timeoutMs: number

  constructor(opts: LlamaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.model = opts.model
    this.timeoutMs = opts.requestTimeoutMs ?? 600_000
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const sampling = req.sampling ?? DEFAULT_SAMPLING
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: sampling.temperature,
      top_p: sampling.top_p,
      top_k: sampling.top_k,
      min_p: sampling.min_p,
      stream: false,
      cache_prompt: true,
    }
    if (req.tools?.length) payload.tools = req.tools
    if (req.toolChoice) payload.tool_choice = req.toolChoice

    const started = performance.now()
    const data = await this.post('/v1/chat/completions', payload, req.signal)
    const wallSeconds = (performance.now() - started) / 1000

    const choice = data?.choices?.[0]
    if (!choice) {
      throw new LlamaRequestError('llama.cpp request failed: response had no choices')
    }
    return {
      message: choice.message,
      finishReason: choice.finish_reason ?? 'unknown',
      usage: data.usage,
      timings: data.timings,
      wallSeconds,
    }
  }

  async props(): Promise<ServerProps> {
    const data = await this.get('/props')
    return {
      buildInfo: data.build_info,
      modelPath: data.model_path,
      contextLength: data.default_generation_settings?.n_ctx,
      totalSlots: data.total_slots,
    }
  }

  /** Cheap liveness check used by the UI status line. */
  async health(): Promise<boolean> {
    try {
      const data = await this.get('/health')
      return data?.status === 'ok'
    } catch {
      return false
    }
  }

  private async get(path: string): Promise<any> {
    return this.request(path, { method: 'GET' })
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
    if (signal) init.signal = signal
    return this.request(path, init)
  }

  private async request(path: string, init: RequestInit): Promise<any> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = init.signal
      ? AbortSignal.any([init.signal as AbortSignal, timeout])
      : timeout
    let res: Response
    try {
      res = await fetch(this.baseUrl + path, { ...init, signal })
    } catch (cause) {
      throw new LlamaRequestError(
        `llama.cpp request failed: ${this.baseUrl + path} unreachable (${String(cause)})`,
      )
    }
    const text = await res.text()
    if (!res.ok) {
      throw new LlamaRequestError(
        `llama.cpp request failed: HTTP ${res.status}`, res.status, text.slice(0, 600),
      )
    }
    return text ? JSON.parse(text) : {}
  }
}
