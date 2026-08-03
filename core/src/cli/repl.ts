import { execa } from 'execa'
import { emitKeypressEvents, type Key } from 'node:readline'
import { createInterface } from 'node:readline/promises'
import type { TurnResult } from '../agent/loop.js'
import { LlamaClient } from '../llama/client.js'
import { PermissionEngine, type AgentMode } from '../permissions/engine.js'
import { loadLayers } from '../permissions/settings.js'
import { Session, type SessionOptions } from '../session/session.js'
import type { SessionStore } from '../session/store.js'
import type { Toolset } from '../tools/default-set.js'
import { createConsolePort, formatTodoLine, type ReadlineLike } from './console-port.js'
import { createEventRenderer, HEALTH_CHECK_TIMEOUT_MS, turnErrorMessage } from './render.js'

export interface ReplOptions {
  client: LlamaClient
  server: string
  model: string
  workspaceRoot: string
  toolset: Toolset
  /** Omit to let a resumed session keep its own stored mode, or a fresh one default to
   * 'normal' -- see buildSession's `explicitMode` parameter for why this must stay
   * distinguishable from "the user asked for normal mode". */
  mode?: AgentMode
  maxSteps: number
  store: SessionStore
  resume?: string
}

const VALID_MODES: readonly AgentMode[] = ['normal', 'plan', 'auto-edit', 'autopilot']

const HELP_TEXT =
  '\nCommands:\n' +
  '  /help              show this list\n' +
  '  /mode [m]          show the current mode, or switch to normal|plan|auto-edit|autopilot\n' +
  '  /new               start a new session\n' +
  '  /sessions          list saved sessions in this workspace\n' +
  '  /resume <id>       resume a saved session\n' +
  '  /todos             show the current todo list\n' +
  '  /compact           summarise and compact the context now\n' +
  '  /exit              save and quit\n\n' +
  'Anything else is sent to the model. Esc or Ctrl+C aborts a turn in progress; ' +
  'Ctrl+C twice at this prompt exits.\n'

/** The two states `onCompaction` renders unconditionally per the brief, plus `'failed'`
 * (an addition beyond the brief's exact strings -- see the Task 9 report -- so a
 * background attempt that silently dies is not silently invisible to the user too) and
 * `'postponed'` (added for the abort-is-not-failure and no-progress-guard fixes -- see
 * `CompactionEvent`'s doc comment in `session.ts`): a calm, dim line, deliberately NOT the
 * scarier `'failed'` wording, since neither of `'postponed'`'s causes (a cancelled
 * attempt, or a swap that would not have shrunk anything) is a generation error.
 * `'ready'` is deliberately left unrendered: it means a summary is waiting, not that
 * anything changed about the session yet, and the very next `'applied'` line (fired by
 * the following `send()`, or immediately after by `/compact`) is the one that matters. */
function renderCompactionEvent(info: { state: string; droppedMessages?: number }): string | undefined {
  switch (info.state) {
    case 'started': return '\x1b[2m[compacting context in the background…]\x1b[0m'
    case 'applied': return `\x1b[2m[context compacted: ${info.droppedMessages} earlier messages summarised]\x1b[0m`
    case 'postponed': return '\x1b[2m[context compaction postponed]\x1b[0m'
    case 'failed': return '\x1b[2m[context compaction failed; continuing uncompacted]\x1b[0m'
    default: return undefined
  }
}

/**
 * The REPL's post-turn "context ..." status segment, as a pure function of the numbers
 * involved -- extracted so a smoke script can drive it directly without a live server.
 *
 * Prefers the real, server-reported number: when `promptTokens` is known (non-null) AND
 * `contextLength` was learned at startup, renders `Nk/Nk (P%)` off the actual usage.
 * Otherwise falls back to the old character-count heuristic, `approxTokens`, labelled
 * `(approx)` so it is never mistaken for the real figure.
 */
