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
   * turn, not every turn the renderer has ever seen. */
  reset(): void
  stats(): TurnStats
}

/**
 * The console rendering of a turn's events -- step markers, tool calls/results, assistant
 * prose. This is the same ~15-line block cli.ts's one-shot path used to build inline; it
 * is extracted here so cli.ts and cli/repl.ts share one copy instead of drifting apart.
 * Also accumulates the per-step token/second totals the REPL's post-turn status line
 * needs; cli.ts's one-shot path ignores `stats()` entirely.
 */
export function createEventRenderer(): EventRenderer {
  let steps = 0
  let totalTokens = 0
  let totalSeconds = 0

  const events: AgentEvents = {
    // A step can run 40-90 s; printing nothing until it ends is the one thing this
    // interface must not do. This line is the countdown's starting gun.
    onStepStart: (i) => console.log(
      `\x1b[90m--- step ${i.step} (budget ${fmtDuration(i.timeoutMs)}) ---\x1b[0m`),
    onThinking: (t) => console.log(`\x1b[90m[thinking, ~${Math.ceil(t.length / 4)} tok]\x1b[0m`),
    onContinuation: (s) => console.log(
      `\x1b[33m! step ${s} ran out of room while thinking; forcing an action now\x1b[0m`),
    onToolCall: (n, a) => console.log(`\x1b[36m\u2192 ${n}\x1b[0m ${a.slice(0, 200)}`),
    onToolResult: (n, r) => console.log(
      `${r.ok ? '\x1b[32m\u2713' : '\x1b[31m\u2717'} ${n}\x1b[0m ${r.content.split('\n')[0]?.slice(0, 200)}`),
    onAssistantText: (t) => console.log(`\n${t}\n`),
    onStepDone: (i) => {
      steps = i.step
      if (i.completionTokens !== undefined) totalTokens += i.completionTokens
      totalSeconds += i.seconds
      console.log(
        `\x1b[90m  ${i.seconds.toFixed(1)}s` +
        `${i.tokensPerSecond ? `, ${i.tokensPerSecond.toFixed(1)} tok/s` : ''}` +
        `${i.continued ? ', continued after truncation' : ''}\x1b[0m`)
    },
  }

  return {
    events,
    reset() { steps = 0; totalTokens = 0; totalSeconds = 0 },
    stats: () => ({ steps, totalTokens, totalSeconds }),
  }
}
