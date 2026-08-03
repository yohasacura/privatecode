import type { AgentEvents } from '../agent/loop.js'
import { LlamaRequestError } from '../llama/client.js'

/** The up-front liveness probe must fail fast, not inherit the turn client's 600 s
 * transport timeout -- see the health-check call site for why. */
export const HEALTH_CHECK_TIMEOUT_MS = 5_000

export function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`
}

/**
 * Actionable, not a stack trace: names the server and how to start it.
 *
 * Only for a genuine connectivity failure -- the server never answered at all (refused
 * connection, DNS failure, timed out). Do not use this for an HTTP error response; the
 * server answering with a status code proves it is up, and telling the user to restart
 * something that is already running is actively misleading. See serverErrorMessage for
 * that case.
 */
export function serverUnreachableMessage(server: string, detail?: string): string {
  return (
    `\nCould not reach llama.cpp at ${server}${detail ? ` (${detail})` : ''}.\n` +
    'Start it with D:\\LocalAgentAI\\Start-QwenServer.bat and wait for the dashboard to ' +
    'show RUNNING with VRAM free, then try again. Pass --server <url> if it runs ' +
    'somewhere else.\n'
  )
}

/**
 * llama.cpp answered: the process is up and reachable, so the restart advice in
 * serverUnreachableMessage does not apply and must not be shown here.
 *
 * See cli.ts's original comment (this function's home before Task 10) for the full
 * demonstrated case: a live server answering HTTP 500 or a non-JSON 200 both mean "the
 * server is up and replying", most likely a context-window overflow, not a dead process.
 */
export function serverErrorMessage(server: string, err: LlamaRequestError): string {
  const what = err.status === undefined
    ? 'it sent a reply this client could not use'
    : `it answered HTTP ${err.status}`
  const body = err.body ? `\nServer response: ${err.body}` : ''
  return (
    `\nllama.cpp at ${server} is running and answered, but the request failed: ${what}.\n` +
    `${err.message}${body}\n` +
    'The server is not down, so restarting it is unlikely to help. On a local model, a ' +
    'mid-turn failure like this is most often the conversation exceeding the context ' +
    'window; try a shorter task or a fresh session. Pass --server <url> if this points at ' +
    'the wrong server.\n'
  )
}

/** Whichever of the two messages above applies to an exception escaping a turn. */
export function turnErrorMessage(server: string, e: unknown): string {
  if (e instanceof LlamaRequestError && e.answered) return serverErrorMessage(server, e)
  return serverUnreachableMessage(server, e instanceof Error ? e.message : String(e))
}

export interface TurnStats {
  steps: number
  /** Sum of onStepDone's completionTokens across the steps seen since the last reset(). */
  totalTokens: number
  /** Sum of onStepDone's seconds across the steps seen since the last reset(). */
  totalSeconds: number
}

export interface EventRenderer {
  events: AgentEvents
  /** Zeroes the running totals; call before each turn so a status line reflects only that
   * turn, not every turn the renderer has ever seen. Also clears any in-place status line
   * left over from a previous turn (defensive -- every code path that can leave one
   * pending already clears it itself, but a turn boundary is a natural place to guarantee
   * a clean slate). */
  reset(): void
  stats(): TurnStats
  /**
   * Erases the in-place `[thinking\u2026 ~N tok]` status line if one is currently displayed; a
   * no-op otherwise (safe to call unconditionally, from anywhere, at any time -- including
   * when streaming was never enabled, in which case a status line is never shown and this
   * never does anything).
   *
   * This is the ONE shared choke point for "something is about to print and must not land
   * on top of a `\r`-positioned status line": every print site that can interleave with
   * the live line calls this first -- step banners, tool lines, assistant content, the
   * post-turn status line, and (from `repl.ts`'s `write` adapter) approval/askUser/todos
   * prompts. render.ts's own event handlers call it internally; repl.ts calls it directly
   * at its own print sites, since those live outside any single AgentEvents callback.
   */
  clearStatusLine(): void
}

/**
 * The console rendering of a turn's events -- step markers, tool calls/results, assistant
 * prose. This is the same ~15-line block cli.ts's one-shot path used to build inline; it
 * is extracted here so cli.ts and cli/repl.ts share one copy instead of drifting apart.
 * Also accumulates the per-step token/second totals the REPL's post-turn status line
 * needs; cli.ts's one-shot path ignores `stats()` entirely.
 *
 * `opts.stream` opts into live rendering: incremental `onThinkingDelta`/`onTextDelta`
 * handlers are wired onto `events` ONLY when `opts.stream` is true AND
 * `process.stdout.isTTY === true` (checked once, here, at construction -- a process's
 * stdout does not change from a pipe to a terminal partway through its life, so there is
 * nothing to gain from re-checking per event). Omitting `opts.stream` (cli.ts's one-shot
 * path, unchanged) reproduces today's non-streaming behavior exactly, on a TTY or not --
 * `onThinkingDelta`/`onTextDelta` are never set on `events` at all, so `Agent` never
 * switches to `chatStream()` (see loop.ts's `chat()`: streaming is opt-in per the
 * PRESENCE of those callbacks, not their content). Piped/non-TTY stdout gets the same
 * treatment even when the caller passes `stream: true` (repl.ts always does): the whole-
 * blob path is what a pipe gets, unconditionally -- no `\r` tricks ever reach a non-TTY
 * stream.
 *
 * When streaming IS active, `onThinkingDelta` rewrites one dim in-place status line
 * (`\x1b[2K\r` -- erase-in-line then carriage-return, which is a `\r` rewrite robust to
 * the new text being shorter than the old, unlike a bare `\r`) with a growing token
 * estimate; `onTextDelta` prints content verbatim as it arrives (no color, no wrapping,
 * one write per chunk). `onThinking`'s existing one-line summary and `onAssistantText`'s
 * existing wrapping are both KEPT, not replaced: `onThinking` because the live status
 * line's final state is never left in scrollback once cleared, so this is the only
 * permanent record of "how much was thought" for a completed step; `onAssistantText`
 * because it still needs to run for the non-streaming case (and it deliberately skips
 * re-printing the text when this step's content already streamed via `onTextDelta`, so
 * the same prose is never shown twice).
 */
export function createEventRenderer(opts?: { stream?: boolean }): EventRenderer {
  const streaming = opts?.stream === true && process.stdout.isTTY === true

  let steps = 0
  let totalTokens = 0
  let totalSeconds = 0

  let statusLineActive = false
  /** Chars of reasoning seen so far THIS model call (reset at the start of each one --
   * `onStepStart` for the first call of a step, `onContinuation` for the truncation
   * continuation's second call) -- mirrors `onThinking`'s own `t.length`, which is also
   * scoped to a single call's `reasoning_content`, never accumulated across calls. */
  let thinkingChars = 0
  /** Whether this call's visible content has started printing via `onTextDelta` (so the
   * first chunk gets a leading blank line, matching `onAssistantText`'s old `\n${t}\n`). */
  let contentStarted = false
  /** Whether `onTextDelta` fired at all for the content `onAssistantText` is about to
   * report -- when true, the text already streamed to the terminal and must not be
   * printed again. */
  let textStreamed = false

  function clearStatusLine(): void {
    if (!statusLineActive) return
    process.stdout.write('\x1b[2K\r')
    statusLineActive = false
  }

  const events: AgentEvents = {
    // A step can run 40-90 s; printing nothing until it ends is the one thing this
    // interface must not do. This line is the countdown's starting gun.
    onStepStart: (i) => {
      clearStatusLine()
      thinkingChars = 0
      contentStarted = false
      textStreamed = false
      console.log(`\x1b[90m--- step ${i.step} (budget ${fmtDuration(i.timeoutMs)}) ---\x1b[0m`)
    },
    onThinking: (t) => {
      clearStatusLine()
      // In streaming mode with streamed content, the live status line already showed thinking
      // progress and the text is already displayed — the summary would glue to the last line
      // with no separator. Non-streaming/non-TTY paths have textStreamed=false always,
      // so this guard proves they print the summary unchanged.
      if (streaming && textStreamed) return
      console.log(`\x1b[90m[thinking, ~${Math.ceil(t.length / 4)} tok]\x1b[0m`)
    },
    onContinuation: (s) => {
      clearStatusLine()
      thinkingChars = 0
      contentStarted = false
      textStreamed = false
      console.log(`\x1b[33m! step ${s} ran out of room while thinking; forcing an action now\x1b[0m`)
    },
    onToolCall: (n, a) => {
      clearStatusLine()
      console.log(`\x1b[36m\u2192 ${n}\x1b[0m ${a.slice(0, 200)}`)
    },
    onToolResult: (n, r) => {
      clearStatusLine()
      console.log(
        `${r.ok ? '\x1b[32m\u2713' : '\x1b[31m\u2717'} ${n}\x1b[0m ${r.content.split('\n')[0]?.slice(0, 200)}`)
    },
    onAssistantText: (t) => {
      clearStatusLine()
      if (textStreamed) {
        // Already printed verbatim via onTextDelta -- reproduce only the trailing spacing
        // `\n${t}\n` + console.log's own newline would have added, not the text itself.
        process.stdout.write('\n\n')
      } else {
        console.log(`\n${t}\n`)
      }
      textStreamed = false
      contentStarted = false
    },
    onStepDone: (i) => {
      // Must clear even though onThinking (above) usually already did: an aborted call
      // never calls report()/onThinking at all (loop.ts's chat() returns {kind:'aborted'}
      // before runStep's report() call), yet onStepDone still fires from runStep's
      // `finally` -- so this can be the FIRST print after a mid-stream abort.
      clearStatusLine()
      steps = i.step
      if (i.completionTokens !== undefined) totalTokens += i.completionTokens
      totalSeconds += i.seconds
      console.log(
        `\x1b[90m  ${i.seconds.toFixed(1)}s` +
        `${i.tokensPerSecond ? `, ${i.tokensPerSecond.toFixed(1)} tok/s` : ''}` +
        `${i.continued ? ', continued after truncation' : ''}\x1b[0m`)
    },
    ...(streaming ? {
      onThinkingDelta: (t: string) => {
        clearStatusLine()
        thinkingChars += t.length
        process.stdout.write(`\x1b[90m[thinking\u2026 ~${Math.ceil(thinkingChars / 4)} tok]\x1b[0m`)
        statusLineActive = true
      },
      onTextDelta: (t: string) => {
        clearStatusLine()
        if (!contentStarted) {
          process.stdout.write('\n')
          contentStarted = true
        }
        process.stdout.write(t)
        textStreamed = true
      },
    } : {}),
  }

  return {
    events,
    reset() {
      steps = 0
      totalTokens = 0
      totalSeconds = 0
      thinkingChars = 0
      contentStarted = false
      textStreamed = false
      clearStatusLine()
    },
    stats: () => ({ steps, totalTokens, totalSeconds }),
    clearStatusLine,
  }
}