export function formatContextLine(
  promptTokens: number | null,
  contextLength: number | undefined,
  approxTokens: number,
): string {
  if (promptTokens !== null && contextLength !== undefined) {
    const pct = Math.round((promptTokens / contextLength) * 100)
    return `context ${(promptTokens / 1000).toFixed(1)}k/${(contextLength / 1000).toFixed(1)}k (${pct}%)`
  }
  const used = `~${Math.round(approxTokens / 1000)}k`
  const base = contextLength === undefined
    ? `${used} tokens`
    : `${used}/${Math.round(contextLength / 1000)}k tokens`
  return `context ${base} (approx)`
}

/**
 * The only two functions in this file that touch stdin's raw mode. `onAbort` fires for
 * Escape or Ctrl+C for as long as the returned `stop` function has not been called; the
 * adapter's `question()` below is the other half of the pair -- it calls `stop()` before
 * every cooked-mode prompt (so normal line editing works and a typed 'n' is never misread
 * as an abort keystroke) and re-arms afterwards if the turn is still running.
 *
 * A no-op when stdin is not a TTY (piped input, the smoke scripts used to hand-verify this
 * REPL, CI): there is no raw mode to enter and no keystroke ever produces a 'keypress'
 * event worth reacting to, so `stop` is a no-op too.
 */
function startAbortListening(onAbort: () => void): () => void {
  const stdin = process.stdin
  if (!stdin.isTTY) return () => {}
  emitKeypressEvents(stdin)
  stdin.setRawMode(true)
  stdin.resume()
  const onKeypress = (_str: string, key: Key | undefined): void => {
    if (!key) return
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) onAbort()
  }
  stdin.on('keypress', onKeypress)
  return () => {
    stdin.off('keypress', onKeypress)
    stdin.setRawMode(false)
  }
}

/**
 * The interactive REPL: banner, `you> ` prompt, slash commands, and free text sent to the
 * model through one `Session` for the process's whole life (rebuilt only by /new or
 * /resume, each of which gets its own fresh `PermissionEngine` -- one engine per session,
 * never shared across a rebuild).
 */
