import type { ChatRequest, ChatResult, ServerProps, StreamCallbacks } from './types.js'
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
  /**
   * Whatever `chatStream` had assembled (reasoning/content text, concatenated so far)
   * before this failure happened. Only ever set for a failure that occurs mid-stream,
   * after at least one SSE event was read — a failure before the first byte has nothing
   * assembled yet, so this stays absent. Forward reference for Task 5 (interrupt keeps
   * the partial): the loop reads this off a caught abort to preserve what the model had
   * already produced instead of discarding it.
   */
  partial?: { reasoning: string; content: string }
}

export class LlamaRequestError extends Error {
  readonly status?: number
  readonly body?: string
  readonly answered: boolean
  /** See `LlamaRequestFailure.partial`. */
  readonly partial?: { reasoning: string; content: string }

  constructor(message: string, failure: LlamaRequestFailure) {
    super(message)
    this.name = 'LlamaRequestError'
    if (failure.status !== undefined) this.status = failure.status
    if (failure.body !== undefined) this.body = failure.body
    this.answered = failure.answered
    if (failure.partial !== undefined) this.partial = failure.partial
  }
}

/** Ceiling on how much of a response body is carried on an error. */
const MAX_ERROR_BODY_CHARS = 600

/** How often a running generation reports its token count. Four readings a second is past
 * the rate a person reads a changing number, and far below the ~60 the server now offers. */
const PROGRESS_MIN_INTERVAL_MS = 250

