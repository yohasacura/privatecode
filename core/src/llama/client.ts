import type { ChatRequest, ChatResult, ServerProps } from './types.js'
import { QWEN_SAMPLING, assertSafeSampling } from './sampling.js'

export interface LlamaClientOptions {
  baseUrl: string
  model: string
  /** Hard ceiling for a single request, in milliseconds. */
  requestTimeoutMs?: number
}

export interface LlamaRequestFailure {
  /** HTTP status, when the failure arrived as an HTTP response. */
  status?: number
  /** What the server sent back, bounded — often the only diagnostic there is. */
  body?: string
  /**
   * Whether llama.cpp produced a response at all.
   *
   * The question a caller actually needs answered is "is the server up?", and `status` is
   * not that question: a 200 whose body is not JSON, and a 200 whose JSON has no
   * `choices`, are both a running server replying, and both used to reach the CLI either
   * as a raw SyntaxError or as an error with `status: undefined`. The CLI branched on
   * `status !== undefined`, i.e. on "did the HTTP layer error", and so told the user to
   * restart a server that was up and answering. Only a request that never got a response —
   * connection refused, DNS failure, a timeout — sets this false.
   */
  answered: boolean
}

export class LlamaRequestError extends Error {
  readonly status?: number
  readonly body?: string
  readonly answered: boolean

  constructor(message: string, failure: LlamaRequestFailure) {
    super(message)
    this.name = 'LlamaRequestError'
    if (failure.status !== undefined) this.status = failure.status
    if (failure.body !== undefined) this.body = failure.body
    this.answered = failure.answered
  }
}

/** Ceiling on how much of a response body is carried on an error. */
const MAX_ERROR_BODY_CHARS = 600

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
    const sampling = req.sampling ?? QWEN_SAMPLING
    assertSafeSampling(sampling)
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
      // The server answered — this is a well-formed HTTP 200 whose JSON is not a
      // completion. llama.cpp's own shape for a refused request is exactly this: 200 with
      // an `error` object. Carrying the body is the only way the user learns what it said.
      throw new LlamaRequestError('llama.cpp request failed: response had no choices', {
        answered: true,
        body: JSON.stringify(data).slice(0, MAX_ERROR_BODY_CHARS),
      })
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
      // The one genuine "the server is not there" case: nothing answered.
      throw new LlamaRequestError(
        `llama.cpp request failed: ${this.baseUrl + path} unreachable (${String(cause)})`,
        { answered: false },
      )
    }
    const text = await res.text()
    if (!res.ok) {
      throw new LlamaRequestError(`llama.cpp request failed: HTTP ${res.status}`, {
        status: res.status,
        body: text.slice(0, MAX_ERROR_BODY_CHARS),
        answered: true,
      })
    }
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      // A 2xx carrying something that is not JSON — an HTML error page from a proxy, a
      // truncated body. Unwrapped, this escaped as a raw SyntaxError, which is not a
      // LlamaRequestError, so the CLI's catch treated it as a transport failure and told
      // the user to restart a server that had just replied to them.
      throw new LlamaRequestError(
        `llama.cpp request failed: ${this.baseUrl + path} answered HTTP ${res.status} with a ` +
        'body that is not JSON',
        { status: res.status, body: text.slice(0, MAX_ERROR_BODY_CHARS), answered: true },
      )
    }
  }
}