export async function runRepl(opts: ReplOptions): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  // `stream: true` opts the REPL into live rendering; createEventRenderer itself narrows
  // that to a no-op on non-TTY stdout (piped input, the smoke harness) -- see its doc
  // comment. cli.ts's one-shot path calls createEventRenderer() with no options at all,
  // so it stays on the old whole-blob behavior regardless of this REPL's choice.
  const turnRenderer = createEventRenderer({ stream: true })

  let currentAbort: AbortController | undefined
  let stopAbortListening: (() => void) | undefined
  /** Set when a question this turn's port asked (approval or askUser) was cut off by an
   * abort rather than answered; read once after the turn resolves, then irrelevant until
   * the next turn resets it. */
  let questionCancelled = false
  let exiting = false
  /** First idle Ctrl+C arms this and prints a hint; a second one while still armed exits.
   * Reset at the top of every main-loop iteration (line 371), and also at the start of
   * runTurn() and handleCommand(), so it never survives into a running turn to cause a
   * mid-flight shutdown on a stale signal. SIGINT handler always returns early if
   * currentAbort is defined, never consulting idleArmed. */
  let idleArmed = false
  let contextLength: number | undefined

  const adapter: ReadlineLike = {
    async question(prompt: string): Promise<string> {
      const wasArmed = stopAbortListening
      wasArmed?.()
      stopAbortListening = undefined
      try {
        return currentAbort
          ? await rl.question(prompt, { signal: currentAbort.signal })
          : await rl.question(prompt)
      } catch (e) {
        if (currentAbort?.signal.aborted) {
          questionCancelled = true
          // Safe regardless of which sub-question this was (Allow?, rule pick, layer
          // pick, or askUser): Agent re-checks the turn's abort signal immediately after
          // requestApproval/askUser resolves and discards anything but a clean,
          // pre-abort decision -- so this never executes and never persists a remember
          // rule. 'n' just reaches that outcome by the shortest path (an ordinary deny)
          // instead of letting an AbortError escape as an unhandled rejection.
          return 'n'
        }
        throw e
      } finally {
        if (wasArmed && currentAbort && !currentAbort.signal.aborted) {
          stopAbortListening = startAbortListening(() => currentAbort?.abort())
        }
      }
    },
    write(text: string): void {
      // Approval/askUser/todos prompts all funnel through here -- clear any pending
      // in-place status line first (see EventRenderer.clearStatusLine's doc comment). A
      // prompt can only arrive between steps, so nothing else could still be streaming
      // when this runs; the status line from the JUST-finished step's thinking is exactly
      // what this guards against.
      turnRenderer.clearStatusLine()
      process.stdout.write(text)
    },
  }
  const port = createConsolePort(adapter)

  let session!: Session
  let engine!: PermissionEngine
  /** Guards rebuild()'s abortCompaction call below: false only before the very first
   * rebuild() (startup), when there is no old session yet to abort anything on. */
  let sessionBuilt = false

  /**
   * Loads settings layers fresh, builds a new PermissionEngine around them, and builds a
   * new Session around that -- only assigning the outer `session`/`engine` once both
   * succeed, so a `new Session` throw (a corrupt resumed session, e.g.) never leaves the
   * two vars pointing at mismatched objects.
   *
   * `explicitMode` distinguishes "the user asked for this mode" from "nothing was said":
   * passed through to Session only when defined, so a resumed session's own stored mode
   * wins when the caller (a bare /resume, or REPL startup with no --mode) has no opinion.
   *
   * Whole-branch-review fix: awaits the OLD session's `abortCompaction()` first, before
   * building anything new. Without this, a background compaction in flight on the OLD
   * session (about to be replaced below) is orphaned -- nothing ever aborts it, and it
   * keeps running against the single-slot server (`-np 1`) concurrently with the NEW
   * session's very first turn. See `Session.abortCompaction`'s own doc comment for the
   * full single-slot reasoning.
   */
  async function rebuild(explicitMode: AgentMode | undefined, resumeId: string | undefined): Promise<void> {
    if (sessionBuilt) await session.abortCompaction()

    const { layers, problems } = loadLayers(opts.workspaceRoot)
    const newEngine = new PermissionEngine({
      layers, mode: explicitMode ?? 'normal', workspaceRoot: opts.workspaceRoot, problems,
    })
    const sessionOpts: SessionOptions = {
      client: opts.client,
      toolset: opts.toolset,
      workspaceRoot: opts.workspaceRoot,
      engine: newEngine,
      store: opts.store,
      maxSteps: opts.maxSteps,
      events: turnRenderer.events,
      interaction: port,
      onCompaction: (info) => {
        const line = renderCompactionEvent(info)
        if (line === undefined) return
        // Same reasoning as repl.ts's other print sites: a compaction event can fire
        // right after a step's own rendering (the auto-trigger, at the tail of send()) or
        // right before the next turn's very first step (the swap, at the head of the
        // next send()) -- neither should ever land on a live status line, but this call
        // is free even when there is none to clear.
        turnRenderer.clearStatusLine()
        process.stdout.write(`${line}\n`)
      },
    }
    if (explicitMode !== undefined) sessionOpts.mode = explicitMode
    if (resumeId !== undefined) sessionOpts.resume = resumeId
    // Known before even the very first rebuild() call: probeContextLength() below runs
    // BEFORE the startup rebuild, so the launch session -- the primary use case -- gets
    // this wired exactly like every later /new or /resume rebuild does. Stays undefined
    // only when the probe itself failed (server unreachable or timed out at startup),
    // matching printBanner's own 'context length unknown' fallback; triggerRatio/
    // keepRecent are left at Session's own defaults (0.8 / 6) rather than repeated here.
    if (contextLength !== undefined) sessionOpts.compaction = { contextLength }
    const newSession = new Session(sessionOpts)
    session = newSession
    engine = newEngine
    sessionBuilt = true
  }

  /**
   * Probes the server's context length once, with its own short-timeout client -- exactly
   * like the one-shot path's health probe: `opts.client` carries the 600 s turn timeout,
   * right for a real generation but wrong for a startup probe (a black-holed server would
   * hang this for ten minutes before anything ever printed). Any failure -- network,
   * timeout, or a response missing the field -- resolves to `undefined`, never throws;
   * `undefined` is the same "unknown" state both `printBanner`'s context line and
   * `rebuild`'s `sessionOpts.compaction` wiring already treat as "off"/"approx only", so
   * callers need no separate failure branch.
   *
   * Split out of (what used to be) `printBanner` and run BEFORE the startup `rebuild()`
   * call below specifically so the very first session this process ever builds -- the
   * launch session, the primary use case -- gets auto-compaction armed too, not only
   * sessions built later by `/new`/`/resume` (which used to be the only ones that saw a
   * non-undefined `contextLength`, since the probe previously ran inside `printBanner`,
   * which itself only ever ran AFTER that first `rebuild()`).
   */
  async function probeContextLength(): Promise<number | undefined> {
    const probeClient = new LlamaClient({
      baseUrl: opts.server, model: opts.model, requestTimeoutMs: HEALTH_CHECK_TIMEOUT_MS,
    })
    try {
      const props = await probeClient.props()
      return props.contextLength
    } catch {
      return undefined
    }
  }

  contextLength = await probeContextLength()

  if (opts.resume !== undefined) {
    try {
      await rebuild(opts.mode, opts.resume)
    } catch (e) {
      process.stdout.write(
        `Could not resume session "${opts.resume}": ${e instanceof Error ? e.message : String(e)}\n` +
        'Starting a new session instead.\n',
      )
      await rebuild(opts.mode, undefined)
    }
  } else {
    await rebuild(opts.mode, undefined)
  }

  async function printBanner(): Promise<void> {
    const contextLine = contextLength !== undefined ? `${contextLength} tokens` : 'context length unknown'
    process.stdout.write(
      'PrivateCode\n' +
      `  server: ${opts.server}\n` +
      `  model: ${opts.model}\n` +
      `  workspace: ${opts.workspaceRoot}\n` +
      `  mode: ${session.mode}\n` +
      `  context length: ${contextLine}\n` +
      `  session: ${session.id}\n`,
    )
    for (const p of engine.problems) process.stdout.write(`settings: ${p}\n`)
    process.stdout.write(HELP_TEXT)
  }

  async function shutdown(): Promise<void> {
    if (exiting) return
    exiting = true
    stopAbortListening?.()
    stopAbortListening = undefined
    // Whole-branch-review fix: same orphaned-compaction reasoning as rebuild() above --
    // exiting must not leave a background compaction running past the process's own
    // lifetime. Before stopAll() (which tears down background shell tasks, a different
    // concern) so the compaction's own abort has already settled by the time anything
    // else starts shutting down.
    await session.abortCompaction()
    await opts.toolset.background.stopAll()
    process.stdout.write(
      `\nGoodbye. Session ${session.id} saved.\n` +
      `Resume with: npm run agent -- --workspace "${opts.workspaceRoot}" --resume ${session.id}\n`,
    )
    rl.close()
  }

  rl.on('close', () => { void shutdown() })
  rl.on('SIGINT', () => {
    // A turn in flight always wins: cooked-mode Ctrl+C (an approval question is up,
    // raw mode is off) reaches here as a real SIGINT rather than the keypress listener,
    // and must abort the turn exactly like Escape or a raw-mode Ctrl+C would.
    if (currentAbort) {
      if (!currentAbort.signal.aborted) {
        currentAbort.abort()
      }
      // already cancelling; not an idle exit (idleArmed is now meaningless until the turn completes)
      return
    }
    if (idleArmed) {
      void shutdown()
    } else {
      idleArmed = true
      process.stdout.write('\n(press Ctrl+C again to exit)\n')
    }
  })

  async function confirmAutopilot(): Promise<boolean> {
    process.stdout.write('\x1b[41m\x1b[97mAUTOPILOT: PrivateCode will act without asking.\x1b[0m\n')
    // `reject: false`: a workspace that isn't a git repo, or a machine with no git on
    // PATH, is not dirty as far as this gate is concerned -- it is a courtesy check, not
    // a security boundary, and must not block autopilot forever over an environment gap
    // it cannot resolve.
    const result = await execa('git', ['status', '--porcelain'], {
      cwd: opts.workspaceRoot, reject: false, windowsHide: true, all: true,
    })
    const dirty = result.exitCode === 0 && (result.all ?? '').trim() !== ''
    if (!dirty) return true
    const answer = await rl.question(
      'Working tree has uncommitted changes; commit or stash first, or type "yes" to ' +
      'continue anyway.\n> ',
    )
    return answer.trim() === 'yes' // literal, case-sensitive -- anything else declines.
  }

  async function handleMode(arg: string): Promise<void> {
    if (arg === '') {
      process.stdout.write(`mode: ${session.mode}\n`)
      return
    }
    if (!VALID_MODES.includes(arg as AgentMode)) {
      process.stdout.write(`Unknown mode "${arg}". Valid modes: ${VALID_MODES.join(', ')}.\n`)
      return
    }
    const next = arg as AgentMode
    if (next === 'autopilot' && !(await confirmAutopilot())) {
      process.stdout.write('Autopilot cancelled; mode unchanged.\n')
      return
    }
    session.setMode(next)
    process.stdout.write(`mode: ${next}\n`)
  }

  function handleSessions(): void {
    const metas = opts.store.list()
    if (metas.length === 0) {
      process.stdout.write('No saved sessions in this workspace.\n')
    }
    for (const m of metas) process.stdout.write(`${m.id}  ${m.updatedAt}  ${m.title || '(untitled)'}\n`)
    for (const p of opts.store.problems) process.stdout.write(`(skipped) ${p}\n`)
  }

  async function handleResume(id: string): Promise<void> {
    if (id === '') {
      process.stdout.write('usage: /resume <id>\n')
      return
    }
    try {
      await rebuild(undefined, id)
      process.stdout.write(`Resumed session ${session.id} (mode: ${session.mode}).\n`)
      for (const p of engine.problems) process.stdout.write(`settings: ${p}\n`)
    } catch (e) {
      // store.load() throws actionable messages for a missing or corrupt session; the
      // current session is untouched (rebuild only assigns on success), so this is a
      // reported failure, not a crash.
      process.stdout.write(`Could not resume "${id}": ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }

  function handleTodos(): void {
    const todos = opts.toolset.todos.list()
    if (todos.length === 0) {
      process.stdout.write('No todos recorded yet.\n')
      return
    }
    process.stdout.write('Todos:\n')
    for (const t of todos) process.stdout.write(`  ${formatTodoLine(t)}\n`)
  }

  /**
   * The manual escape hatch: forces one compaction cycle right now, synchronously.
   * `Session.forceCompact` itself emits the same `onCompaction` events the automatic
   * path does (wired above, in `rebuild`), so the "visible status" the brief asks for is
   * exactly those dim lines -- `'started'` prints immediately, then `'applied'`,
   * `'postponed'`, or (an addition here) `'failed'` once the call settles. This function's
   * own job is just to await it and report the one failure `Session` doesn't turn into an
   * event itself: calling `/compact` while a turn is already running.
   *
   * Cancellable exactly like `runTurn`'s own turns: `currentAbort` is set and
   * `startAbortListening` armed BEFORE the call, torn down after, so Esc or Ctrl+C aborts
   * the forced generation (`forceCompact`'s `signal.aborted` check reports `'postponed'`,
   * not `'failed'` -- see `session.ts`) instead of falling through to raw stdin. Setting
   * `currentAbort` here also means the SIGINT handler's "a turn is in flight" branch
   * fires during `/compact` too, so a Ctrl+C press here aborts it cleanly rather than
   * arming the idle double-Ctrl+C exit hint.
   */
  async function handleCompact(): Promise<void> {
    currentAbort = new AbortController()
    stopAbortListening = startAbortListening(() => currentAbort?.abort())
    try {
      await session.forceCompact(currentAbort.signal)
    } catch (e) {
      process.stdout.write(`Could not compact: ${e instanceof Error ? e.message : String(e)}\n`)
    } finally {
      stopAbortListening?.()
      stopAbortListening = undefined
      currentAbort = undefined
    }
  }

  async function handleCommand(line: string): Promise<void> {
    idleArmed = false
    const spaceIdx = line.indexOf(' ')
    const cmd = spaceIdx === -1 ? line : line.slice(0, spaceIdx)
    const arg = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1).trim()

    switch (cmd) {
      case '/help': process.stdout.write(HELP_TEXT); return
      case '/mode': await handleMode(arg); return
      case '/new': await rebuild(undefined, undefined); process.stdout.write(`Started a new session: ${session.id}\n`); for (const p of engine.problems) process.stdout.write(`settings: ${p}\n`); return
      case '/sessions': handleSessions(); return
      case '/resume': await handleResume(arg); return
      case '/todos': handleTodos(); return
      case '/compact': await handleCompact(); return
      case '/exit': await shutdown(); return
      default: process.stdout.write(`Unknown command "${cmd}". Type /help for the list.\n`); return
    }
  }

  async function runTurn(text: string): Promise<void> {
    idleArmed = false
    currentAbort = new AbortController()
    questionCancelled = false
    turnRenderer.reset()
    stopAbortListening = startAbortListening(() => currentAbort?.abort())

    // Snapshot both the engine reference and its problems length from the CURRENT
    // engine, before the turn runs. `remember()`'s "kept for this session only" fallback
    // and `addSessionRule`'s parse/canonical-syntax refusals push onto `engine.problems`
    // mid-turn (from inside an approval decision), but nothing ever printed them after
    // the startup banner -- they were silently swallowed. Capturing the engine object
    // itself (not just `engine.problems` by value) matters because `/new` and `/resume`
    // call `rebuild()`, which reassigns the outer `engine` variable to a brand new
    // PermissionEngine between turns; printing against whatever `engine` happens to
    // point to *after* the turn would either miss problems (if rebuilt away) or -- if a
    // rebuild somehow produced a same-shaped array -- misattribute them. Reading off
    // `turnEngine` (fixed at this turn's start) is always the engine `session.send` just
    // ran against.
    const turnEngine = engine
    const problemsBefore = turnEngine.problems.length

    const started = performance.now()
    let result: TurnResult | undefined
    try {
      result = await session.send(text, currentAbort.signal)
    } catch (e) {
      // A genuine transport error can land here mid-stream (thinking/content deltas were
      // still being rendered when the connection died) -- clear before this prints, same
      // as every other site that can interleave with the in-place status line.
      turnRenderer.clearStatusLine()
      process.stdout.write(turnErrorMessage(opts.server, e))
    } finally {
      stopAbortListening?.()
      stopAbortListening = undefined
      currentAbort = undefined
    }
    // Covers the success path (including 'aborted': a mid-stream abort can leave the
    // status line pending with no onThinking/onAssistantText left to clear it -- see
    // onStepDone's comment in render.ts) -- a no-op if the catch above already cleared it.
    turnRenderer.clearStatusLine()
    for (const p of turnEngine.problems.slice(problemsBefore)) {
      process.stdout.write(`settings: ${p}\n`)
    }
    if (!result) return

    const elapsedSeconds = (performance.now() - started) / 1000
    const stats = turnRenderer.stats()
    const parts = [
      `${result.stoppedBecause} in ${elapsedSeconds.toFixed(1)} s`,
      `${result.steps} step${result.steps === 1 ? '' : 's'}`,
    ]
    if (stats.totalTokens > 0 && stats.totalSeconds > 0) {
      parts.push(`${(stats.totalTokens / stats.totalSeconds).toFixed(0)} tok/s`)
    }
    const usage = session.contextUsage()
    parts.push(formatContextLine(usage.promptTokens, contextLength, usage.approxTokens))
    process.stdout.write(`${parts.join(' · ')}\n`)

    if (questionCancelled && result.stoppedBecause === 'aborted') {
      process.stdout.write('(a pending approval prompt was discarded when the turn was aborted)\n')
    }
  }

  await printBanner()

  while (!exiting) {
    idleArmed = false
    let line: string
    try {
      line = await rl.question('you> ')
    } catch {
      break // rl closed underneath us (EOF, or shutdown() already ran) -- exiting is set.
    }
    if (exiting) break
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('/')) {
      await handleCommand(trimmed)
      continue
    }
    await runTurn(trimmed)
  }
}
