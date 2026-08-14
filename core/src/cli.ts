import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { LlamaClient } from './llama/client.js'
import { Workspace } from './workspace.js'
import { loadMounts } from './mounts.js'
import { discoverUnits } from './checkpoints/units.js'
import { createToolset, READ_ONLY_TOOLS } from './tools/default-set.js'
import { loadBrowserSettings } from './browser/settings.js'
import { loadDatabaseSettings } from './sql/settings.js'
import { loadServers } from './mcp/config.js'
import { McpManager } from './mcp/manager.js'
import { runUnattended } from './cli/unattended.js'
import { PermissionEngine, type AgentMode } from './permissions/engine.js'
import { loadLayers } from './permissions/settings.js'
import { loadProjectMemory } from './memory/project-memory.js'
import { loadSkills } from './skills/skills.js'
import { loadFormatRules } from './format/config.js'
import { loadHooks } from './hooks/hooks.js'
import { loadVerify } from './verify/config.js'
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

/**
 * A positive-number flag, or `undefined` to keep the default.
 *
 * Silently ignoring a typo'd budget is the one behaviour to avoid here: someone who wrote
 * `--max-hours 8h` and got the eight-hour default by accident never learns they were lucky,
 * and someone who got a fifty-turn default when they asked for five has a very different
 * night than they planned.
 */
function numberFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`ignoring "${raw}": expected a positive number`)
    return undefined
  }
  return value
}

