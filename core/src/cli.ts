import { existsSync, statSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Agent } from './agent/loop.js'
import { LlamaClient, LlamaRequestError } from './llama/client.js'
import { Workspace } from './workspace.js'
import { buildRegistry, READ_ONLY_TOOLS } from './tools/default-set.js'

const DEFAULT_SERVER = 'http://127.0.0.1:8080'
const MODEL = 'Qwen3.6-35B-A3B'

/** The up-front liveness probe must fail fast, not inherit the turn client's 600 s
 * transport timeout — see the health-check call site for why. */
const HEALTH_CHECK_TIMEOUT_MS = 5_000

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`
}

/**
 * Actionable, not a stack trace: names the server and how to start it.
 *
 * Only for a genuine connectivity failure — the server never answered at all (refused
 * connection, DNS failure, timed out). Do not use this for an HTTP error response; the
 * server answering with a status code proves it is up, and telling the user to restart
 * something that is already running is actively misleading. See serverErrorMessage for
 * that case.
 */
function serverUnreachableMessage(server: string, detail?: string): string {
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
 * Demonstrated case: a live, RUNNING server answered a mid-turn request with HTTP 500,
 * and the old code printed "Could not reach llama.cpp ... Start it with
 * Start-QwenServer.bat" for a server that was already running. llama.cpp returns 4xx/5xx
 * for things like context-window overflow, which on a 35B local model with a long
 * transcript is one of the most likely real mid-turn failures — so this says what the
 * server actually replied instead of misdiagnosing it as connectivity.
 *
 * "Answered" is broader than "answered with an error status", which is why this no longer
 * assumes `err.status` exists. A 200 carrying a non-JSON body, and a 200 carrying JSON
 * with no `choices` — llama.cpp's own shape for a refused request — are both a running
 * server replying, and both used to reach the branch below this one.
 */
function serverErrorMessage(server: string, err: LlamaRequestError): string {
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

/** Parses a required positive-integer CLI flag, returning a usage error instead of NaN,
 * a negative step count, or a raw parseArgs stack trace for a value like "-3". */
function parsePositiveInt(raw: string, flag: string): { ok: true; value: number } | { ok: false; error: string } {
  if (!/^\d+$/.test(raw.trim())) {
    return { ok: false, error: `--${flag} must be a positive whole number, got "${raw}"` }
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, error: `--${flag} must be a positive whole number, got "${raw}"` }
  }
  return { ok: true, value }
}

const USAGE = 'usage: npm run agent -- --workspace <dir> --task "<text>" [--plan] ' +
  '[--server <url>] [--steps <n>]'

async function main() {
  let values: {
    workspace?: string
    task?: string
    server?: string
    plan?: boolean
    steps?: string
  }
  try {
    ;({ values } = parseArgs({
      options: {
        workspace: { type: 'string' },
        task: { type: 'string' },
        server: { type: 'string', default: DEFAULT_SERVER },
        plan: { type: 'boolean', default: false },
        steps: { type: 'string', default: '40' },
      },
    }))
  } catch (e) {
    // node's parseArgs throws (ERR_PARSE_ARGS_INVALID_OPTION_VALUE etc.) on things like
    // `--steps -3`, where the value looks like another flag. Uncaught, that reached the
    // user as a raw stack trace for what is an ordinary usage mistake.
    console.error(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  if (!values.workspace || !values.task) {
    console.error(USAGE)
    process.exitCode = 2
    return
  }

  const stepsParsed = parsePositiveInt(values.steps ?? '40', 'steps')
  if (!stepsParsed.ok) {
    // Bare `Number(values.steps)` used to hand max_steps = NaN straight to Agent, which
    // then reported "max_steps after NaN steps" without ever calling the model — an
    // opaque failure for what is just a bad flag value.
    console.error(`${stepsParsed.error}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }

  // `new Workspace(dir)` does not check the directory exists — it only resolves and
  // canonicalizes paths. Pointing --workspace at a typo'd or nonexistent directory used
  // to burn several full model steps (every tool call failing with ENOENT) before the
  // turn gave up, instead of failing in under a second.
  if (!existsSync(values.workspace) || !statSync(values.workspace).isDirectory()) {
    console.error(`\nWorkspace directory not found: ${values.workspace}\n`)
    process.exitCode = 2
    return
  }

  const server = values.server ?? DEFAULT_SERVER
  const client = new LlamaClient({ baseUrl: server, model: MODEL })

  // A dead or unreachable server is not a turn outcome — it is checked up front so the
  // failure names the server and the fix instead of surfacing mid-turn as a raw
  // transport exception once the model already looks like it is "thinking". Uses its own
  // short-timeout client rather than `client` above: `client` carries the turn's 600 s
  // transport timeout, which is right for a real generation but means a black-holed
  // --server (accepts the TCP connection, then never answers) printed nothing for ten
  // minutes before this probe ever failed.
  const healthClient = new LlamaClient({
    baseUrl: server, model: MODEL, requestTimeoutMs: HEALTH_CHECK_TIMEOUT_MS,
  })
  if (!(await healthClient.health())) {
    console.error(serverUnreachableMessage(server))
    process.exitCode = 1
    return
  }

  const registry = buildRegistry()
  const mode = values.plan ? 'plan' : 'normal'
  if (mode === 'plan') {
    // Agent derives its own restriction from the registry regardless of what is passed
    // here; this line only tells the user what that restriction is.
    console.log(`\x1b[90mplan mode: read-only tools only (${READ_ONLY_TOOLS.join(', ')})\x1b[0m`)
  }

  const agent = new Agent({
    client,
    registry,
    context: { workspace: new Workspace(values.workspace) },
    mode,
    maxSteps: stepsParsed.value,
    events: {
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
      onStepDone: (i) => console.log(
        `\x1b[90m  ${i.seconds.toFixed(1)}s` +
        `${i.tokensPerSecond ? `, ${i.tokensPerSecond.toFixed(1)} tok/s` : ''}` +
        `${i.continued ? ', continued after truncation' : ''}\x1b[0m`),
    },
  })

  let result
  try {
    result = await agent.runTurn(values.task)
  } catch (e) {
    // runTurn absorbs abort/timeout into stoppedBecause, but a genuine transport failure
    // still escapes as an exception — that is not a turn outcome and must not print as an
    // unhandled stack trace. Not every escaped exception means the same thing, though:
    // LlamaRequestError.answered says whether the server produced a response at all, as
    // opposed to the request never reaching it (connection refused, DNS failure, our own
    // timeout). Those two must not share a message — one means "start the server", the
    // other means the server is up and the request failed (most likely context overflow
    // on a local model).
    //
    // This used to branch on `e.status !== undefined`, which asks "did the HTTP layer
    // error", not "did the server answer": a 200 with a non-JSON body escaped as a raw
    // SyntaxError and a 200 with no `choices` carried `status: undefined`, so both landed
    // in the "start the server" branch for a server that had just replied.
    if (e instanceof LlamaRequestError && e.answered) {
      console.error(serverErrorMessage(server, e))
    } else {
      console.error(serverUnreachableMessage(server, e instanceof Error ? e.message : String(e)))
    }
    process.exitCode = 1
    return
  }

  console.log(`\n--- ${result.stoppedBecause} after ${result.steps} step${result.steps === 1 ? '' : 's'} ---`)
  if (result.stoppedBecause === 'timeout' || result.stoppedBecause === 'truncated') {
    console.log(
      '(this is a real outcome on a slow local model, not necessarily a defect in the task)')
  }
  process.exitCode = result.stoppedBecause === 'done' ? 0 : 1
}

// process.exitCode, never process.exit(): on Windows, some runs of this CLI that called
// process.exit() at the end crashed instead of exiting with the correct code, printing
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
// (surfacing as exit code 127) even though the turn itself had already finished cleanly.
//
// What is and is not established: both crashing runs involved a step that used
// search_code, i.e. had spawned an execa child process; a read_file-only plan run, with
// the same 90 s step AbortSignal.timeout() armed and ~88 s of it still unexpired, exited
// 0 cleanly three times out of three. Minimal repros of "an armed AbortSignal.timeout()
// plus a pending fetch, then process.exit()" were clean, and so were the same plus a
// spawned execa child — so the trigger is narrower than either "a pending step timer" or
// "a spawned child process" alone. The precise trigger is NOT established.
//
// Do not reason from that gap to "this exit path has no pending timer / spawned no
// child, so process.exit() is safe here": that is exactly the reasoning that reintroduces
// this crash, and the actual trigger is not known well enough to rule any path out.
// process.exitCode plus letting main() resolve and the event loop drain naturally sets
// the same exit code without forcing synchronous teardown, and has shown no crash in any
// run since switching to it. Do not reintroduce process.exit() on any path here.
main().catch((e) => { console.error(e); process.exitCode = 1 })