/** A number off the wire, or the fallback. Guards the progress fields specifically: they
 * are the one part of the SSE contract measured from documentation rather than from the
 * live server, so a string, a null or a NaN there must read as "not reported". */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
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

  /**
   * Polls `/health` until the server answers ok, for at most `budgetMs`; true the moment
   * it does, false when the budget runs out or the signal aborts first.
   *
   * Exists for exactly one caller: the agent loop's single step retry after a request
   * died under it. Watched live ("stream read error (TypeError: terminated)" mid-thinking):
   * the llama process dies silently on a VRAM spike, the watchdog relaunches it, and the
   * model reload takes ~20-30 s — a turn that can outwait that keeps its session instead
   * of ending on an error the server has already recovered from.
   */
  async waitHealthy(budgetMs: number, signal?: AbortSignal): Promise<boolean> {
    const until = Date.now() + budgetMs
    for (;;) {
      if (signal?.aborted) return false
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3_000) })
        if (res.ok) return true
      } catch { /* not up yet — the relaunch is still loading the model */ }
      if (Date.now() >= until) return false
      await new Promise((r) => setTimeout(r, 2_000))
    }
  }

  /**
   * The single slot's prompt-processing state, or null when `/slots` is unavailable.
   *
   * For the step clock's prefill extension only. The clock's char-counter predicts prefill
   * from what THIS process appended — it cannot see a server-side cache eviction (watched
   * live at 179k: the state outgrew --cache-ram, one divergent request evicted the prefix,
   * and the next turn re-prefilled ~187k tokens into a deadline sized for a few hundred).
   * `n_prompt_tokens_processed` is the server's own progress report on exactly that work.
   */
  async slotPrefillProgress(): Promise<{ processing: boolean; processed: number } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/slots`, { signal: AbortSignal.timeout(3_000) })
      if (!res.ok) return null
      const arr = await res.json() as { is_processing?: boolean; n_prompt_tokens_processed?: number }[]
      const slot = Array.isArray(arr) ? arr[0] : undefined
      if (slot === undefined) return null
      return { processing: slot.is_processing === true, processed: slot.n_prompt_tokens_processed ?? 0 }
    } catch {
      return null
    }
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
    // `chat_template_kwargs` and NOT `reasoning_budget`: both are accepted by the server and
    // only the first one works. Measured — `reasoning_budget: 0` came back with 3554
    // characters of thinking, i.e. silently ignored.
    if (req.disableThinking) payload.chat_template_kwargs = { enable_thinking: false }

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

  /**
   * Streaming sibling of `chat()`. Reads the llama.cpp SSE stream incrementally, firing
   * `cb.onDelta` per meaningful fragment, and returns the SAME `ChatResult` shape `chat()`
   * would return for the same completion — callers that don't care about incremental
   * delivery can treat the two as interchangeable.
   *
   * SSE contract this reads against (measured live, docs/SPIKE-STREAMING.md): the first
   * event is a bare `delta.role` marker (`content: null`, nothing to assemble); reasoning
   * fragments (`delta.reasoning_content`) all arrive before any `delta.content` fragment;
   * tool-call fragments (`delta.tool_calls[]`) carry `id`/`function.name` only on the
   * FIRST fragment for a given `index` and must be routed by that index; `function.
   * arguments` fragments are concatenated and are only valid JSON once complete — never
   * parsed incrementally here. `finish_reason` arrives on its own terminal chunk with an
   * empty `delta: {}`, but that chunk already carries `timings`. `usage` only appears
   * because this method opts in with `stream_options: {include_usage: true}`; it then
   * rides a SEPARATE, later chunk whose `choices` is an empty array — callers of the SSE
   * reader below must tolerate chunks with no `choices[0]`. The stream always ends with
   * a literal `data: [DONE]` line (no JSON body).
   */
  async chatStream(req: ChatRequest, cb?: StreamCallbacks): Promise<ChatResult> {
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
      stream: true,
      stream_options: { include_usage: true },
      cache_prompt: true,
      // The two opt-ins that make a running request observable rather than merely pending.
      //
      // `return_progress` adds `prompt_progress` chunks DURING prefill — the phase that
      // streams nothing and is the longest silence in a turn. `timings_per_token` puts
      // `timings` on every partial chunk instead of only the last, which is where the live
      // token count comes from; counting SSE chunks would undercount, because with
      // speculative decoding on this machine a chunk routinely carries two or three tokens.
      //
      // Both are ignored by a server that does not know them (llama.cpp drops unknown
      // request fields), so this degrades to the previous behaviour rather than failing.
      return_progress: true,
      timings_per_token: true,
    }
    if (req.tools?.length) payload.tools = req.tools
    if (req.toolChoice) payload.tool_choice = req.toolChoice
    // The same opt-out `chat()` sends, and it was missing here — latent until compaction
    // started streaming, because until then every `disableThinking` caller (the distiller,
    // the acceptance audit, the compaction summary) used the non-streaming path. A streamed
    // compaction without this thinks: measured before the flag existed, two compactions
    // generated 4022 and 4298 tokens against a 3000 budget, were truncated, and paid for a
    // second generation each to produce one clipped summary. See `ChatRequest.disableThinking`.
    if (req.disableThinking) payload.chat_template_kwargs = { enable_thinking: false }

    const path = '/v1/chat/completions'
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout

    const started = performance.now()
    let res: Response
    try {
      res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (cause) {
      // Same as chat()'s only genuine "the server is not there" case, and the same case
      // an abort before any byte arrives falls into (fetch rejects either way).
      throw new LlamaRequestError(
        `llama.cpp request failed: ${this.baseUrl + path} unreachable (${String(cause)})`,
        { answered: false },
      )
    }

    if (!res.ok) {
      const text = await res.text()
      throw new LlamaRequestError(`llama.cpp request failed: HTTP ${res.status}`, {
        status: res.status,
        body: text.slice(0, MAX_ERROR_BODY_CHARS),
        answered: true,
      })
    }
    if (!res.body) {
      throw new LlamaRequestError(
        `llama.cpp request failed: ${this.baseUrl + path} answered with no readable stream body`,
        { status: res.status, answered: true },
      )
    }

    let reasoning = ''
    let content = ''
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    let finishReason = 'unknown'
    // Distinct from `finishReason !== 'unknown'`: this tracks whether a finish_reason
    // CHUNK was ever observed, not the value it carried. A loop that exits (reader
    // `done`, no `[DONE]`) without ever seeing one means the connection dropped
    // mid-generation — indistinguishable from success unless this is checked below.
    let sawFinishReason = false
    let usage: ChatResult['usage']
    let timings: ChatResult['timings']
    /**
     * When a generation-progress delta was last emitted.
     *
     * `timings_per_token` means the server offers a fresh reading on EVERY token, which at
     * this machine's ~60 tok/s would push sixty progress events a second through the agent
     * loop, the host transport and a Preact reducer — for a number a person reads about
     * four times a second. Throttled here rather than at the renderer because the cheapest
     * event is the one never sent, and nothing downstream wants the finer grain.
     *
     * Dropping the last sample this way costs nothing: the authoritative final counts ride
     * `ChatResult.timings`, which every consumer already reads at step end.
     */
    let lastProgressAtMs = 0
    /** Whether THIS request has streamed anything of its own yet — the guard that keeps the
     * slot's previous `predicted_n` from being reported as this generation's. See below. */
    let sawGeneratedDelta = false

    /** Returns 'done' when this event was the literal `[DONE]` terminator. */
    const handleEvent = (raw: string): 'done' | void => {
      const dataLines = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
      if (dataLines.length === 0) return
      const data = dataLines.join('\n')
      if (data.trim() === '[DONE]') return 'done'

      const parsed = JSON.parse(data)
      // The usage chunk (choices: []) and the finish_reason chunk both carry these at the
      // top level, per the spike — never merged into a per-choice `delta`.
      if (parsed.timings !== undefined) timings = parsed.timings
      if (parsed.usage != null) usage = parsed.usage

      // Prefill progress rides its own chunk, which carries no `choices` at all — so it has
      // to be read BEFORE the tolerate-no-choice return below, alongside timings and usage.
      // Every field is read defensively: this is the one part of the wire format the spike
      // never covered, and a missing key must degrade to "no progress shown" rather than
      // throwing inside the stream reader, where the throw would be reported to the user as
      // the model's answer having failed.
      const rawPrompt = parsed.prompt_progress
      if (rawPrompt != null && typeof rawPrompt === 'object') {
        const total = numberOr(rawPrompt.total, 0)
        // A total of zero says nothing and would render as a division by zero downstream.
        if (total > 0) {
          cb?.onDelta?.({
            progress: {
              prompt: {
                processed: numberOr(rawPrompt.processed, 0),
                total,
                cache: numberOr(rawPrompt.cache, 0),
              },
            },
          })
        }
      }

      const choice = parsed.choices?.[0]
      if (!choice) return // the usage-only chunk: tolerate no choices[0]

      if (choice.finish_reason) {
        finishReason = choice.finish_reason
        sawFinishReason = true
        return
      }

      const delta = choice.delta ?? {}
      // Has THIS request produced anything yet? The opening chunk is a bare `delta.role`
      // marker whose `content` is null, and `typeof null` is not 'string', so it does not
      // count — which is right: it is the server acknowledging the request, not answering it.
      if (typeof delta.reasoning_content === 'string' || typeof delta.content === 'string' ||
        Array.isArray(delta.tool_calls)) {
        sawGeneratedDelta = true
      }
      if (typeof delta.reasoning_content === 'string') {
        reasoning += delta.reasoning_content
        cb?.onDelta?.({ reasoning: delta.reasoning_content })
      }
      if (typeof delta.content === 'string') {
        content += delta.content
        cb?.onDelta?.({ content: delta.content })
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const fragment of delta.tool_calls) {
          if (typeof fragment?.index !== 'number') continue
          let entry = toolCalls.get(fragment.index)
          if (!entry) {
            entry = { id: '', name: '', arguments: '' }
            toolCalls.set(fragment.index, entry)
          }
          // id/type/name arrive only on the first fragment of a call (spike Q1/Q6).
          if (typeof fragment.id === 'string') {
            entry.id = fragment.id
            if (typeof fragment.function?.name === 'string') entry.name = fragment.function.name
            cb?.onDelta?.({
              toolCallStarted: true,
              toolCallIndex: fragment.index,
              ...(entry.name !== '' ? { toolCallName: entry.name } : {}),
            })
          }
          if (typeof fragment.function?.arguments === 'string') {
            entry.arguments += fragment.function.arguments
            // Reported as well as accumulated. Writing a large argument IS the step, and a
            // consumer that only ever sees the finished call has nothing to show for the
            // whole of it.
            if (fragment.function.arguments !== '') {
              cb?.onDelta?.({
                toolCallArguments: fragment.function.arguments,
                toolCallIndex: fragment.index,
              })
            }
          }
        }
      }

      // Generation progress, LAST — after the deltas above have said whether this request has
      // actually started producing tokens.
      //
      // Measured against the live server, and the reason this is not simply `predicted_n > 0`:
      // during prefill llama.cpp attaches the SLOT's previous timings to every progress chunk.
      // A 22k-token prefill reported `predicted_n: 575` fourteen times in a row — the last
      // request's count — so the window would have shown "575 tokens · 47.7 tok/s" ticking
      // beside a request that had produced nothing, for the fifty-four seconds before its
      // first real token. Waiting for a delta of our own is what tells the two apart.
      if (sawGeneratedDelta) {
        const predicted = numberOr(parsed.timings?.predicted_n, 0)
        const now = performance.now()
        if (predicted > 0 && now - lastProgressAtMs >= PROGRESS_MIN_INTERVAL_MS) {
          lastProgressAtMs = now
          const perSecond = parsed.timings?.predicted_per_second
          // A rate over ONE token is not a rate: the server divides by an elapsed time of
          // very nearly zero and the answer explodes. Measured live, the first frame after a
          // warm prefill reported `predicted_per_second: 1000000` — which would have flashed
          // "1 tokens · 1000000 tok/s" on screen and read as a broken readout. The count
          // itself is true and is still shown; only the rate waits for a second token.
          const rateIsMeaningful = predicted >= 2 && typeof perSecond === 'number' &&
            Number.isFinite(perSecond)
          cb?.onDelta?.({
            progress: {
              generated: {
                tokens: predicted,
                ...(rateIsMeaningful ? { perSecond: perSecond as number } : {}),
              },
            },
          })
        }
      }
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      outer: while (true) {
        const { done, value } = await reader.read()
        if (value) buffer += decoder.decode(value, { stream: true })
        if (done) buffer += decoder.decode()

        let match: RegExpMatchArray | null
        // SSE events are separated by a blank line; tolerate CRLF as well as LF.
        while ((match = buffer.match(/\r?\n\r?\n/)) !== null) {
          const boundary = match.index ?? 0
          const eventText = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + match[0].length)
          if (handleEvent(eventText) === 'done') break outer
        }
        if (done) break
      }
    } catch (cause) {
      // Whatever text had been assembled survives the throw (Task 5 needs it to keep the
      // partial in the transcript on an interrupt instead of discarding it).
      const partial = { reasoning, content }
      if (signal.aborted) {
        throw new LlamaRequestError(
          `llama.cpp request failed: stream aborted (${String(cause)})`,
          { answered: false, partial },
        )
      }
      // The response had already arrived (2xx, headers read) before the stream broke, so
      // this is the server having answered and then the connection dropping mid-body —
      // not the "nothing is there" case.
      //
      // This throw did NOT come from the abort signal, so nothing is tearing the
      // connection down on our behalf — reader.read() rejected for some other reason
      // (malformed chunk, handleEvent/onDelta throwing, a raw socket error) and, left
      // alone, the server keeps holding the request open. Cancel explicitly so the slot
      // is released instead of sitting until the transport timeout.
      await reader.cancel().catch(() => {})
      throw new LlamaRequestError(
        `llama.cpp request failed: stream read error (${String(cause)})`,
        { answered: true, body: String(cause).slice(0, MAX_ERROR_BODY_CHARS), partial },
      )
    }

    if (!sawFinishReason) {
      // The read loop ended (reader `done`, no exception) without ever seeing a
      // finish_reason chunk — the peer closed the connection mid-generation. Left alone
      // this assembles into a normal-looking ChatResult (finishReason 'unknown'),
      // indistinguishable from a real completion and masking truncation. A stream that
      // saw finish_reason but only lost the trailing usage chunk / `[DONE]` still falls
      // through below and returns normally — that is a graceful degradation, not this.
      throw new LlamaRequestError(
        'llama.cpp stream ended before completion (connection dropped mid-generation)',
        { answered: true, partial: { reasoning, content } },
      )
    }

    const wallSeconds = (performance.now() - started) / 1000
    const message: ChatResult['message'] = {
      role: 'assistant',
      content: content.length > 0 ? content : null,
      ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.size > 0
        ? {
          tool_calls: [...toolCalls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, entry]) => ({
              id: entry.id,
              type: 'function' as const,
              function: { name: entry.name, arguments: entry.arguments },
            })),
        }
        : {}),
    }
    return {
      message,
      finishReason,
      ...(usage !== undefined ? { usage } : {}),
      ...(timings !== undefined ? { timings } : {}),
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
