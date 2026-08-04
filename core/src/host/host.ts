import { randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { AgentEvents } from '../agent/loop.js'
import { HEALTH_CHECK_TIMEOUT_MS } from '../cli/render.js'
import type { ApprovalDecision, InteractionPort } from '../interaction.js'
import { LlamaClient } from '../llama/client.js'
import { PermissionEngine } from '../permissions/engine.js'
import { loadLayers } from '../permissions/settings.js'
import { loadFormatRules } from '../format/config.js'
import { loadHooks } from '../hooks/hooks.js'
import { loadProjectMemory } from '../memory/project-memory.js'
import { expandCommand, listCommands } from '../commands/custom.js'
import { Session, type SessionOptions } from '../session/session.js'
import { SessionStore } from '../session/store.js'
import { createToolset, type Toolset } from '../tools/default-set.js'
import { loadBrowserSettings } from '../browser/settings.js'
import { loadServers } from '../mcp/config.js'
import { McpManager } from '../mcp/manager.js'
import { Workspace } from '../workspace.js'
import { PRIVATE_DIR } from '../private-dir.js'
import { runUnattended } from '../cli/unattended.js'
import type {
  AbortResult,
  ApprovalReplyParams,
  ApprovalReplyResult,
  CommandsListResult,
  CompactResult,
  ConfigGetResult,
  ConfigSetParams,
  ConfigSetResult,
  CheckpointsListResult,
  CheckpointsRewindParams,
  CheckpointsRewindResult,
  DecisionInfo,
  DecisionsListResult,
  DecisionsResolveParams,
  DecisionsResolveResult,
  RunStartParams,
  RunStartResult,
  RunStopResult,
  WorklogReadResult,
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
import { recordToolOutcome, replayEntries, toolOutcomes } from './replay.js'

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

/**
 * Extensions the preview renders as an image rather than as text, and the MIME type each
 * becomes in its `data:` URL. Kept to the formats a screenshot or a checked-in asset
 * actually uses — an extension not listed here is read as text, which is the old behaviour.
 */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

/** Base64 inflates by a third and this rides the ndjson protocol as one line. A browser
 * screenshot is ~200 KB; anything past this is not a preview, it is a transfer. */
const FS_READ_MAX_IMAGE_BYTES = 8 * 1024 * 1024

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

  /**
   * The workspace's MCP servers. Belongs to the WORKSPACE, not the session: a session
   * switch must not restart a set of server processes, so this is built in `init` and torn
   * down only by `init` or `shutdown`.
   */
  private mcp: McpManager | undefined

  /** Problems from loading MCP servers and browser settings, gathered once in `init` and
   * reported by every `buildSession` — including the ones a later session switch triggers,
   * which never re-reads them. */
  private externalProblems: string[] = []

  /** Guards `send()`: refuses a second call while one is already running, and -- just as
   * important -- stops a refused second call from clobbering `currentAbort` out from under
   * the turn that IS legitimately running (see `send()`'s own doc comment). */
  private sending = false
  private currentAbort: AbortController | undefined
  /** The in-flight turn's promise, so a session switch can AWAIT the abort it just fired
   * instead of racing it. Without this, `sending` stayed true against a session that had
   * never run a turn -- the user's first send in the freshly opened session was refused
   * with "a turn is already running" -- and the dying turn's events streamed into the new
   * session's view. Never rejects: `send`'s own try/finally owns the error path. */
  private currentTurn: Promise<unknown> | undefined

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
    await this.stopExternal()
  }

  /**
   * Every process this host owns beyond the model: background tasks, MCP servers, the
   * browser. Each is independently guarded, because shutdown runs on paths that are already
   * failing and one manager throwing must not leave the other two running.
   *
   * An orphaned Edge window or a stdio server outliving the app is the same defect the
   * polish review already caught once as an orphaned dev server.
   */
  private async stopExternal(): Promise<void> {
    const toolset = this.toolset
    await Promise.all([
      toolset ? toolset.background.stopAll().catch(() => {}) : Promise.resolve(),
      toolset ? toolset.browser.close().catch(() => {}) : Promise.resolve(),
      this.mcp ? this.mcp.closeAll().catch(() => {}) : Promise.resolve(),
    ])
    this.mcp = undefined
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
      case 'commands.list': return this.commandsList()
      case 'jobs.list': return this.jobsList()
      case 'jobs.stop': return this.jobsStop(params as JobsStopParams)
      case 'terminal.run': return this.terminalRun(params as TerminalRunParams)
      case 'config.get': return this.configGet()
      case 'config.set': return this.configSet(params as ConfigSetParams)
      case 'checkpoints.list': return this.checkpointsList()
      case 'checkpoints.rewind': return this.checkpointsRewind(params as CheckpointsRewindParams)
      case 'decisions.list': return this.decisionsList()
      case 'decisions.resolve': return this.decisionsResolve(params as DecisionsResolveParams)
      case 'worklog.read': return this.worklogRead()
      case 'run.start': return this.runStart(params as RunStartParams)
      case 'run.stop': return this.runStop()
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
    await this.currentTurn?.catch(() => {})
    if (this.session) await this.session.abortCompaction()
    this.denyAllPending()
    // Everything the OLD workspace owned, including its MCP servers and its browser: init
    // replaces the toolset below, and an orphan would otherwise run until app exit.
    await this.stopExternal()

    this.workspaceRoot = params.workspaceRoot
    this.workspace = new Workspace(params.workspaceRoot)
    this.client = new LlamaClient({ baseUrl: params.serverUrl, model: MODEL })
    const browserSettings = loadBrowserSettings(params.workspaceRoot)
    this.toolset = createToolset({ browser: browserSettings.options })
    this.store = new SessionStore(params.workspaceRoot)
    this.contextLength = await this.probeContextLength(params.serverUrl)
    this.externalProblems = [
      ...browserSettings.problems,
      ...await this.connectMcpServers(params.workspaceRoot),
    ]

    return this.buildSession(params.resume)
  }

  /**
   * Connects the workspace's MCP servers and registers their tools.
   *
   * Done HERE, in `init`, and not in `buildSession`: the servers belong to the WORKSPACE.
   * A session switch rebuilds the session, the settings layers and the permission engine —
   * restarting a set of server processes on every click of Resume would be slow, visible,
   * and would drop whatever state those servers were holding.
   */
  private async connectMcpServers(workspaceRoot: string): Promise<string[]> {
    const { servers, problems } = loadServers(workspaceRoot)
    if (servers.length === 0) return problems
    const manager = new McpManager()
    this.mcp = manager
    return [...problems, ...await manager.connectAll(servers, this.requireInitialized().toolset.registry)]
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
    // Awaited, not merely signalled: the turn must be OVER before the new session exists,
    // or its trailing events land in a view that has already been reset.
    await this.currentTurn?.catch(() => {})
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
    // Loaded here, beside the settings layers, for the same reason: the Session is handed
    // ready-made state rather than reading files itself.
    const memory = loadProjectMemory(workspaceRoot)
    const formatting = loadFormatRules(workspaceRoot)
    const hooking = loadHooks(workspaceRoot)
    const engine = new PermissionEngine({
      layers, mode: 'normal', workspaceRoot, problems: settingsProblems,
    })

    const sessionOpts: SessionOptions = {
      // Measured at ~220 ms per turn against a 30-60 s turn, so on by default: 'put back
      // what it just did' is worth having while watching, not only overnight.
      longRun: true,
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
    if (memory.layers.length > 0) sessionOpts.memory = memory
    if (formatting.rules.length > 0) sessionOpts.formatRules = formatting.rules
    if (hooking.hooks.length > 0) sessionOpts.hooks = hooking.hooks
    if (resumeId !== undefined) sessionOpts.resume = resumeId
    if (this.contextLength !== null) sessionOpts.compaction = { contextLength: this.contextLength }

    const session = new Session(sessionOpts)
    this.session = session
    // Wired here rather than inside Session: the queue is core's, the event is the wire's,
    // and Session has no business knowing a protocol exists.
    session.decisionQueue()?.onChange((pending) => this.emit('decisions.changed', { pending }))
    this.engine = engine

    // Memory, MCP and browser problems all ride the channel settings problems already use --
    // no new event, and the app already renders it. `externalProblems` is repeated on every
    // session switch rather than only on the init that produced it: a user who switches
    // sessions must not lose the notice that one of their MCP servers failed to start.
    const problems = [
      ...engine.problems, ...memory.problems, ...formatting.problems, ...hooking.problems,
      ...this.externalProblems,
    ]
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
      // Empty for a new session, and cheap to compute either way: this is a map over
      // messages already in memory, not a second read of the session file.
      items: resumeId === undefined
        ? []
        : replayEntries(session.messages(), toolOutcomes(workspaceRoot, session.id)),
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

  /**
   * A manual compaction is a model generation like any other, so it goes through the same
   * single-slot bookkeeping a turn does. Untracked, it could not be cancelled, `shutdown()`
   * resolved while it was still running, and a session switch during it left a generation
   * writing into a Session nothing referenced any more.
   */
  private async compact(): Promise<CompactResult> {
    const session = this.requireSession()
    if (this.sending) throw new Error('a turn is already running in this session')
    this.lastCompactionApplied = false
    this.sending = true
    this.currentAbort = new AbortController()
    try {
      const work = session.forceCompact()
      this.currentTurn = work
      await work
      return { applied: this.lastCompactionApplied }
    } finally {
      this.sending = false
      this.currentAbort = undefined
      this.currentTurn = undefined
    }
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
    // Declared out here so the `finally` can read it: anything `remember()` could not write
    // reaches `engine.problems` and nowhere else, so an "always allow" that failed to
    // persist was recorded in the transcript as remembered at the chosen layer while
    // actually being session-only -- gone at the next launch, with the one message
    // explaining why never leaving the engine object. The REPL already drains this; the
    // app had no equivalent until now.
    const problemsBefore = this.engine?.problems.length ?? 0
    try {
      // A custom slash command expands HERE, not in the app: the same expansion then
      // serves every front end, and the app's transcript keeps showing what the user
      // typed while the model receives the whole template. A `/name` matching no command
      // expands to null and is sent verbatim -- most lines starting with `/` are a path.
      const { workspaceRoot } = this.requireInitialized()
      const expanded = expandCommand(workspaceRoot, params.text)
      const running = session.send(expanded?.text ?? params.text, this.currentAbort.signal)
      this.currentTurn = running
      const result = await running
      const turn: TurnSummary = {
        steps: result.steps, finalText: result.finalText, stoppedBecause: result.stoppedBecause,
      }
      this.emit('turn.done', turn)
      return { turn }
    } finally {
      for (const text of this.engine?.problems.slice(problemsBefore) ?? []) {
        this.emit('settings.problem', { text })
      }
      this.sending = false
      this.currentAbort = undefined
      this.currentTurn = undefined
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
      onToolResult: (name, result, callId) => {
        // Recorded before the event goes out, so a window that is about to be closed still
        // leaves the outcome on disk for the next time this session is opened.
        if (this.workspaceRoot !== undefined && this.session) {
          recordToolOutcome(this.workspaceRoot, this.session.id, callId, result.ok)
        }
        this.emit('tool.result', {
          name,
          ok: result.ok,
          content: result.content,
          ...(result.display !== undefined ? { display: result.display } : {}),
        })
      },
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

    const imageType = IMAGE_TYPES[extname(params.path).toLowerCase()]
    if (imageType !== undefined) {
      if (buffer.byteLength > FS_READ_MAX_IMAGE_BYTES) {
        throw new Error(
          `${params.path} is ${Math.round(buffer.byteLength / 1024)} KB, too large to preview`,
        )
      }
      return {
        lines: [],
        truncated: false,
        image: { dataUrl: `data:${imageType};base64,${buffer.toString('base64')}`, bytes: buffer.byteLength },
      }
    }

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
  // Long runs: checkpoints, parked decisions, the work log, the unattended runner
  // -----------------------------------------------------------------------------------

  private async checkpointsList(): Promise<CheckpointsListResult> {
    const session = this.requireSession()
    return { checkpoints: await session.listCheckpoints() }
  }

  /**
   * Restores the workspace and tells the UI what to offer as the reverse.
   *
   * Refused while a turn is running, by `Session.rewind` itself: pulling files out from
   * under a model mid-edit produces a workspace neither of them believes in.
   */
  private async checkpointsRewind(params: CheckpointsRewindParams): Promise<CheckpointsRewindResult> {
    if (typeof params?.id !== 'string' || params.id.trim() === '') {
      throw new Error('checkpoints.rewind needs an id')
    }
    const session = this.requireSession()
    const { restored, undo } = await session.rewind(params.id)
    return { restored, undo }
  }

  private decisionsList(): DecisionsListResult {
    const queue = this.session?.decisionQueue()
    if (!queue) return { decisions: [] }
    return { decisions: queue.pending().map(toDecisionInfo) }
  }

  /**
   * Answers a parked request.
   *
   * The `rule` half is the whole value of the queue: a night's worth of approvals becomes a
   * handful of permission rules rather than a handful of yesses that are gone by morning. It
   * goes through the same `engine.remember` an in-the-moment "always allow" uses, so the two
   * paths cannot drift.
   *
   * The tool call itself is long gone -- it was refused hours ago and the agent moved on --
   * so this records an ANSWER, it does not retroactively run anything. Saying otherwise
   * would be the worst kind of lie for a security surface.
   */
  private decisionsResolve(params: DecisionsResolveParams): DecisionsResolveResult {
    const queue = this.session?.decisionQueue()
    if (!queue) throw new Error('there is no decision queue in this session')
    if (typeof params?.id !== 'string' || params.id.trim() === '') {
      throw new Error('decisions.resolve needs an id')
    }
    if (params.rule && this.engine) {
      try {
        this.engine.remember(params.rule.rule, params.rule.layer)
      } catch { /* remembering must never fail the answer itself */ }
      for (const problem of this.engine.problems.splice(0)) {
        this.emit('settings.problem', { text: problem })
      }
    }
    queue.resolve({
      id: params.id,
      ...(params.verdict !== undefined ? { verdict: params.verdict } : {}),
      ...(params.rule !== undefined ? { rule: params.rule } : {}),
      ...(params.answer !== undefined ? { answer: params.answer } : {}),
    })
    this.emit('decisions.changed', { pending: queue.pending().length })
    return {}
  }

  private async worklogRead(): Promise<WorklogReadResult> {
    const { workspaceRoot } = this.requireInitialized()
    const path = `${PRIVATE_DIR}/worklog.md`
    try {
      return { text: await readFile(join(workspaceRoot, PRIVATE_DIR, 'worklog.md'), 'utf8'), path }
    } catch {
      // An absent log is the normal state of a workspace that has never run unattended, not
      // an error to put in front of someone.
      return { text: '', path }
    }
  }

  /**
   * Starts an unattended run: turn after turn until a named stop condition fires.
   *
   * Shares the single-slot bookkeeping a manual `send` uses -- `sending`, `currentAbort`,
   * `currentTurn` -- because it IS a sequence of ordinary turns, and a manual send arriving
   * mid-run must be refused by exactly the same guard rather than a second one written to
   * agree with it.
   */
  private runStart(params: RunStartParams): RunStartResult {
    const session = this.requireSession()
    if (this.sending) throw new Error('a turn is already running in this session')
    if (typeof params?.task !== 'string' || params.task.trim() === '') {
      throw new Error('run.start needs a task')
    }

    this.sending = true
    this.currentAbort = new AbortController()
    const signal = this.currentAbort.signal
    session.setUnattended(true)

    this.currentTurn = (async () => {
      try {
        const summary = await runUnattended({
          session,
          task: params.task,
          signal,
          ...(typeof params.maxTurns === 'number' ? { maxTurns: params.maxTurns } : {}),
          ...(typeof params.maxHours === 'number' ? { maxHours: params.maxHours } : {}),
          onTurn: (info) => this.emit('run.turn', info),
        })
        this.emit('run.ended', summary)
      } catch (e) {
        this.emit('run.ended', {
          turns: 0,
          stoppedBecause: 'error',
          detail: e instanceof Error ? e.message : String(e),
        })
      } finally {
        session.setUnattended(false)
        this.sending = false
        // Any approval still on screen belongs to a turn that is over: the call it asks
        // about was deferred minutes ago and the agent moved on. Leaving the card up
        // invites someone to answer a question that can no longer change anything, which
        // is worse than clearing it — the parked copy in the queue is the one that matters
        // now, and it is still there.
        this.denyAllPending()
        const queue = session.decisionQueue()
        if (queue) this.emit('decisions.changed', { pending: queue.pending().length })
        for (const problem of session.longRunProblems()) {
          this.emit('settings.problem', { text: problem })
        }
      }
    })()
    return {}
  }

  /** Same abort a manual turn uses; the runner sees it and stops after the current turn. */
  private runStop(): RunStopResult {
    if (this.currentAbort && !this.currentAbort.signal.aborted) this.currentAbort.abort()
    return {}
  }

  // -----------------------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------------------

  private async status(): Promise<StatusResult> {
    if (!this.client) return { serverUp: false }
    const serverUp = await this.client.health()
    const result: StatusResult = { serverUp, model: MODEL }
    if (this.mcp) result.mcpServers = this.mcp.servers()
    if (this.toolset) {
      const url = this.toolset.browser.currentUrl()
      result.browser = url === null
        ? { running: this.toolset.browser.isRunning() }
        : { running: true, url }
    }
    return result
  }

  // -----------------------------------------------------------------------------------
  // Long-running processes (Jobs + Terminal panels)
  // -----------------------------------------------------------------------------------

  /** No toolset yet (before `init`) means no processes, which is an empty list, not an
   * error -- the panel polls this on a timer and must not spew failures while the app is
   * still on its welcome screen. */
  /** The custom slash commands available in this workspace, for the app's picker. Re-read
   * on every call -- these files are edited by hand while the app is open. */
  private commandsList(): CommandsListResult {
    if (this.workspaceRoot === undefined) return { commands: [] }
    const { commands } = listCommands(this.workspaceRoot)
    return { commands: commands.map((c) => ({ name: c.name, description: c.description })) }
  }

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

/** The queue's own entry, flattened for the wire. See `DecisionInfo`. */
function toDecisionInfo(entry: {
  kind: 'approval' | 'question'
  id: string
  at: string
  tool?: string
  summary?: string
  detail?: string
  suggestedRules?: string[]
  question?: string
  options?: string[]
}): DecisionInfo {
  return {
    kind: entry.kind,
    id: entry.id,
    at: entry.at,
    ...(entry.tool !== undefined ? { tool: entry.tool } : {}),
    ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    ...(entry.suggestedRules !== undefined ? { suggestedRules: entry.suggestedRules } : {}),
    ...(entry.question !== undefined ? { question: entry.question } : {}),
    ...(entry.options !== undefined ? { options: entry.options } : {}),
  }
}
