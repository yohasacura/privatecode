import { existsSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { LlamaClient } from './llama/client.js'
import { Workspace } from './workspace.js'
import { createToolset, READ_ONLY_TOOLS } from './tools/default-set.js'
import { PermissionEngine, type AgentMode } from './permissions/engine.js'
import { loadLayers } from './permissions/settings.js'
import { Session, type SessionOptions } from './session/session.js'
import { SessionStore } from './session/store.js'
import { createConsolePort, type ReadlineLike } from './cli/console-port.js'
import { createEventRenderer, HEALTH_CHECK_TIMEOUT_MS, serverUnreachableMessage, turnErrorMessage } from './cli/render.js'
import { runRepl } from './cli/repl.js'

const DEFAULT_SERVER = 'http://127.0.0.1:8080'
const MODEL = 'Qwen3.6-35B-A3B'

const VALID_MODES: readonly AgentMode[] = ['normal', 'plan', 'auto-edit', 'autopilot']

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

/**
 * `--plan` wins for back-compat when both are given. Returns `value: undefined` when
 * neither flag was given at all -- distinct from resolving to `'normal'` -- so a resumed
 * session's own stored mode is free to win instead of being silently clobbered to
 * 'normal' by every invocation that didn't ask for a mode.
 */
function resolveMode(values: { plan?: boolean; mode?: string }):
  { ok: true; value: AgentMode | undefined } | { ok: false; error: string } {
  if (values.plan) return { ok: true, value: 'plan' }
  if (values.mode === undefined) return { ok: true, value: undefined }
  if (!VALID_MODES.includes(values.mode as AgentMode)) {
    return { ok: false, error: `--mode must be one of ${VALID_MODES.join(', ')}, got "${values.mode}"` }
  }
  return { ok: true, value: values.mode as AgentMode }
}

const USAGE =
  'usage: npm run agent -- --workspace <dir> [--task "<text>"]\n' +
  '                         [--mode normal|plan|auto-edit|autopilot] [--plan]\n' +
  '                         [--server <url>] [--steps <n>] [--resume <id>]\n' +
  '  --task "<text>"  run one turn and exit (approvals prompt on a TTY, fail closed otherwise)\n' +
  '  (no --task)      start the interactive REPL\n' +
  '  --resume <id>    continue a saved session (REPL only; one-shot runs have no store)'

/** Builds a plain, raw-mode-free ReadlineLike for the one-shot `--task` path: it never
 * runs a turn the user can abort mid-flight, so it needs none of the REPL's keypress
 * plumbing -- just enough to let an approval prompt (Allow? / always / askUser) work. */
function createOneShotReadline(): { adapter: ReadlineLike; close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return {
    adapter: {
      question: (prompt: string) => rl.question(prompt),
      write: (text: string) => process.stdout.write(text),
    },
    close: () => rl.close(),
  }
}

async function main() {
  let values: {
    workspace?: string
    task?: string
    server?: string
    plan?: boolean
    steps?: string
    mode?: string
    resume?: string
  }
  try {
    ;({ values } = parseArgs({
      options: {
        workspace: { type: 'string' },
        task: { type: 'string' },
        server: { type: 'string', default: DEFAULT_SERVER },
        plan: { type: 'boolean', default: false },
        steps: { type: 'string', default: '40' },
        mode: { type: 'string' },
        resume: { type: 'string' },
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
  if (!values.workspace) {
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

  const modeParsed = resolveMode(values)
  if (!modeParsed.ok) {
    console.error(`${modeParsed.error}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }

  if (values.task !== undefined && values.resume !== undefined) {
    console.error('note: --resume is ignored with --task')
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
  const toolset = createToolset()

  if (values.task === undefined) {
    // Interactive REPL: its own store-backed sessions, its own banner, its own health
    // reporting (the up-front hard health() gate below is one-shot-only — a REPL should
    // still start and show /sessions, /todos etc. even with the server down, and let the
    // banner's own props() probe reveal connectivity softly instead of refusing to run
    // at all).
    const store = new SessionStore(values.workspace)
    const replOpts: Parameters<typeof runRepl>[0] = {
      client, server, model: MODEL, workspaceRoot: values.workspace, toolset,
      maxSteps: stepsParsed.value, store,
    }
    if (modeParsed.value !== undefined) replOpts.mode = modeParsed.value
    if (values.resume !== undefined) replOpts.resume = values.resume
    await runRepl(replOpts)
    return
  }

  // One-shot `--task`: a dead or unreachable server is not a turn outcome — it is checked
  // up front so the failure names the server and the fix instead of surfacing mid-turn as
  // a raw transport exception once the model already looks like it is "thinking". Uses
  // its own short-timeout client rather than `client` above: `client` carries the turn's
  // 600 s transport timeout, which is right for a real generation but means a
  // black-holed --server (accepts the TCP connection, then never answers) printed
  // nothing for ten minutes before this probe ever failed.
  const healthClient = new LlamaClient({
    baseUrl: server, model: MODEL, requestTimeoutMs: HEALTH_CHECK_TIMEOUT_MS,
  })
  if (!(await healthClient.health())) {
    console.error(serverUnreachableMessage(server))
    process.exitCode = 1
    return
  }

  const mode = modeParsed.value ?? 'normal'
  if (mode === 'plan') {
    // Agent derives its own restriction from the registry regardless of what is passed
    // here; this line only tells the user what that restriction is.
    console.log(`\x1b[90mplan mode: read-only tools only (${READ_ONLY_TOOLS.join(', ')})\x1b[0m`)
  }

  const { layers, problems } = loadLayers(values.workspace)
  const engine = new PermissionEngine({ layers, mode, workspaceRoot: values.workspace, problems })
  for (const p of engine.problems) console.error(`settings: ${p}`)

  // No interaction port at all when stdout is not a TTY: an `ask` verdict then fails
  // closed with the loop's own "no interactive host is connected" message instead of
  // hanging a script or CI run on a prompt nobody can answer.
  const oneShotReadline = process.stdout.isTTY ? createOneShotReadline() : undefined
  const renderer = createEventRenderer()

  const sessionOpts: SessionOptions = {
    client,
    toolset,
    workspaceRoot: values.workspace,
    mode,
    engine,
    maxSteps: stepsParsed.value,
    events: renderer.events,
  }
  if (oneShotReadline) sessionOpts.interaction = createConsolePort(oneShotReadline.adapter)
  const session = new Session(sessionOpts)

  let result
  try {
    result = await session.send(values.task)
  } catch (e) {
    // Session.send absorbs abort/timeout into stoppedBecause, but a genuine transport
    // failure still escapes as an exception — that is not a turn outcome and must not
    // print as an unhandled stack trace.
    console.error(turnErrorMessage(server, e))
    process.exitCode = 1
    return
  } finally {
    oneShotReadline?.close()
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
