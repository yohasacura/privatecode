import { randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import type { AgentEvents } from '../agent/loop.js'
import { HEALTH_CHECK_TIMEOUT_MS } from '../cli/render.js'
import type { ApprovalDecision, InteractionPort } from '../interaction.js'
import { LlamaClient } from '../llama/client.js'
import { PermissionEngine } from '../permissions/engine.js'
import { loadLayers } from '../permissions/settings.js'
import { Session, type SessionOptions } from '../session/session.js'
import { SessionStore } from '../session/store.js'
import { createToolset, type Toolset } from '../tools/default-set.js'
import { Workspace } from '../workspace.js'
import type {
  AbortResult,
  ApprovalReplyParams,
  ApprovalReplyResult,
  CompactResult,
  ConfigGetResult,
  ConfigSetParams,
  ConfigSetResult,
  FsReadParams,
  FsReadResult,
  FsTreeEntry,
  FsTreeParams,
  FsTreeResult,
  HostEventMap,
  HostEventName,
  HostOutbound,
  HostRequest,
  InitParams,
  InitResult,
  JobsListResult,
  JobsStopParams,
  JobsStopResult,
  QuestionReplyParams,
  QuestionReplyResult,
  SendParams,
  SendResult,
  SessionsListResult,
  SessionsNewResult,
  SessionsResumeParams,
  SessionsResumeResult,
  SetModeParams,
  SetModeResult,
  StatusResult,
  TerminalRunParams,
  TerminalRunResult,
  TurnSummary,
} from './protocol.js'
import { loadUiConfig, saveUiConfig } from './ui-config.js'

/**
 * What `SessionHost` needs from whatever carries its messages to the UI: fire-and-forget
 * delivery of one outbound message (a reply or an event). Deliberately the whole
 * transport-facing surface -- framing (`encodeLine`/`LineDecoder`), the actual pipe/socket,
 * and request decoding all live outside this class, in the transport itself
 * (`stdio-main.ts` today; a future in-process Tauri IPC channel could implement the same
 * one-method interface with no ndjson involved at all).
 */
export interface HostTransport { send(msg: HostOutbound): void }

/** Same hardcoded model id `cli.ts` uses -- the wire protocol's `InitParams` carries a
 * `serverUrl` but no model name, so this host resolves it the same way the CLI does rather
 * than inventing a second source of truth. */
const MODEL = 'Qwen3.6-35B-A3B'

/** Mirrors `tools/read-file.ts`'s `MAX_LINES`/`MAX_CHARS` (2000 lines / 60,000 chars) --
 * RESTATED here, not imported: those constants are not exported from read-file.ts, and this
 * task's file list does not include changing that module. `fs.read` is intentionally a much
 * thinner cousin of `read_file` (no start_line/end_line, no binary sniff, no BOM handling --
 * see `fsRead`'s own doc comment for why), but the two caps that bound how much of a file one
 * call can hand back are worth keeping numerically identical so a host and the model never
 * disagree about "how much of this file is a lot". */
const FS_READ_MAX_LINES = 2000
const FS_READ_MAX_CHARS = 60_000

/** One `approval.request` or `question.request` this process minted a fresh `requestId` for
 * and is still waiting on. Removed from the map the instant it is resolved (by a matching
 * reply, by `abort()`, or by a session switch) -- see `SessionHost`'s class doc comment for
 * why a requestId is single-use. */
type PendingInteraction =
  | { kind: 'approval'; resolve: (decision: ApprovalDecision) => void }
  | { kind: 'question'; resolve: (answer: string) => void }

/**
 * Everything a UI needs from one agent session, transport-agnostic: construct it with
 * something that can deliver a `HostOutbound` message, then feed it decoded `HostRequest`s
 * one at a time via `handle()`. Owns exactly one workspace/session/engine at a time -- there
 * is one `SessionHost` per sidecar process, matching `stdio-main.ts`'s own lifetime.
 *
 * `handle()` is the seam every UI capability flows through, which makes this the
 * security-critical half of Plan 4: `handle()` must ALWAYS reply exactly once (never zero,
 * never twice, and never let an exception escape to its caller), and the approval/question
 * flow must never authorize a tool call the user did not actually approve. Both properties
 * are enforced narrowly rather than assumed:
 *
 * - `handle()`'s whole body is one try/catch; any throw from dispatching a method -- a bad
 *   params shape, an unknown method, a downstream `Session`/`Workspace` error -- becomes an
 *   ordinary `{id, error}` reply instead of an uncaught rejection. `safeSend()` guards the
 *   reply itself the same way, so even a broken transport cannot turn "always exactly one
 *   reply" into a thrown exception.
 * - Every `requestApproval`/`askUser` call mints a FRESH `requestId` (`crypto.randomUUID()`)
 *   and records it in `pending`, keyed by that id, BEFORE the matching `approval.request`/
 *   `question.request` event is emitted. `approval.reply`/`question.reply` look the id up by
 *   exact match and DELETE it before resolving anything -- so a reply naming an id that was
 *   never pending, was already answered, or was minted for the other kind of question is
 *   refused with an error reply and resolves nothing at all; a genuine reply can therefore
 *   never be replayed to authorize a second action.
 */
export class SessionHost {
  private readonly transport: HostTransport

  // Set once by init(); reused by every later sessions.new/resume/send/fs.*/status call.
  // A second init() call rebuilds all five from scratch (see init()'s own doc comment).
  private workspaceRoot: string | undefined
  private workspace: Workspace | undefined
  private client: LlamaClient | undefined
  private toolset: Toolset | undefined
  private store: SessionStore | undefined
  /** From `props()` at init time, once. `null` means the server never reported one --
   * compaction stays off for the rest of this process's life; never re-probed by a later
   * session switch, matching the REPL's own probe-once-at-startup behavior (`repl.ts`'s
   * `contextLength` variable). */
  private contextLength: number | null = null

  private session: Session | undefined
  private engine: PermissionEngine | undefined

  /** Guards `send()`: refuses a second call while one is already running, and -- just as
   * important -- stops a refused second call from clobbering `currentAbort` out from under
   * the turn that IS legitimately running (see `send()`'s own doc comment). */
  private sending = false
  private currentAbort: AbortController | undefined

  /** Every `approval.request`/`question.request` this process has emitted and not yet
   * resolved, keyed by its single-use `requestId`. See the class doc comment for the
   * authorization guarantee this map exists to enforce. */
  private readonly pending = new Map<string, PendingInteraction>()

  /** Set by the `onCompaction` callback wired into every `Session` this host builds;
   * read (and reset) by `compact()` to answer `CompactResult.applied` -- `Session.
   * forceCompact()` itself returns nothing, only firing lifecycle events. */
  private lastCompactionApplied = false

  private shutdownPromise: Promise<void> | undefined

  constructor(opts: { transport: HostTransport }) {
    this.transport = opts.transport
  }

  /**
   * Dispatches one decoded request and replies exactly once, always -- see the class doc
   * comment for the "never throws" guarantee this implements.
   */
  async handle(req: HostRequest): Promise<void> {
    try {
      const result = await this.dispatch(req.method, req.params)
      this.safeSend({ id: req.id, result })
    } catch (e) {
      this.safeSend({ id: req.id, error: { message: e instanceof Error ? e.message : String(e) } })
    }
  }

  /**
   * Aborts any turn in flight, aborts any in-flight compaction, and stops every background
   * task -- idempotent (a second call while the first is still settling, or after it has
   * already finished, returns the SAME promise rather than repeating the work).
   */
  async shutdown(): Promise<void> {
    this.shutdownPromise ??= this.runShutdown()
    return this.shutdownPromise
  }

  private async runShutdown(): Promise<void> {
    if (this.currentAbort && !this.currentAbort.signal.aborted) this.currentAbort.abort()
    this.denyAllPending()
    if (this.session) await this.session.abortCompaction()
    if (this.toolset) await this.toolset.background.stopAll()
  }

  // -----------------------------------------------------------------------------------
  // Dispatch
  // -----------------------------------------------------------------------------------

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'init': return this.init(params as InitParams)
      case 'send': return this.send(params as SendParams)
      case 'abort': return this.abort()
      case 'setMode': return this.setMode(params as SetModeParams)
      case 'sessions.list': return this.sessionsList()
      case 'sessions.new': return this.sessionsNew()
      case 'sessions.resume': return this.sessionsResume(params as SessionsResumeParams)
      case 'compact': return this.compact()
      case 'approval.reply': return this.approvalReply(params as ApprovalReplyParams)
      case 'question.reply': return this.questionReply(params as QuestionReplyParams)
      case 'fs.tree': return this.fsTree((params ?? {}) as FsTreeParams)
      case 'fs.read': return this.fsRead(params as FsReadParams)
      case 'status': return this.status()
      case 'jobs.list': return this.jobsList()
      case 'jobs.stop': return this.jobsStop(params as JobsStopParams)
      case 'terminal.run': return this.terminalRun(params as TerminalRunParams)
      case 'config.get': return this.configGet()
      case 'config.set': return this.configSet(params as ConfigSetParams)
      default: throw new Error(`unknown method: "${method}"`)
    }
  }

  // -----------------------------------------------------------------------------------
  // init / session lifecycle
  // -----------------------------------------------------------------------------------

  /**
   * Builds everything a session needs: the `LlamaClient`, a fresh `Toolset`, the settings
   * layers + `PermissionEngine` (problems seeded from `loadLayers` AND emitted as
   * `settings.problem` events -- see `buildSession`), the `SessionStore`, and finally the
   * `Session` itself, with its compaction config keyed off a one-time `props()` probe (a
   * `null` context length means the probe failed or the server never reported one, and
   * compaction stays off for this whole process -- reported as its own problem).
   *
   * A second `init()` call (a UI reconnecting to a still-live sidecar) is treated as a full
   * reset rather than refused: the old session's compaction is awaited-aborted and any
   * interaction it left pending is denied first -- the same teardown a session switch does
   * -- and every field below is rebuilt from scratch, not reused.
   */
  async init(params: InitParams): Promise<InitResult> {
    // Same teardown as switchSession, plus the old toolset's background tasks: init
    // replaces the toolset object below, and an orphaned dev server would otherwise run
    // until app exit (the polish review's Minor 6).
    if (this.currentAbort && !this.currentAbort.signal.aborted) this.currentAbort.abort()
    if (this.session) await this.session.abortCompaction()
    this.denyAllPending()
    if (this.toolset) await this.toolset.background.stopAll()

    this.workspaceRoot = params.workspaceRoot
    this.workspace = new Workspace(params.workspaceRoot)
    this.client = new LlamaClient({ baseUrl: params.serverUrl, model: MODEL })
    this.toolset = createToolset()
    this.store = new SessionStore(params.workspaceRoot)
    this.contextLength = await this.probeContextLength(params.serverUrl)

    return this.buildSession(params.resume)
  }

  /**
   * Probes the server's context window once, with its own short-timeout client -- exactly
   * like `repl.ts`'s `probeContextLength`: the main `client` carries the turn's long
   * transport timeout, right for a real generation but wrong for a startup probe. Any
   * failure (network, timeout, a response missing the field) resolves to `null`, never
   * throws; `init`'s caller treats `null` as "compaction off, reported as a problem".
   */
  private async probeContextLength(serverUrl: string): Promise<number | null> {
    const probe = new LlamaClient({ baseUrl: serverUrl, model: MODEL, requestTimeoutMs: HEALTH_CHECK_TIMEOUT_MS })
    try {
      const props = await probe.props()
      return props.contextLength ?? null
    } catch {
      return null
    }
  }

  private async sessionsNew(): Promise<SessionsNewResult> {
    return this.switchSession(undefined)
  }

  private async sessionsResume(params: SessionsResumeParams): Promise<SessionsResumeResult> {
    return this.switchSession(params.id)
  }

  /**
   * Plan-3 law, restated for a host that may outlive the REPL's single-threaded turn taking:
   * the OLD session's `abortCompaction()` is awaited FIRST, before anything about the new
   * session is built, so a background summary generation is never orphaned against the
   * single-slot server. `denyAllPending()` runs next, unconditionally: the interaction port
   * is one instance shared across every session this host ever builds (see
   * `buildInteractionPort`), so any approval/question a still-in-flight OLD turn is blocked
   * on would otherwise hang forever once nothing will ever reply to it from the UI's point
   * of view -- switching sessions is precisely the moment nothing else will.
   *
   * The polish review overturned an earlier judgment call here: the old turn IS aborted
   * on a session switch. Leaving it running let its deltas/step/turn.done events -- which
   * carry no session id -- stream into the NEW session's freshly-reset view, while a user
   * send was refused with "a turn is already running": ghost state in the exact first-hour
   * path a user hits by clicking Resume mid-turn. Aborting at the same moment as
   * `denyAllPending()` follows the same reasoning: switching sessions is precisely the
   * moment nothing will ever consume that turn's output.
   */
  private async switchSession(resumeId: string | undefined): Promise<InitResult> {
    this.requireInitialized()
    if (this.currentAbort && !this.currentAbort.signal.aborted) this.currentAbort.abort()
    if (this.session) await this.session.abortCompaction()
    this.denyAllPending()
    return this.buildSession(resumeId)
  }

  /**
   * The shared build shared by `init`/`sessions.new`/`sessions.resume`: fresh settings
   * layers, a fresh `PermissionEngine` around them, and a fresh `Session` around that.
   * `engine.problems` (seeded from `loadLayers` plus anything the engine's own rule parsing
   * found) is emitted as one `settings.problem` event per entry -- never silently dropped --
   * and a `null` `this.contextLength` adds one more problem, both to the emitted events and
   * to the `InitResult.problems` this returns, stating that automatic compaction is off.
   */
  private async buildSession(resumeId: string | undefined): Promise<InitResult> {
    const { client, toolset, store, workspaceRoot } = this.requireInitialized()

    const { layers, problems: settingsProblems } = loadLayers(workspaceRoot)
    const engine = new PermissionEngine({
      layers, mode: 'normal', workspaceRoot, problems: settingsProblems,
    })

    const sessionOpts: SessionOptions = {
      client,
      toolset,
      workspaceRoot,
      engine,
      store,
      events: this.buildAgentEvents(),
      interaction: this.buildInteractionPort(),
      onCompaction: (info) => {
        if (info.state === 'applied') this.lastCompactionApplied = true
        this.emit('compaction', {
          state: info.state,
          ...(info.droppedMessages !== undefined ? { droppedMessages: info.droppedMessages } : {}),
        })
      },
    }
    if (resumeId !== undefined) sessionOpts.resume = resumeId
    if (this.contextLength !== null) sessionOpts.compaction = { contextLength: this.contextLength }

    const session = new Session(sessionOpts)
    this.session = session
    this.engine = engine

    const problems = [...engine.problems]
    if (this.contextLength === null) {
      problems.push(
        'the server did not report a context length (GET /props); automatic compaction is disabled for this session',
      )
    }
    for (const p of problems) this.emit('settings.problem', { text: p })

    return {
      sessionId: session.id,
      mode: session.mode,
      contextLength: this.contextLength,
      problems,
      title: session.meta.title,
    }
  }

  private sessionsList(): SessionsListResult {
    const { store } = this.requireInitialized()
    return { sessions: store.list(), problems: [...store.problems] }
  }

  private setMode(params: SetModeParams): SetModeResult {
    this.requireSession().setMode(params.mode)
    return {}
  }

  private async compact(): Promise<CompactResult> {
    const session = this.requireSession()
    this.lastCompactionApplied = false
    await session.forceCompact()
    return { applied: this.lastCompactionApplied }
  }

  // -----------------------------------------------------------------------------------
  // Turns
  // -----------------------------------------------------------------------------------

  /**
   * Refuses (throws, becoming an error reply via `handle()`) when a turn is already
   * running -- checked and `this.sending` set BEFORE `currentAbort` is touched, so a
   * refused second call can never clobber the AbortController the legitimately-running
   * first call is using (a bug that would otherwise make `abort()` fire the wrong turn's
   * controller, or fire none at all). A fresh `AbortController` backs every turn; `abort()`
   * fires it and denies whatever it left pending.
   *
   * Both the reply AND the `turn.done` event carry the same `TurnSummary` -- the event so a
   * UI watching the stream sees completion without waiting on the RPC round-trip, the reply
   * because `send`'s caller needs the result directly too.
   */
  async send(params: SendParams): Promise<SendResult> {
    const session = this.requireSession()
    if (this.sending) {
      throw new Error('a turn is already running in this session')
    }
    this.sending = true
    this.currentAbort = new AbortController()
    try {
      const result = await session.send(params.text, this.currentAbort.signal)
      const turn: TurnSummary = {
        steps: result.steps, finalText: result.finalText, stoppedBecause: result.stoppedBecause,
      }
      this.emit('turn.done', turn)
      return { turn }
    } finally {
      this.sending = false
      this.currentAbort = undefined
    }
  }

  /**
   * Fires the current turn's `AbortController`, if one is running, then denies every
   * pending approval/question the same way -- see `denyAllPending`. Idempotent: a second
   * `abort()` with nothing running and nothing pending is a harmless no-op, matching
   * `AbortResult`'s bare `{}`.
   */
  async abort(): Promise<AbortResult> {
    if (this.currentAbort && !this.currentAbort.signal.aborted) this.currentAbort.abort()
    this.denyAllPending()
    return {}
  }

  // -----------------------------------------------------------------------------------
  // Interaction port (approval / question) and AgentEvents forwarding
  // -----------------------------------------------------------------------------------

  /**
   * Resolves every still-pending approval/question as a denial/cancellation and clears the
   * map -- the REPL's own semantics for "this question will never be answered by the thing
   * that asked it, and the turn is not allowed to hang on it forever" (its raw-mode
   * abort-during-`question()` path resolves to a deny the same way; see `repl.ts`'s
   * `adapter.question`). An approval resolves to `{verdict: 'deny', comment: 'cancelled'}`
   * rather than a bare deny so a tool result naming the reason (when the turn was NOT also
   * aborted, e.g. a session switch mid-approval) reads as "cancelled", not "declined by the
   * user" -- `Agent.runTool` re-checks its own abort signal immediately after this resolves,
   * so on a genuine `abort()` the turn's own cancellation message wins regardless of what
   * this decision says; this value matters on its own only for the session-switch path,
   * where no turn abort accompanies it.
   */
  private denyAllPending(): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      if (entry.kind === 'approval') entry.resolve({ verdict: 'deny', comment: 'cancelled' })
      else entry.resolve('cancelled')
    }
  }

  private approvalReply(params: ApprovalReplyParams): ApprovalReplyResult {
    const pending = this.pending.get(params.requestId)
    if (!pending || pending.kind !== 'approval') {
      throw new Error(`no pending approval request with id "${params.requestId}"`)
    }
    this.pending.delete(params.requestId)
    pending.resolve(params.decision)
    return {}
  }

  private questionReply(params: QuestionReplyParams): QuestionReplyResult {
    const pending = this.pending.get(params.requestId)
    if (!pending || pending.kind !== 'question') {
      throw new Error(`no pending question with id "${params.requestId}"`)
    }
    this.pending.delete(params.requestId)
    pending.resolve(params.answer)
    return {}
  }

  /**
   * One `InteractionPort` instance, built fresh per `Session` but sharing THIS host's one
   * `pending` map -- not because the port needs per-session state (it has none), but so
   * `denyAllPending()` at a session switch reaches every outstanding request regardless of
   * which session's turn raised it.
   */
  private buildInteractionPort(): InteractionPort {
    return {
      requestApproval: (req) => new Promise<ApprovalDecision>((resolve) => {
        const requestId = this.freshRequestId()
        this.pending.set(requestId, { kind: 'approval', resolve })
        this.emit('approval.request', { ...req, requestId })
      }),
      askUser: (q) => new Promise<string>((resolve) => {
        const requestId = this.freshRequestId()
        this.pending.set(requestId, { kind: 'question', resolve })
        this.emit('question.request', { ...q, requestId })
      }),
      todosChanged: (todos) => this.emit('todos', { items: todos.map((t) => ({ ...t })) }),
    }
  }

  private freshRequestId(): string {
    return randomUUID()
  }

  /**
   * Forwards every `Agent`/`Session` event this host cares about as its protocol
   * equivalent, deltas included -- `onThinkingDelta`/`onTextDelta` are always wired (never
   * conditionally, unlike `render.ts`'s TTY-gated streaming), which is also what keeps
   * `Agent.chat()` on the streaming `chatStream()` path for every host-driven turn (see
   * `loop.ts`'s `chat()`: streaming is opt-in purely on whether those two callbacks are
   * present at all). `onThinking`/`onContinuation` have no wire-event counterpart in the
   * protocol (only the streamed deltas do) and are left unwired.
   */
  private buildAgentEvents(): AgentEvents {
    return {
      onStepStart: (info) => this.emit('step.start', { step: info.step, timeoutMs: info.timeoutMs }),
      onStepDone: (info) => this.emit('step.done', {
        step: info.step,
        seconds: info.seconds,
        ...(info.tokensPerSecond !== undefined ? { tokensPerSecond: info.tokensPerSecond } : {}),
        ...(info.promptTokens !== undefined ? { promptTokens: info.promptTokens } : {}),
        ...(info.completionTokens !== undefined ? { completionTokens: info.completionTokens } : {}),
        ...(info.draftAcceptance !== undefined ? { draftAcceptance: info.draftAcceptance } : {}),
      }),
      onThinkingDelta: (text) => this.emit('thinking.delta', { text }),
      onTextDelta: (text) => this.emit('text.delta', { text }),
      onToolCall: (name, args) => this.emit('tool.call', { name, args }),
      onToolResult: (name, result) => this.emit('tool.result', {
        name,
        ok: result.ok,
        content: result.content,
        ...(result.display !== undefined ? { display: result.display } : {}),
      }),
      onAssistantText: (text) => this.emit('assistant.text', { text }),
    }
  }

  private emit<K extends HostEventName>(event: K, data: HostEventMap[K]): void {
    this.safeSend({ event, data })
  }

  private safeSend(msg: HostOutbound): void {
    try {
      this.transport.send(msg)
    } catch {
      // The transport is the host process's own stdout, or a test's captured array -- a
      // throw here means the channel itself is broken, and there is nothing left to reply
      // to or through. Swallowed so a dead transport cannot turn "handle() never throws"
      // into an uncaught rejection.
    }
  }

  // -----------------------------------------------------------------------------------
  // Filesystem (read-only, jailed)
  // -----------------------------------------------------------------------------------

  /** `params.path` omitted (or `''`) lists the workspace root itself -- `Workspace.resolve`
   * already treats `''`/`'.'`/`'./'` as the root. */
  private async fsTree(params: FsTreeParams): Promise<FsTreeResult> {
    const { workspace } = this.requireInitialized()
    const abs = workspace.resolve(params.path ?? '')
    const dirents = await readdir(abs, { withFileTypes: true })
    const entries: FsTreeEntry[] = dirents
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { entries }
  }

  /**
   * A much thinner cousin of `read_file`: no `start_line`/`end_line` (the protocol's
   * `FsReadParams` has only `path`), no binary sniff, no BOM stripping, no oversized-file
   * refusal -- this is a UI file preview, not model-facing context that has to stay small
   * and clean forever, so those model-specific concerns are left out rather than
   * reimplemented. What IS mirrored, per the brief, is the line/char cap: at most
   * `FS_READ_MAX_LINES` lines and `FS_READ_MAX_CHARS` characters of numbered-free body are
   * returned, with `truncated: true` when either cap cut the file short.
   *
   * Every path goes through `workspace.resolve()` first, before any filesystem call --
   * a `WorkspaceViolation` (`../x`, `.env`, ...) propagates up through `dispatch()`/
   * `handle()` untouched, so its own message (not some rewritten wrapper) is exactly what
   * the error reply carries, per the same convention every tool in `tools/` already follows.
   */
  private async fsRead(params: FsReadParams): Promise<FsReadResult> {
    const { workspace } = this.requireInitialized()
    const abs = workspace.resolve(params.path)

    const info = await stat(abs)
    if (info.isDirectory()) throw new Error(`${params.path} is a directory; use fs.tree`)
    if (!info.isFile()) throw new Error(`${params.path} is not a regular file`)

    const buffer = await readFile(abs)
    const text = buffer.toString('utf8')
    const allLines = text.split(/\r?\n/)
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()

    const lines: string[] = []
    let used = 0
    let truncated = false
    for (const line of allLines) {
      if (lines.length >= FS_READ_MAX_LINES) {
        truncated = true
        break
      }
      const cost = lines.length === 0 ? line.length : line.length + 1
      if (used + cost > FS_READ_MAX_CHARS) {
        truncated = true
        break
      }
      lines.push(line)
      used += cost
    }
    return { lines, truncated }
  }

  // -----------------------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------------------

  private async status(): Promise<StatusResult> {
    if (!this.client) return { serverUp: false }
    const serverUp = await this.client.health()
    return { serverUp, model: MODEL }
  }

  // -----------------------------------------------------------------------------------
  // Long-running processes (Jobs + Terminal panels)
  // -----------------------------------------------------------------------------------

  /** No toolset yet (before `init`) means no processes, which is an empty list, not an
   * error -- the panel polls this on a timer and must not spew failures while the app is
   * still on its welcome screen. */
  private jobsList(): JobsListResult {
    if (!this.toolset) return { jobs: [] }
    return { jobs: this.toolset.background.snapshot() }
  }

  private async jobsStop(params: JobsStopParams): Promise<JobsStopResult> {
    if (!this.toolset) return {}
    await this.toolset.background.stopById(params.id)
    return {}
  }

  /**
   * Runs a command the user typed in the terminal panel. See `TerminalRunParams` for why
   * this is not permission-gated. It reuses the background-task registry rather than
   * growing a second process manager, which also means `shutdown()`'s `stopAll()` already
   * covers it -- a terminal command cannot outlive the app.
   */
  private terminalRun(params: TerminalRunParams): TerminalRunResult {
    const { toolset, workspaceRoot } = this.requireInitialized()
    const command = params.command.trim()
    if (command === '') throw new Error('terminal.run needs a non-empty command')
    return { id: toolset.background.start(command, null, workspaceRoot, 'user').id }
  }

  // -----------------------------------------------------------------------------------
  // UI config (ui.json -- see ui-config.ts's own doc comment for why this is NOT the
  // permissions settings file)
  // -----------------------------------------------------------------------------------

  /** Available before `init` -- reading the last-used server URL/recent workspaces is
   * exactly what a settings modal or a workspace picker needs to do BEFORE a session
   * exists yet. Any problem `loadUiConfig` found in a corrupt `ui.json` is surfaced as a
   * `settings.problem` event, the same channel `buildSession`'s own settings problems use,
   * rather than silently swallowed. */
  private configGet(): ConfigGetResult {
    const { config, problems } = loadUiConfig()
    for (const p of problems) this.emit('settings.problem', { text: p })
    return {
      recentWorkspaces: config.recentWorkspaces,
      ...(config.serverUrl !== undefined ? { serverUrl: config.serverUrl } : {}),
    }
  }

  private configSet(params: ConfigSetParams): ConfigSetResult {
    saveUiConfig({
      ...(params.serverUrl !== undefined ? { serverUrl: params.serverUrl } : {}),
      ...(params.recentWorkspace !== undefined ? { recentWorkspace: params.recentWorkspace } : {}),
    })
    return {}
  }

  // -----------------------------------------------------------------------------------

  private requireInitialized(): {
    client: LlamaClient
    toolset: Toolset
    store: SessionStore
    workspace: Workspace
    workspaceRoot: string
  } {
    if (!this.client || !this.toolset || !this.store || !this.workspace || this.workspaceRoot === undefined) {
      throw new Error('SessionHost: "init" has not been called yet')
    }
    return {
      client: this.client,
      toolset: this.toolset,
      store: this.store,
      workspace: this.workspace,
      workspaceRoot: this.workspaceRoot,
    }
  }

  private requireSession(): Session {
    if (!this.session) throw new Error('SessionHost: no active session (call "init" first)')
    return this.session
  }
}