const USAGE =
  'usage: npm run agent -- --workspace <dir> [--task "<text>"]\n' +
  '                         [--mode normal|plan|auto-edit|autopilot] [--plan]\n' +
  '                         [--server <url>] [--steps <n>] [--resume <id>]\n' +
  '  --task "<text>"  run one turn and exit (approvals prompt on a TTY, fail closed otherwise)\n' +
  '  (no --task)      start the interactive REPL\n' +
  '  --resume <id>    continue a saved session\n' +
  '  --unattended     keep taking turns until the work is done or a budget stops it;\n' +
  '                   an unanswered approval is queued instead of blocking the run\n' +
  '  --max-turns <n>  turn budget for --unattended (default 50)\n' +
  '  --max-hours <n>  wall-clock budget for --unattended (default 8)'

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
    unattended?: boolean
    'max-turns'?: string
    'max-hours'?: string
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
        unattended: { type: 'boolean', default: false },
        'max-turns': { type: 'string' },
        'max-hours': { type: 'string' },
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
  const browserSettings = loadBrowserSettings(values.workspace)
  for (const p of browserSettings.problems) console.error(`settings: ${p}`)
  // Read here as well as in the host: the CLI builds its own session, and a setting wired
  // into only one of the two entry points is a feature that works in the window and does
  // nothing in the terminal -- which is precisely the shape of the bug that left `csharp_nav`
  // advertised and unusable on this path for a day.
  const databaseSettings = loadDatabaseSettings(values.workspace)
  for (const p of databaseSettings.problems) console.error(`settings: ${p}`)
  const toolset = createToolset({ browser: browserSettings.options })

  // The CLI gets the same MCP servers the app does. Two products that quietly differ in
  // which tools exist is the kind of difference nobody thinks to check until a script that
  // works in the window fails on the command line.
  const mcpConfig = loadServers(values.workspace)
  for (const p of mcpConfig.problems) console.error(`mcp: ${p}`)
  const mcp = new McpManager()
  if (mcpConfig.servers.length > 0) {
    for (const p of await mcp.connectAll(mcpConfig.servers, toolset.registry)) {
      console.error(`mcp: ${p}`)
    }
  }
  // Every external process this CLI owns, torn down on every exit path.
  const stopExternal = async (): Promise<void> => {
    await Promise.all([
      toolset.background.stopAll().catch(() => {}),
      toolset.browser.close().catch(() => {}),
      mcp.closeAll().catch(() => {}),
    ])
  }

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
    replOpts.stopExternal = stopExternal
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
  // Without this a one-shot --task would silently behave differently from the REPL in the
  // same workspace, which is the kind of difference nobody ever thinks to check.
  const memory = loadProjectMemory(values.workspace)
  problems.push(...memory.problems)
  // Same argument once more: a workspace's skills are part of what the agent IS there, and
  // a REPL that did not offer them would be a second set of rules for the same project.
  const skills = loadSkills(values.workspace)
  problems.push(...skills.problems)
  // Same argument as the line above, applied to the rest of the workspace's configuration:
  // a one-shot --task that quietly skipped the formatter, the after-tool hooks and the
  // verify command was a second set of rules for the same project, and the comment warning
  // against exactly that was already here, above `memory`.
  const formatting = loadFormatRules(values.workspace)
  const hooking = loadHooks(values.workspace)
  const verifying = loadVerify(values.workspace)
  problems.push(...formatting.problems, ...hooking.problems, ...verifying.problems)
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
  if (memory.layers.length > 0) sessionOpts.memory = memory
  if (databaseSettings.database !== null) sessionOpts.database = databaseSettings.database
  if (skills.skills.length > 0) sessionOpts.skills = skills
  if (formatting.rules.length > 0) sessionOpts.formatRules = formatting.rules
  if (hooking.hooks.length > 0) sessionOpts.hooks = hooking.hooks
  if (verifying.verify) {
    sessionOpts.verify = verifying.verify
    sessionOpts.onVerify = (info) => {
      const how = info.problem ?? (info.ok ? 'passed' : 'FAILED')
      console.log(`[90m  verified with ${info.command}: ${how}[0m`)
    }
  }
  if (oneShotReadline) sessionOpts.interaction = createConsolePort(oneShotReadline.adapter)
  if (values.unattended) {
    // A long run needs somewhere to save its turns: without a store the work log's turn
    // numbers and the session it refers to would not survive the process.
    sessionOpts.store = new SessionStore(values.workspace)
    sessionOpts.longRun = true
    sessionOpts.unattended = {}
  }
  // The folders this workspace is made of, and what an undo has to cover. Wired here as well
  // as in the host, deliberately: the last time this path built its own options it quietly
  // lost the formatter, the hooks, memory and verify, and nothing said so.
  const loaded = loadMounts(values.workspace)
  for (const p of loaded.problems) console.error(`workspace: ${p}`)
  if (loaded.mounts.length > 1) sessionOpts.mounts = loaded.mounts
  if (sessionOpts.longRun) {
    sessionOpts.units = await discoverUnits(loaded.mounts, values.workspace)
  }

  const session = new Session(sessionOpts)

  // The REPL's own shutdown() calls toolset.background.stopAll() so a background_task
  // process never outlives the process that started it (see repl.ts). This one-shot path
  // is the other caller of the same Toolset contract, and used to skip that call entirely
  // -- a `background_task` start left a live child (and the execa/PowerShell handles that
  // keep the event loop alive) behind after the turn finished, so the process never
  // exited on its own. try/finally here, around both the send and the result report
  // below, guarantees stopAll() runs on every exit from this block: normal completion,
  // the catch-and-return below, or a throw from the console.log calls themselves.
  if (values.unattended) {
    const budget = {
      maxTurns: numberFlag(values['max-turns']),
      maxHours: numberFlag(values['max-hours']),
    }
    try {
      const summary = await runUnattended({
        session,
        task: values.task,
        ...(budget.maxTurns !== undefined ? { maxTurns: budget.maxTurns } : {}),
        ...(budget.maxHours !== undefined ? { maxHours: budget.maxHours } : {}),
        onTurn: ({ turn, text }) => {
          console.log(`\n\x1b[1m--- turn ${turn} ---\x1b[0m`)
          console.log(`\x1b[90m${text.split('\n')[0]?.slice(0, 120) ?? ''}\x1b[0m`)
        },
      })
      const plural = summary.turns === 1 ? '' : 's'
      console.log(`\n--- run ended: ${summary.stoppedBecause} after ${summary.turns} turn${plural} ---`)
      console.log(summary.detail)

      // Printed last and always, because it is the whole point of the night: a person who
      // walks up to this terminal in the morning needs the queue and the log, not a scroll
      // back through every turn.
      const pending = session.pendingDecisions()
      if (pending.length > 0) {
        const many = pending.length !== 1
        console.log(`\n${pending.length} decision${many ? 's' : ''} ${many ? 'are' : 'is'} waiting for you:`)
        for (const d of pending) {
          console.log(`  - ${d.kind === 'approval' ? `${d.tool}: ${d.summary}` : d.question}`)
        }
      }
      console.log(`\nWhat it did: ${join(values.workspace, '.privatecode', 'worklog.md')}`)
      for (const p of session.longRunProblems()) console.error(`long run: ${p}`)
      process.exitCode = summary.stoppedBecause === 'done' ? 0 : 1
    } finally {
      oneShotReadline?.close()
      await stopExternal()
    }
    return
  }

  try {
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
  } finally {
    await stopExternal()
  }
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
