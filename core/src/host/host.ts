import { randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentEvents } from '../agent/loop.js'
import { HEALTH_CHECK_TIMEOUT_MS } from '../cli/render.js'
import type { ApprovalDecision, InteractionPort } from '../interaction.js'
import { LlamaClient, LlamaRequestError } from '../llama/client.js'
import { looksLikeTask } from '../session/contract.js'
import { PermissionEngine } from '../permissions/engine.js'
import {
  addRuleToSettings, loadLayers, localSettingsPath, projectSettingsPath, removeRuleFromSettings,
  settingsText, userSettingsPath,
} from '../permissions/settings.js'
import { loadDatabaseSettings } from '../sql/settings.js'
import { loadSchemaBlock } from '../sql/schema-block.js'
import { loadFormatRules } from '../format/config.js'
import { loadHooks } from '../hooks/hooks.js'
import { loadVerify } from '../verify/config.js'
import { loadProjectMemory } from '../memory/project-memory.js'
import { loadProjectNotes } from '../memory/project-notes.js'
import { loadSkills, projectSkillsDir, userSkillsDir } from '../skills/skills.js'
import { stopNavProcess } from '../csharp/nav-process.js'
import { expandCommand, listCommands } from '../commands/custom.js'
import { DEFAULT_TRIGGER_TOKENS, Session, type SessionOptions } from '../session/session.js'
import { SessionStore } from '../session/store.js'
import { createToolset, type Toolset } from '../tools/default-set.js'
import { loadBrowserSettings } from '../browser/settings.js'
import { loadServers } from '../mcp/config.js'
import { McpManager } from '../mcp/manager.js'
import { canonicalize, isRootPath, Workspace } from '../workspace.js'
import {
  loadMounts, readProfile, saveWorkspaceFile, storedPath, workspaceFilePath,
  type Mount, type WorkspaceFile,
} from '../mounts.js'
import { discoverUnits, type SnapshotUnit } from '../checkpoints/units.js'
import { PRIVATE_DIR, STATE_DIR, migratePrivateDir, statePath } from '../private-dir.js'
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
  CheckpointsListParams,
  CheckpointsListResult,
  CheckpointsRestoreFileParams,
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
  PermissionsListResult,
  PermissionsRemoveParams,
  PermissionsRemoveResult,
  PermissionsAddParams,
  PermissionsAddResult,
  McpRawReadResult,
  SkillsListResult,
  McpRawSaveParams,
  McpRawSaveResult,
  FsReadParams,
  FsReadResult,
  FsTreeEntry,
  FsFindParams,
  FsFindResult,
  GitCommitParams,
  GitCommitResult,
  GitDiffParams,
  GitDiffResult,
  GitStageParams,
  GitStageResult,
  GitStatusResult,
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
  SessionsReadParams,
  SessionsReadResult,
  SessionsResumeParams,
  SessionsResumeResult,
  SessionsSearchParams,
  SessionsSearchResult,
  WorkspaceFolderView,
  WorkspaceGetResult,
  PromptImproveParams,
  PromptImproveResult,
  PromptExpandParams,
  PromptExpandResult,
  WorkspaceSetParams,
  WorkspaceSetResult,
  SetModeParams,
  SetModeResult,
  StatusResult,
  TerminalRunParams,
  TerminalRunResult,
  TurnSummary,
} from './protocol.js'
import { loadUiConfig, saveUiConfig } from './ui-config.js'
import { replayEntries, toolOutcomes } from './replay.js'
import { rankFiles, walkFiles } from './file-search.js'
import { attachFiles } from './attachments.js'
import { indexRepo, renderIndex, type ReferenceEdges, type RepoIndex } from '../outline/repo-map.js'
import { harvestReferenceEdges } from '../csharp/reference-edges.js'
import { gitCommitStaged, gitDiff, gitStage, gitUnstage, stagedPaths, suggestCommitMessage } from './git.js'
import { describeFolder, discoverRepos, repoRootFor, resolvePanelPath, toRepoPaths } from './repos.js'
import { searchSessions } from './session-search.js'

/**
 * What `SessionHost` needs from whatever carries its messages to the UI: fire-and-forget
 * delivery of one outbound message (a reply or an event). Deliberately the whole
 * transport-facing surface -- framing (`encodeLine`/`LineDecoder`), the actual pipe/socket,
 * and request decoding all live outside this class, in the transport itself
 * (`stdio-main.ts` today; a future in-process Tauri IPC channel could implement the same
 * one-method interface with no ndjson involved at all).
 */
export interface HostTransport { send(msg: HostOutbound): void }

/**
 * What to put in front of someone when a request fails.
 *
 * `LlamaRequestError` carries the server's own response body, and the window was throwing it
 * away: a context overflow reached the user as the bare line `llama.cpp request failed:
 * HTTP 400`, which says nothing about what happened or what to do. The CLI has shown the body
 * and the overflow hint since Plan 2 — this is the same information, reaching the other
 * front end.
 *
 * Deliberately not the CLI's own `serverErrorMessage`: that one ends with advice about
 * `--server <url>` and a `.bat` file, which is a terminal's vocabulary, not a window's.
 */
function describeFailure(e: unknown): string {
  if (!(e instanceof LlamaRequestError)) return e instanceof Error ? e.message : String(e)
  if (!e.answered) return e.message
  const body = e.body ? `\n${e.body}` : ''
  const overflow = e.status === 400 || e.status === 500
    ? '\nThe server is running and answered, so restarting it will not help. On a local ' +
      'model this is most often the conversation outgrowing the context window: compact it, ' +
      'or start a new session.'
    : ''
  return `${e.message}${body}${overflow}`
}

/** Same hardcoded model id `cli.ts` uses -- the wire protocol's `InitParams` carries a
 * `serverUrl` but no model name, so this host resolves it the same way the CLI does rather
 * than inventing a second source of truth. */
/**
 * What to call the model when the server will not say.
 *
 * llama.cpp serves whatever GGUF it was launched with and ignores the `model` field of a
 * request entirely, so this was never a selector — it was a label, and a label that went
 * stale the moment the user pointed the app at a different model. Reported exactly that way:
 * an 80B was loaded and the window still said Qwen3.6-35B-A3B.
 *
 * The real name now comes from `/props`, once per workspace open. This remains only as the
 * answer to "the server did not respond", where naming the model we cannot see would be a
 * worse lie than naming the one this build was written for.
 */
const FALLBACK_MODEL = 'Qwen3.6-35B-A3B'

/**
 * The most steps one turn may take in the window.
 *
 * A backstop, not a budget: at roughly 30-60 s per step this is two to four hours of one
 * turn, which is far past any honest task and well short of forever. Before this the app
 * passed nothing and `loop.ts` defaulted to Infinity.
 */
const MAX_STEPS_PER_TURN = 200

/**
 * `D:\models\Qwen3-Coder-Next-UD-Q3_K_XL.gguf` -> `Qwen3-Coder-Next-UD-Q3_K_XL`.
 *
 * The file name IS the useful name: it carries the family, the size and the quantisation,
 * which are exactly the three things a person checking "what am I talking to" wants. A
 * server that reports no path at all (an OpenAI-compatible proxy, say) yields null and the
 * caller keeps its fallback rather than displaying an empty label.
 */
function modelNameFrom(modelPath: string | undefined): string | null {
  if (modelPath === undefined || modelPath.trim() === '') return null
  // Both separators: llama.cpp reports the path it was given, and on this platform that is
  // a Windows one. Splitting on `/` alone returns the entire path as the "name".
  const base = modelPath.split(/[\\/]/).pop() ?? ''
  const name = base.replace(/\.gguf$/i, '').trim()
  return name === '' ? null : name
}

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
/** An init phase slower than this names itself in the problems strip: a workspace that
 * takes a minute to open is undebuggable after the fact without knowing which minute. */
const PHASE_SLOW_MS = 2_000

export class SessionHost {
  private readonly transport: HostTransport

  // Set once by init(); reused by every later sessions.new/resume/send/fs.*/status call.
  // A second init() call rebuilds all five from scratch (see init()'s own doc comment).
  private workspaceRoot: string | undefined
  /** Kept so a session build can re-probe a server that was still loading at `init`. */
  private serverUrl: string | undefined
  /** Built once per workspace on the first `fs.find`; see that method for why it is not
   * rebuilt per keystroke. Cleared by `init`, which replaces the whole host state. */
  private fileIndex: string[] | undefined
  /**
   * The project map, built once per WORKSPACE rather than per session.
   *
   * Per workspace because that is what it describes, and because building it parses every
   * source file: paying that on every New session would make the button feel broken. It
   * belongs to the same lifetime as the MCP servers and the file index for the same reason.
   */
  private repoMap = ''
  /** The folders this workspace is made of, primary first. Set by `init` alongside
   * `workspace`, and handed to every session so the jail and the prompt agree. */
  private mounts: readonly Mount[] = []
  /** What the undo store covers — one per writable folder plus one per nested repository.
   * Found by a disk scan in `init`, for the same reason the map is built there. */
  private units: readonly SnapshotUnit[] = []
  private workspaceName = ''
  /** The parsed `workspace.json`, or null for a plain single-folder workspace. Kept so a
   * session switch re-reads the profile without re-scanning the disk. */
  private workspaceFile: WorkspaceFile | null = null
  /** Folders that could not be attached — moved, overlapping, badly named. Reported to the
   * window with the settings problems, because a folder silently missing from the tree is
   * indistinguishable from an empty one. */
  private workspaceProblems: string[] = []
  private workspace: Workspace | undefined
  private client: LlamaClient | undefined
  private toolset: Toolset | undefined
  private store: SessionStore | undefined
  /** From `props()` at init time, once. `null` means the server never reported one --
   * compaction stays off for the rest of this process's life; never re-probed by a later
   * session switch, matching the REPL's own probe-once-at-startup behavior (`repl.ts`'s
   * `contextLength` variable). */
  private repoIndex: RepoIndex | undefined
  /** Compiler-confirmed file->file reference edges, harvested in the background after the
   * index is built and read by the swap-time rerank. Undefined until (and unless) the
   * harvest lands; the rerank treats that as "rank textually, as always". */
  private referenceEdges: ReferenceEdges | undefined
  private contextLength: number | null = null
  /** Whether the last health check saw the server. `null` until the first one, so the very
   * first observation is not mistaken for a restart — `init` has already read /props by
   * then and re-reading it a second later would be pure noise. */
  private serverWasUp: boolean | null = null
  /** What the server said it is serving, discovered at init. See `FALLBACK_MODEL`. */
  private model: string = FALLBACK_MODEL

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
      this.safeSend({ id: req.id, error: { message: describeFailure(e) } })
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
      toolset ? toolset.webRenderer.close().catch(() => {}) : Promise.resolve(),
      this.mcp ? this.mcp.closeAll().catch(() => {}) : Promise.resolve(),
      // The C# navigator holds a whole compilation in memory and is per-workspace, so it
      // belongs in exactly this list: an `init` that switched workspaces while leaving the
      // old index resident is the orphaned-dev-server defect wearing a different hat.
      stopNavProcess().catch(() => {}),
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
      case 'sessions.read': return this.sessionsRead(params as SessionsReadParams)
      case 'sessions.search': return this.sessionsSearch(params as SessionsSearchParams)
      case 'compact': return this.compact()
      case 'approval.reply': return this.approvalReply(params as ApprovalReplyParams)
      case 'question.reply': return this.questionReply(params as QuestionReplyParams)
      case 'fs.tree': return this.fsTree((params ?? {}) as FsTreeParams)
      case 'fs.find': return this.fsFind(params as FsFindParams)
      case 'workspace.get': return this.workspaceGet()
      case 'workspace.set': return this.workspaceSet(params as WorkspaceSetParams)
      case 'prompt.improve': return this.promptImprove(params as PromptImproveParams)
      case 'prompt.expand': return this.promptExpand(params as PromptExpandParams)
      case 'git.status': return this.gitStatusFor()
      case 'git.diff': return this.gitDiffFor(params as GitDiffParams)
      case 'git.stage': return this.gitStageFor(params as GitStageParams, 'stage')
      case 'git.unstage': return this.gitStageFor(params as GitStageParams, 'unstage')
      case 'git.commit': return this.gitCommitFor(params as GitCommitParams)
      case 'fs.read': return this.fsRead(params as FsReadParams)
      case 'status': return this.status()
      case 'commands.list': return this.commandsList()
      case 'jobs.list': return this.jobsList()
      case 'jobs.stop': return this.jobsStop(params as JobsStopParams)
      case 'terminal.run': return this.terminalRun(params as TerminalRunParams)
      case 'todos.clear': return this.todosClear()
      case 'config.get': return this.configGet()
      case 'config.set': return this.configSet(params as ConfigSetParams)
      case 'checkpoints.list': return this.checkpointsList(params as CheckpointsListParams)
      case 'checkpoints.rewind': return this.checkpointsRewind(params as CheckpointsRewindParams)
      case 'checkpoints.restoreFile':
        return this.requireSession().restoreFile(
          (params as CheckpointsRestoreFileParams).path,
          (params as CheckpointsRestoreFileParams).note,
        )
      case 'decisions.list': return this.decisionsList()
      case 'decisions.resolve': return this.decisionsResolve(params as DecisionsResolveParams)
      case 'worklog.read': return this.worklogRead()
      case 'permissions.list': return this.permissionsList()
      case 'permissions.remove': return this.permissionsRemove(params as PermissionsRemoveParams)
      case 'permissions.add': return this.permissionsAdd(params as PermissionsAddParams)
      case 'skills.list': return this.skillsList()
      case 'mcp.rawRead': return this.mcpRawRead()
      case 'mcp.rawSave': return this.mcpRawSave(params as McpRawSaveParams)
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
    // Phase timings, permanently: a workspace that takes a minute to open (watched live on
    // the real project) is undebuggable after the fact without them. Anything slower than
    // PHASE_SLOW_MS lands in the problems strip the window already renders, named, so the
    // slow phase identifies itself on the machine where it is slow.
    const phases: [string, number][] = []
    let phaseStarted = Date.now()
    const phase = (name: string): void => {
      const took = Date.now() - phaseStarted
      if (took >= PHASE_SLOW_MS) phases.push([name, took])
      phaseStarted = Date.now()
    }
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
    phase('teardown')

    this.workspaceRoot = params.workspaceRoot
    // BEFORE anything opens a session store or a checkpoint store: this renames directories,
    // and renaming a path a live object already holds is how a migration eats history. Every
    // teardown above has already run, so nothing of the OLD workspace is holding these.
    const migrationProblems = migratePrivateDir(params.workspaceRoot)
    this.fileIndex = undefined
    // The folders this workspace is made of. A folder with no definition file is one mount
    // and behaves exactly as it always has; a folder that was renamed or now overlaps another
    // is reported and skipped rather than refusing to open the workspace at all.
    const loaded = loadMounts(params.workspaceRoot)
    this.mounts = loaded.mounts
    this.workspaceName = loaded.name
    this.workspaceProblems = loaded.problems
    this.workspaceFile = loaded.file
    this.workspace = new Workspace(loaded.mounts)
    this.client = new LlamaClient({ baseUrl: params.serverUrl, model: this.model })
    const browserSettings = loadBrowserSettings(params.workspaceRoot)
    this.toolset = createToolset({ browser: browserSettings.options, workspaceRoot: params.workspaceRoot })
    this.store = new SessionStore(params.workspaceRoot)
    this.serverUrl = params.serverUrl
    phase('settings')
    const probed = await this.probeServer(params.serverUrl)
    phase('server probe')
    // Only an ANSWERED probe overwrites what we hold — the same rule `buildSession` follows
    // eleven lines of reasoning further down, and this line was the one place that did not.
    // `init` runs on every window open, including a reopen against a server that happens to
    // be restarting, and an unconditional assignment there ERASES a known-good window and
    // replaces the real model name with the fallback constant. The window then has no size
    // to divide by and shows no context readout at all.
    if (probed.contextLength !== null) {
      this.contextLength = probed.contextLength
      this.model = probed.model
    }
    // Built with the name we had a moment ago; rebuilt now that the server has told us. The
    // field is only a label to llama.cpp, but it appears in its logs, and a log that says
    // one model while another is loaded costs somebody an hour one day.
    this.client = new LlamaClient({ baseUrl: params.serverUrl, model: this.model })
    this.externalProblems = [
      ...migrationProblems,
      ...browserSettings.problems,
      ...await this.connectMcpServers(params.workspaceRoot),
    ]
    phase('mcp servers')
    // Built here, once per workspace, and awaited: it belongs in the system message, which
    // is message 0 of an append-only transcript, so there is no later moment to add it to.
    // A workspace it cannot index yields '' and the session runs exactly as it did before
    // maps existed.
    // Indexed once (a disk walk and a parse per file), rendered from memory. Keeping the
    // index is what lets a compaction swap re-order the map around the work in progress
    // without touching the disk again.
    this.repoIndex = await indexRepo(loaded.mounts)
    this.repoMap = renderIndex(this.repoIndex)
    phase('repo index')
    // Fire-and-forget: compiler-confirmed reference edges for the swap-time rerank. The
    // helper question is async and the rerank callback is not, so the edges are gathered
    // here in the background and read whenever the next swap happens to come — a swap that
    // arrives first simply ranks textually, which is the map this feature grew out of.
    // Cleared before the kick so a workspace switch can never rerank against the previous
    // workspace's edges while its own harvest is still running.
    this.referenceEdges = undefined
    if (loaded.mounts.length === 1) {
      const index = this.repoIndex
      void harvestReferenceEdges(loaded.mounts[0]!.root, index).then((edges) => {
        // Only if the workspace has not moved on under the harvest.
        if (edges !== null && this.repoIndex === index) this.referenceEdges = edges
      }).catch(() => { /* an enrichment; the textual ranking stands */ })
    }
    // A disk scan, so it happens here rather than in the Session constructor. Per workspace,
    // like the map and the MCP servers: cloning a repository into the project mid-session is
    // not something a session switch should have to notice.
    this.units = await discoverUnits(loaded.mounts, params.workspaceRoot)
    phase('unit discovery')

    const result = await this.buildSession(this.sessionToOpen(params))
    phase('session load')
    if (phases.length > 0) {
      const detail = phases.map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}s`).join(', ')
      // Rides the RESULT, not a settings.problem event: the app resets its problems list
      // when the init reply lands and re-delivers only `result.problems`, so an event
      // emitted before the reply is wiped before anyone can read it (App.tsx documents the
      // same wipe for every other init-time problem).
      result.problems.push(`The workspace opened slowly: ${detail}. Diagnostics, not an error.`)
      process.stderr.write(`host: slow init phases: ${detail}
`)
    }
    return result
  }

  /**
   * Which session `init` should open: the one named, else the newest one this workspace has
   * if the caller asked to continue, else none (a fresh session).
   *
   * `store.list()` is newest-first by `updatedAt`, so its head IS "the one you were last
   * in". A corrupt or unreadable store is not a reason to refuse to open the workspace --
   * it degrades to a fresh session, and `store.problems` still reports why.
   */
  private sessionToOpen(params: InitParams): string | undefined {
    if (params.resume !== undefined) return params.resume
    if (params.continueLast !== true) return undefined
    try {
      return this.requireInitialized().store.list()[0]?.id
    } catch {
      return undefined
    }
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
  /**
   * What the server is actually serving: how big its window is, and what it is called.
   *
   * One request for both, because they come from the same `/props` and both go stale for
   * the same reason — someone loaded a different model. The context length drives
   * compaction, and the name is what the window shows; getting one right while the other
   * was a hardcoded constant is how the app came to display a 35B label over an 80B.
   *
   * Never throws. A failure leaves the name at `FALLBACK_MODEL` and the length `null`,
   * which `init` already treats as "compaction off, reported as a problem".
   */
  /**
   * Adopt what the server now says about itself, mid-session.
   *
   * The user changes model settings on the fly: stop the server, edit `-c` or point it at a
   * different GGUF, start it again. Everything downstream of that — the window compaction
   * divides by, the label in the status bar, the name written into request logs — was read
   * once at startup and then believed, so a 256k server went on being driven as a 131k one.
   *
   * Two things make this safe to call from a poll. A probe that did not answer changes
   * nothing, so a server caught mid-load leaves the last good values in place rather than
   * replacing them with nulls. And an unchanged answer returns before touching anything, so
   * the ordinary case — a server restarted with the same settings — is silent.
   */
  private async refreshServerProps(): Promise<void> {
    if (this.serverUrl === undefined) return
    const probed = await this.probeServer(this.serverUrl)
    if (probed.contextLength === null) return
    const grewOrShrank = probed.contextLength !== this.contextLength
    const renamed = probed.model !== this.model
    if (!grewOrShrank && !renamed) return

    const previous = this.contextLength
    this.contextLength = probed.contextLength
    if (renamed) {
      this.model = probed.model
      this.client = new LlamaClient({ baseUrl: this.serverUrl, model: this.model })
    }
    // The running session holds its own copy, and compaction is computed from that one. A
    // session left driving the old number is the actual harm here: too small and it compacts
    // a window that had room, too large and it overruns the one it has.
    this.session?.setContextLength(probed.contextLength)

    // Said out loud, because it changes how the session behaves from here on and the only
    // other sign of it is a number in the status bar that the user would have to be watching
    // at the right moment. `settings.problem` is the app's notice channel.
    // Divided by 1000, not 1024, to match the number the status bar shows: a notice
    // that says 128k beside a bar that says 131k reads as a second, different fact.
    const window = `${Math.round(probed.contextLength / 1000)}k`
    this.emit('settings.problem', {
      text: previous === null
        ? `the model server answered: ${this.model}, ${window} context. Automatic compaction ` +
          'is on for this session now.'
        : `the model server came back with different settings: ${this.model}, ${window} ` +
          `context (was ${Math.round(previous / 1000)}k). This session now uses the new window.`,
    })
  }

  private async probeServer(serverUrl: string): Promise<{ contextLength: number | null; model: string }> {
    const probe = new LlamaClient({
      baseUrl: serverUrl, model: FALLBACK_MODEL, requestTimeoutMs: HEALTH_CHECK_TIMEOUT_MS,
    })
    try {
      const props = await probe.props()
      return {
        contextLength: props.contextLength ?? null,
        model: modelNameFrom(props.modelPath) ?? FALLBACK_MODEL,
      }
    } catch {
      return { contextLength: null, model: FALLBACK_MODEL }
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
    const { toolset, store, workspaceRoot } = this.requireInitialized()

    // Re-probed here, on every session build.
    //
    // The model server takes minutes to load twenty gigabytes off disk, and the window opens
    // in a second. Probing once in `init` meant that opening the app first — the ordinary
    // order — left compaction off for the whole life of that workspace, with a warning that
    // named the symptom and no way back except knowing to re-open the workspace. Now New
    // session is the cure, and it costs one short GET on a path that is already broken.
    // With an 80B this is no longer the unlucky case — it is the ordinary one. Loading tens
    // of gigabytes takes minutes, the window opens in a second, and the first probe in
    // `init` therefore misses on every cold start. It re-reads the NAME as well as the
    // length now: getting the window size right while the label still said whatever the
    // last successful probe said is how the app came to show a 35B over an 80B.
    //
    // The guard used to be `this.contextLength === null`, which made the FIRST success
    // permanent. Restart the server with `-c 262144` behind a running window and the app
    // kept the 131072 it had learned hours earlier — and New session did not cure it,
    // because the value was no longer null. That is the same mistake as the stale label,
    // one line apart: both are properties of a process the user restarts at will, read once
    // and then believed forever. So the probe is unconditional now.
    //
    // What must NOT happen is a failed probe erasing a good value: with the server briefly
    // down, New session should keep the last known window rather than silently turning
    // compaction off. Only a probe that actually answered overwrites anything.
    if (this.serverUrl !== undefined) {
      const probed = await this.probeServer(this.serverUrl)
      if (probed.contextLength !== null) {
        const renamed = probed.model !== this.model
        this.contextLength = probed.contextLength
        this.model = probed.model
        // `init` rebuilds the client when the name changes and this did not, so every
        // request in a session started after a model swap carried the old name. Harmless to
        // llama.cpp, which serves whatever it loaded, and misleading in its logs.
        if (renamed) this.client = new LlamaClient({ baseUrl: this.serverUrl, model: this.model })
      }
    }

    // Read AFTER the probe, deliberately: a model swap replaces `this.client`, and the
    // session must be handed the new one rather than whichever was current when this method
    // was entered.
    const { client } = this.requireInitialized()

    const { layers, problems: settingsProblems } = loadLayers(workspaceRoot)
    // Loaded here, beside the settings layers, for the same reason: the Session is handed
    // ready-made state rather than reading files itself.
    const memory = loadProjectMemory(workspaceRoot)
    // Beside memory for the same reason, and read per session build rather than once per
    // app: a skill added while the window is open should arrive with the next New session,
    // which is the same contract AGENTS.md has.
    const skills = loadSkills(workspaceRoot)
    // Re-checked against the code on every session build, which is what keeps it honest: a
    // note whose files moved since it was written is dropped here, not carried forward.
    const notes = loadProjectNotes(workspaceRoot, this.workspace)
    const formatting = loadFormatRules(workspaceRoot)
    // Read per session build like the settings layers beside it, so a connection string
    // edited while the window is open arrives with the next New session.
    const db = loadDatabaseSettings(workspaceRoot)
    const hooking = loadHooks(workspaceRoot)
    const verifying = loadVerify(workspaceRoot)
    // What this combination of folders is FOR: the mode it opens in and the check each
    // folder gets. Read per session build, like the settings layers beside it.
    const profile = readProfile(this.workspaceFile, this.mounts, workspaceFilePath(workspaceRoot))
    const engine = new PermissionEngine({
      layers, mode: profile.mode ?? 'normal', workspaceRoot, problems: settingsProblems,
    })
    // The project's own checks may be run BY THE MODEL too, and they routinely are: watched
    // live, every write-verify cycle began with the model asking to run the exact command
    // the app was about to run for free — an approval card per cycle, for a command the
    // settings file already declares trustworthy enough to run unprompted. Granted at the
    // session-allow tier (the same one an approval's "Always for this session" uses), which
    // widens nothing: the string comes from a file the model cannot write, exact-match only
    // (`commandMatches` — `node run-checks.js && rm` is a different command), deny and ask
    // rules are consulted before session allows, and the grant dies with the session.
    const verifyCommands = new Set<string>()
    if (verifying.verify) verifyCommands.add(verifying.verify.command)
    for (const spec of Object.values(profile.verify)) verifyCommands.add(spec.command)
    for (const command of verifyCommands) {
      // A literal trailing `:*` would be READ as a prefix marker by `commandMatches` — the
      // one shape where this grant would exceed the exact command — so such a command
      // simply keeps its approval card.
      if (command.trimEnd().endsWith(':*')) continue
      engine.addSessionRule(`run_command(${command})`)
    }

    const sessionOpts: SessionOptions = {
      // Measured at ~220 ms per turn against a 30-60 s turn, so on by default: 'put back
      // what it just did' is worth having while watching, not only overnight.
      longRun: true,
      client,
      toolset,
      workspaceRoot,
      ...(this.mounts.length > 1 ? { mounts: this.mounts } : {}),
      ...(this.units.length > 0 ? { units: this.units } : {}),
      ...(profile.mode !== undefined ? { mode: profile.mode } : {}),
      ...(Object.keys(profile.verify).length > 0 ? { verifyFolders: profile.verify } : {}),
      engine,
      store,
      events: this.buildAgentEvents(),
      interaction: this.buildInteractionPort(),
      onCompaction: (info) => {
        if (info.state === 'applied') this.lastCompactionApplied = true
        this.emit('compaction', {
          state: info.state,
          ...(info.droppedMessages !== undefined ? { droppedMessages: info.droppedMessages } : {}),
          ...(info.detail !== undefined ? { detail: info.detail } : {}),
          ...(info.reason !== undefined ? { reason: info.reason } : {}),
        })
      },
      onCompactionProgress: (progress) => this.emit('generation.progress', {
        scope: 'compaction', ...progress,
      }),
    }
    if (memory.layers.length > 0) sessionOpts.memory = memory
    if (skills.skills.length > 0) sessionOpts.skills = skills
    if (notes.text !== '') sessionOpts.notes = notes.text
    if (this.repoMap !== '') sessionOpts.repoMap = this.repoMap
    // The map the session gets at a compaction swap: same index, re-ranked around whatever
    // it has been working on. Handed as a callback because the index is the host's and the
    // moment is the session's.
    if (this.repoIndex !== undefined) {
      const index = this.repoIndex
      // `this.referenceEdges` is read at CALL time, not closure time: the harvest finishes
      // minutes before the first swap needs it, and a swap that outruns it gets the map
      // exactly as it was before edges existed.
      sessionOpts.rerankRepoMap = (focus) => renderIndex(index, undefined, focus, this.referenceEdges)
    }
    if (formatting.rules.length > 0) sessionOpts.formatRules = formatting.rules
    if (hooking.hooks.length > 0) sessionOpts.hooks = hooking.hooks
    if (verifying.verify) sessionOpts.verify = verifying.verify
    // Wired whenever ANY folder has a check, not only when the settings files supply one.
    // Tying the callback to the settings-file source meant a workspace whose checks all came
    // from the profile ran them and reported nothing — the commands fired, the window stayed
    // silent, and a check that takes thirty seconds while saying nothing reads as a hang.
    if (verifying.verify || Object.keys(profile.verify).length > 0) {
      sessionOpts.onVerify = (info) => this.emit('verify', info)
    }
    // The acceptance gate rides the verify channel the window already renders: it is the
    // same kind of fact ("a check ran after your work, here is what it said") and a gate
    // that runs invisibly cannot be trusted or tuned — a silent pass and a silently
    // broken gate would look identical.
    //
    // `problem` carries the detail, and that is not cosmetic: the reducer's fallback for a
    // failed check is `exited ${exitCode ?? '?'}`, and a gate has no exit code — so every
    // unmet result rendered as "contract check: 4 met, 2 unmet — exited ?", in the
    // transcript and in the markdown export. A gate does not exit, it reports.
    sessionOpts.onAcceptance = (info) => {
      const detail = info.kind === 'review'
        ? `${info.unmet} finding${info.unmet === 1 ? '' : 's'}`
        : `${info.met} met, ${info.unmet} unmet`
      this.emit('verify', {
        command: info.kind === 'review' ? 'independent diff review' : 'contract check',
        ok: info.unmet === 0,
        attempt: info.round,
        ...(info.unmet === 0 ? {} : { problem: detail }),
      })
    }
    if (resumeId !== undefined) sessionOpts.resume = resumeId
    // The configured trigger is passed whether or not the window is known yet. A session
    // built while the model is still loading has no `compaction` at all — `setContextLength`
    // builds it later, and without these defaults to merge it would fall back to the
    // built-in threshold and silently ignore the user's own `compaction.triggerTokens`.
    const triggerTokens = loadTriggerTokens(workspaceRoot)
    if (triggerTokens !== undefined) sessionOpts.compactionDefaults = { triggerTokens }
    if (this.contextLength !== null) {
      sessionOpts.compaction = {
        contextLength: this.contextLength,
        ...(triggerTokens !== undefined ? { triggerTokens } : {}),
      }
    }
    if (db.database !== null) {
      sessionOpts.database = db.database
      // Awaited, and bounded inside. A schema read is one short round trip and it belongs in
      // the cached prefix, so it is worth the wait -- but a server that accepts a connection
      // and then never answers must not hold the window on its welcome screen, which is why
      // `loadSchemaBlock` carries its own deadline and returns null rather than throwing.
      const schema = await loadSchemaBlock(db.database)
      if (schema !== null) sessionOpts.databaseSchema = schema
    }

    // A crash barrier on one turn. `loop.ts` defaults `maxSteps` to Infinity and only the CLI
    // ever set it, so every turn the window has ever run was unbounded — while the loop
    // detector, the only other thing that can stop a spinning turn, was comparing results
    // whose first characters were a wall-clock duration. Between them there was no stop
    // condition at all for an autopilot turn that had started chasing its own tail.
    //
    // Deliberately generous. The detector is the precise instrument and should do the real
    // work; this only catches what it cannot see. The recorded corpus was shaped by the CLI's
    // 40, which shows both sides: it terminated two thrash bursts, and it also cut off eight
    // turns mid-task with "stopped after 40 steps without finishing".
    sessionOpts.maxSteps = MAX_STEPS_PER_TURN

    const session = new Session(sessionOpts)
    this.session = session
    // The plan follows the SESSION, not the toolset: the toolset outlives every switch,
    // and an unbound store carried session A's plan straight into session B's Plan card.
    // Bound before the `todos` emit below, so what gets emitted is this session's own.
    this.toolset?.todos.bind(session.id)
    // Wired here rather than inside Session: the queue is core's, the event is the wire's,
    // and Session has no business knowing a protocol exists.
    session.decisionQueue()?.onChange((pending) => this.emit('decisions.changed', { pending }))
    this.engine = engine

    // Memory, MCP and browser problems all ride the channel settings problems already use --
    // no new event, and the app already renders it. `externalProblems` is repeated on every
    // session switch rather than only on the init that produced it: a user who switches
    // sessions must not lose the notice that one of their MCP servers failed to start.
    const problems = [
      ...engine.problems, ...memory.problems, ...skills.problems, ...notes.problems,
      ...formatting.problems,
      ...db.problems,
      ...hooking.problems,
      ...verifying.problems,
      ...this.externalProblems,
      // A folder that failed to attach is invisible in the tree, and an invisible folder is
      // indistinguishable from an empty one. Repeated on every session switch, like the
      // external problems above and for the same reason.
      ...this.workspaceProblems,
      ...profile.problems,
    ]
    if (this.contextLength === null) {
      problems.push(
        'the model server did not answer GET /props, so automatic compaction is off for this ' +
        'session. It is usually still loading — start a new session once it is up and this ' +
        'goes away.',
      )
    }
    for (const p of problems) this.emit('settings.problem', { text: p })

    // The plan panel after a restart: the store reloaded state/plan.json, but the only
    // `todos` emit lived inside todo_write — so a resumed session showed an empty Plan
    // card over a live plan until the model happened to touch it. Deferred past this
    // reply on purpose: the app resets its state when the init/resume result lands, and
    // an event sent before it would be wiped with everything else.
    const planItems = this.toolset?.todos.list() ?? []
    if (planItems.length > 0) {
      setImmediate(() => this.emit('todos', { items: planItems.map((t) => ({ ...t })) }))
    }

    return {
      sessionId: session.id,
      mode: session.mode,
      contextLength: this.contextLength,
      workspaceName: this.workspaceName,
      folderCount: this.mounts.length,
      contextUsed: session.contextUsage(),
      ...(session.compactAt() !== null ? { compactAt: session.compactAt() as number } : {}),
      problems,
      title: session.meta.title,
      // Empty for a new session, and cheap to compute either way: this is a map over
      // messages already in memory, not a second read of the session file.
      items: resumeId === undefined
        ? []
        : replayEntries(
          session.messages(),
          toolOutcomes(workspaceRoot, session.id),
          session.loadedCompaction,
        ),
    }
  }

  /**
   * One stored session, read off disk, with nothing about the live one disturbed.
   *
   * Deliberately does NOT go through `switchSession`: that aborts the running turn, which is
   * the whole reason browsing used to cost you your work. Nothing here touches `this.session`,
   * the abort controller, or the pending interactions.
   */
  private sessionsRead(params: SessionsReadParams): SessionsReadResult {
    const { store, workspaceRoot } = this.requireInitialized()
    const { meta, transcript, compaction } = store.load(params.id)
    return {
      sessionId: meta.id,
      title: meta.title,
      mode: meta.mode,
      updatedAt: meta.updatedAt,
      items: replayEntries(transcript.messages(), toolOutcomes(workspaceRoot, meta.id), compaction),
    }
  }

  private sessionsSearch(params: SessionsSearchParams): SessionsSearchResult {
    const { store, workspaceRoot } = this.requireInitialized()
    return { hits: searchSessions(workspaceRoot, store.list(), params.query, params.limit ?? 20) }
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
      // The signal is what makes the bookkeeping above real: without it Escape fired a
      // controller nothing listened to, a session switch blocked on the whole summary
      // generation, and shutdown() returned while the request still held the single slot.
      const work = session.forceCompact(this.currentAbort.signal)
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
      const { workspaceRoot, workspace } = this.requireInitialized()
      const expanded = expandCommand(workspaceRoot, params.text)
      // Attachments are added AFTER command expansion, so `@file` works with a slash
      // command too, and each problem (missing, clipped, over budget) is emitted on the
      // channel the app already renders rather than being swallowed.
      const attached = await attachFiles(workspace, params.attach ?? [], expanded?.text ?? params.text)
      for (const note of attached.notes) this.emit('settings.problem', { text: note })
      // The distill decision is made on what the user TYPED: attachments fold whole files
      // into the text, and "what does this do? @src/foo.ts" is not a task however many
      // kilobytes ride along with it.
      const running = session.send(attached.text, this.currentAbort.signal, {
        distill: looksLikeTask(params.text),
      })
      this.currentTurn = running
      const result = await running
      const turn: TurnSummary = {
        steps: result.steps, finalText: result.finalText, stoppedBecause: result.stoppedBecause,
        ...(result.delivered === false ? { delivered: false } : {}),
      }
      this.emit('turn.done', turn)
      return { turn }
    } finally {
      for (const text of this.engine?.problems.slice(problemsBefore) ?? []) {
        this.emit('settings.problem', { text })
      }
      // Checkpoints, the work log and the decision queue report their failures by collecting
      // them rather than throwing, and only the end of an unattended RUN ever drained that.
      // A manual turn is now the thing that can run for hours, so it is the thing that has
      // to say when the snapshotting it is being trusted for stopped working — waiting for
      // a run that may never happen means the answer arrives after the hour worth undoing.
      for (const text of session.longRunProblems()) this.emit('settings.problem', { text })
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
   * present at all). `onThinking` has no wire-event counterpart in the protocol (only the
   * streamed deltas do) and is left unwired.
   */
  private buildAgentEvents(): AgentEvents {
    return {
      onStepStart: (info) => this.emit('step.start', {
        step: info.step, timeoutMs: info.timeoutMs, firstTokenTimeoutMs: info.firstTokenTimeoutMs,
      }),
      onToolOutput: (name, text) => this.emit('tool.output', { name, text }),
      onContinuation: (step, firstTokenTimeoutMs) => this.emit('step.continuation', {
        step, ...(firstTokenTimeoutMs !== undefined ? { firstTokenTimeoutMs } : {}),
      }),
      onStepRetry: (firstTokenTimeoutMs) => this.emit('step.retry', { firstTokenTimeoutMs }),
      onStepDone: (info) => this.emit('step.done', {
        step: info.step,
        seconds: info.seconds,
        ...(info.tokensPerSecond !== undefined ? { tokensPerSecond: info.tokensPerSecond } : {}),
        ...(info.promptTokens !== undefined ? { promptTokens: info.promptTokens } : {}),
        ...(info.completionTokens !== undefined ? { completionTokens: info.completionTokens } : {}),
        ...(info.draftAcceptance !== undefined ? { draftAcceptance: info.draftAcceptance } : {}),
        // Asked of the session rather than derived from `info`: the corrected figure needs
        // the transcript as it stands right now, which only the session has.
        ...this.contextReadout(),
      }),
      onProgress: (progress) => this.emit('generation.progress', { scope: 'step', ...progress }),
      onThinkingDelta: (text) => this.emit('thinking.delta', { text }),
      onTextDelta: (text) => this.emit('text.delta', { text }),
      onToolCallDelta: (info) => this.emit('tool.call.delta', info),
      onToolCall: (name, args) => this.emit('tool.call', { name, args }),
      // Recording which calls worked is `Session`'s job now, not this host's — every front
      // end reaches the model through a Session, and only this one ever recorded.
      onToolResult: (name, result, _callId) => {
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

  /** The two figures the status bar's readout needs, or nothing when there is no session to
   * ask. Kept beside the emit so every event that carries them carries the same pair. */
  private contextReadout(): { contextUsed?: number; compactAt?: number } {
    const session = this.session
    if (session === undefined) return {}
    const usage = session.contextUsage()
    const used = usage.promptTokens ?? usage.approxTokens
    const at = session.compactAt()
    return { contextUsed: used, ...(at !== null ? { compactAt: at } : {}) }
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
  /**
   * Fuzzy file lookup for the composer's `@` picker and the palette.
   *
   * The walk is cached for the life of a workspace: it fires on every keystroke, and a
   * repository is not going to grow a new file between two of them often enough to justify
   * re-walking. `init` replaces the whole host state anyway, and a file created mid-session
   * appears after the next workspace open — a picker that is one file stale is a far smaller
   * cost than one that stats the tree sixty times a minute.
   */
  private async fsFind(params: FsFindParams): Promise<FsFindResult> {
    const { workspace } = this.requireInitialized()
    if (this.fileIndex === undefined) {
      // Every folder, prefixed — otherwise `@` would only ever reach the primary one, and a
      // picker that silently covers a fifth of the workspace is worse than no picker.
      const all: string[] = []
      for (const mount of workspace.mounts) {
        const files = await walkFiles(mount.root)
        all.push(...(workspace.multi
          ? files.map((f) => `${mount.name}/${f.split(/[\\/]/).join('/')}`)
          : files))
      }
      this.fileIndex = all
    }
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100)
    return { paths: rankFiles(this.fileIndex, params.query, limit).map((m) => m.path) }
  }

  /** The folders this workspace is made of, with what git is under each. */
  private async workspaceGet(): Promise<WorkspaceGetResult> {
    const { workspace } = this.requireInitialized()
    const folders: WorkspaceFolderView[] = []
    for (const mount of workspace.mounts) {
      folders.push({
        name: mount.name,
        root: mount.root,
        access: mount.access,
        primary: mount.primary,
        git: await describeFolder(mount.root),
      })
    }
    return { name: this.workspaceName, folders, problems: [...this.workspaceProblems] }
  }

  /**
   * Replaces the attached folders and re-opens the workspace.
   *
   * Everything downstream of the folder list is rebuilt rather than patched — the jail, the
   * repo map, the undo units, the file index, the MCP servers — because every one of them is
   * derived from it, and a half-updated workspace is the shape in which a write lands
   * somewhere nobody expected. The session is preserved by resuming the current one.
   */
  /**
   * The composer's Improve button. Holds the same `sending` slot a turn does: the preview
   * is a real model request against the single slot, and a send racing it would interleave
   * two prompts — the composer already queues a send refused with this exact message.
   */
  private async promptImprove(params: PromptImproveParams): Promise<PromptImproveResult> {
    const session = this.requireSession()
    if (typeof params?.text !== 'string' || params.text.trim() === '') {
      throw new Error('prompt.improve needs the draft text')
    }
    if (this.sending) throw new Error('a turn is already running in this session')
    this.sending = true
    this.currentAbort = new AbortController()
    try {
      return { suggestions: await session.previewSuggestions(params.text, this.currentAbort.signal) }
    } finally {
      this.sending = false
      this.currentAbort = undefined
    }
  }

  /** The composer's expand preview. Same slot discipline as `promptImprove` above and for
   * the same reason: this is a real model request against the single slot. */
  private async promptExpand(params: PromptExpandParams): Promise<PromptExpandResult> {
    const session = this.requireSession()
    if (typeof params?.text !== 'string' || params.text.trim() === '') {
      throw new Error('prompt.expand needs the draft text')
    }
    if (this.sending) throw new Error('a turn is already running in this session')
    this.sending = true
    this.currentAbort = new AbortController()
    try {
      return { expanded: await session.previewExpansion(params.text, this.currentAbort.signal) }
    } finally {
      this.sending = false
      this.currentAbort = undefined
    }
  }

  private async workspaceSet(params: WorkspaceSetParams): Promise<WorkspaceSetResult> {
    const { workspaceRoot } = this.requireInitialized()
    const existing = this.workspaceFile
    saveWorkspaceFile(workspaceRoot, {
      version: 1,
      ...(params.name !== undefined && params.name.trim() !== '' ? { name: params.name.trim() } : {}),
      folders: params.folders.map((f) => ({
        // A RELATIVE typed path means relative to the workspace root — the only sane
        // reading. `resolve()` alone read it against the process CWD, so the dev bridge
        // stored `../crm-live` as `..\..\PrivateCode\crm-live` and the mount died on
        // the next open with "no longer at" naming a directory nobody ever typed.
        path: storedPath(workspaceRoot, isAbsolute(f.path) ? f.path : resolve(workspaceRoot, f.path)),
        ...(f.name !== undefined && f.name.trim() !== '' ? { name: f.name.trim() } : {}),
        access: f.access,
      })),
      // Carried over untouched: the manager edits folders, and dropping the profile because
      // it was not part of this dialog would silently unconfigure the workspace.
      ...(existing?.profile !== undefined ? { profile: existing.profile } : {}),
    })
    return {}
  }

  /**
   * The working tree as the Changes panel shows it: every repository the workspace touches,
   * and the folders that are under no version control at all.
   *
   * Never throws for "not a repository". With one folder that was a yes-or-no question; with
   * several it is not even the same question per folder, and none of the answers is an error.
   */
  private async gitStatusFor(): Promise<GitStatusResult> {
    const { workspace } = this.requireInitialized()
    const found = await discoverRepos(workspace)
    return {
      repos: found.repos.map((repo) => ({
        root: repo.root,
        label: repo.label,
        branch: repo.branch,
        relation: repo.relation,
        files: repo.files,
        // The suggestion describes what a commit WOULD contain, which is the staged set —
        // only before anything is staged does it fall back to describing all of it.
        suggestion: suggestCommitMessage(
          repo.files.some((f) => f.staged) ? repo.files.filter((f) => f.staged) : repo.files,
        ),
        ...(repo.problem !== undefined ? { problem: repo.problem } : {}),
      })),
      unversioned: found.unversioned,
    }
  }

  /** The repository is found from the file rather than passed in: the panel has a path, and
   * asking git which repository owns it is one process and cannot disagree with itself. */
  private async gitDiffFor(params: GitDiffParams): Promise<GitDiffResult> {
    const { workspace } = this.requireInitialized()
    // Contained to the workspace's folders before it reaches git, but NOT through the model's
    // jail: that also refuses `.env*`, `.npmrc` and `*.pem` by name, and this panel lists
    // those files, so a row the user is looking at answered with "access denied" where its
    // diff belongs. See `resolvePanelPath`.
    const abs = resolvePanelPath(workspace, params.path)
    const repoRoot = await repoRootFor(abs)
    if (repoRoot === null) return { diff: '' }
    // Canonical on both sides before they are subtracted: `repoRoot` is git's spelling and
    // `abs` is the caller's, and one Windows directory answers to several names. Mismatched,
    // `relative` returned a `..\..\`-laden path and git diffed nothing at all.
    const within = relative(repoRoot, canonicalize(abs)).split(sep).join('/')
    return { diff: await gitDiff(repoRoot, within, params.untracked === true) }
  }

  /**
   * Stage or unstage, into whichever repository holds the paths.
   *
   * A set that spans two repositories is refused, not split — same discipline as commit:
   * the tree sends one file per click and one repository per "stage all", so reaching the
   * refusal is already a sign something was misunderstood.
   */
  private async gitStageFor(params: GitStageParams, action: 'stage' | 'unstage'): Promise<GitStageResult> {
    const { workspace } = this.requireInitialized()
    const first = params.paths[0]
    if (first === undefined) return { ok: false, problem: `nothing to ${action}` }
    // Reported, not thrown: an unresolvable first path used to escape the handler as a raw
    // error reply, so the panel showed a transport failure instead of the refusal the rest
    // of the set already produces through `toRepoPaths`.
    let repoRoot: string | null
    try {
      repoRoot = await repoRootFor(resolvePanelPath(workspace, first))
    } catch (e) {
      return { ok: false, problem: (e as Error).message }
    }
    if (repoRoot === null) {
      return { ok: false, problem: `${first} is not inside a git repository` }
    }
    const translated = toRepoPaths(workspace, repoRoot, params.paths)
    if (!translated.ok) return { ok: false, problem: translated.problem }
    return action === 'stage'
      ? gitStage(repoRoot, translated.paths)
      : gitUnstage(repoRoot, translated.paths)
  }

  /**
   * Commits the index of one repository — what the user staged on the tree, never more.
   *
   * Two refusals guard the "never more". The root must be a repository this workspace
   * actually touches, not an arbitrary directory the wire named. And every staged path
   * must be inside the workspace's own folders: in the mounted-subdir-of-a-monorepo case
   * the index can carry files staged elsewhere by hand, and committing them under this
   * window's message would make the commit say things its author never saw.
   */
  private async gitCommitFor(params: GitCommitParams): Promise<GitCommitResult> {
    const { workspace } = this.requireInitialized()
    const found = await discoverRepos(workspace)
    const repo = found.repos.find((r) => r.root === resolve(params.root))
    if (repo === undefined) {
      return { ok: false, problem: 'that repository is not part of this workspace' }
    }

    const staged = await stagedPaths(repo.root)
    if (staged.length === 0) {
      return { ok: false, problem: 'nothing is staged — stage the files to commit first' }
    }
    // Read-only mounts count as OUTSIDE: the panel never lists their files (discoverRepos
    // skips read-only folders), and committing what the window cannot show would put
    // changes its author never saw under this message.
    const outside = staged.filter((p) => {
      const mount = workspace.mountFor(join(repo.root, p))
      return mount === undefined || mount.access === 'read'
    })
    if (outside.length > 0) {
      return {
        ok: false,
        problem: `the index also holds files outside this workspace (${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ', …' : ''}) — commit those from a terminal first`,
      }
    }

    const result = await gitCommitStaged(repo.root, params.message)
    return {
      ok: result.ok,
      ...(result.sha !== undefined ? { sha: result.sha } : {}),
      ...(result.problem !== undefined ? { problem: result.problem } : {}),
    }
  }

  private async fsTree(params: FsTreeParams): Promise<FsTreeResult> {
    const { workspace } = this.requireInitialized()
    // The root of a multi-folder workspace is the folder list, not a directory on disk.
    if (workspace.multi && isRootPath(params.path ?? '')) {
      return { entries: workspace.mounts.map((m) => ({ name: m.name, dir: true })) }
    }
    const abs = workspace.resolve(params.path ?? '')
    const dirents = await readdir(abs, { withFileTypes: true })
    const entries: FsTreeEntry[] = dirents
      // The app's own state and git's object store are internal, not project files: a
      // mount that once ran PrivateCode standalone showed its `.privatecode/` — session
      // transcripts included — as ordinary browsable folders in the tree. Only these two;
      // `node_modules` and build output stay visible, because a user's tree is a browser,
      // not the model's picker (`file-search.ts` SKIP governs that one).
      .filter((d) => !(d.isDirectory() && (d.name === '.privatecode' || d.name === '.git')))
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      // A file explorer's order: folders first, then files, names compared without case as
      // a sort key and with digits read as numbers (`v2` before `v10`). A flat
      // `localeCompare` mixed folders in among the files and pushed every capitalised name
      // into a block of its own — see `compareTreeRows` in the app, which sorts what is
      // actually rendered (its rows include git's deleted-file ghosts) by the same rule.
      .sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1
        const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        return byName !== 0 ? byName : a.name.localeCompare(b.name)
      })
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

  private async checkpointsList(params: CheckpointsListParams = {}): Promise<CheckpointsListResult> {
    const session = this.requireSession()
    return { checkpoints: await session.listCheckpoints(params.limit) }
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
    const path = `${PRIVATE_DIR}/${STATE_DIR}/worklog.md`
    try {
      return { text: await readFile(statePath(workspaceRoot, 'worklog.md'), 'utf8'), path }
    } catch {
      // An absent log is the normal state of a workspace that has never run unattended, not
      // an error to put in front of someone.
      return { text: '', path }
    }
  }

  /**
   * Every standing permission, and the file each one is written in.
   *
   * Read fresh from disk on every call rather than served from the engine's in-memory copy.
   * Two reasons, and the second is the one that matters: the files are hand-editable and
   * another window may be open on the same workspace, so the engine's copy is a snapshot of
   * what was true when the session was built — and a screen whose whole job is to tell you
   * what the agent may do must not show you a stale answer to that question.
   *
   * `problems` is carried through for the same reason: a layer that failed to parse
   * contributes no rules, and a list that silently omitted it would read as "nothing is
   * granted here" when the truth is "this file could not be read".
   */
  private permissionsList(): PermissionsListResult {
    const { workspaceRoot } = this.requireInitialized()
    const { layers, problems } = loadLayers(workspaceRoot)
    return {
      layers: layers.map((layer) => ({
        scope: layer.scope,
        path: layer.path,
        rules: (['deny', 'ask', 'allow'] as const).flatMap((list) =>
          layer.permissions[list].map((rule) => ({ rule, list }))),
      })),
      mode: this.session?.mode ?? 'normal',
      problems,
    }
  }

  /**
   * Withdraws one rule from the layer that holds it.
   *
   * The engine is rebuilt from disk on the next session build, so this does not try to patch
   * the live one: a revocation that took effect in the file but not in memory would be worse
   * than one that is honest about when it applies. What it does do is say plainly whether the
   * rule was there, so a revocation that hit an already-edited file is visible rather than
   * silently successful.
   */
  private permissionsRemove(params: PermissionsRemoveParams): PermissionsRemoveResult {
    const { workspaceRoot } = this.requireInitialized()
    const path = params.scope === 'user'
      ? userSettingsPath()
      : params.scope === 'project'
      ? projectSettingsPath(workspaceRoot)
      : localSettingsPath(workspaceRoot)
    const removed = removeRuleFromSettings(path, params.list, params.rule)
    // The LIVE engine too, not only the file — and this line is the whole difference
    // between a permissions screen and a permissions-shaped decoration. A grant applies to
    // the running engine the moment it is made (`engine.remember`), so a revocation that
    // only edited the file left the two permanently asymmetric: the screen showed the rule
    // gone while `decide()` kept auto-allowing on the in-memory copy until the next session
    // build — which, mid-overnight-run, is never. Verified live before the fix: the engine
    // answered `Allowed by rule ...` citing a file that no longer contained the rule.
    this.engine?.forget(params.scope, params.list, params.rule)
    return { removed }
  }

  /**
   * Writes one rule from the permissions screen — remove's mirror, disk AND live engine.
   *
   * Validation runs FIRST, against the live engine's own parser, and a problem returns
   * without touching the file: a malformed rule written to disk would come back as a
   * session-level problem string on every future session build, which is the wrong place
   * to learn about a typo you made in a form five seconds ago.
   */
  private permissionsAdd(params: PermissionsAddParams): PermissionsAddResult {
    const { workspaceRoot } = this.requireInitialized()
    const problem = this.engine?.adopt(params.scope, params.list, params.rule) ?? null
    if (problem !== null) return { problem }
    const path = params.scope === 'user'
      ? userSettingsPath()
      : params.scope === 'project'
      ? projectSettingsPath(workspaceRoot)
      : localSettingsPath(workspaceRoot)
    try {
      addRuleToSettings(path, params.list, params.rule)
    } catch (e) {
      // The live engine already holds it, so the rest of this session honours what was just
      // written — same fallback remember() uses when a settings file cannot be written.
      return { problem: `${(e as Error).message}; the rule applies for this session only` }
    }
    return { problem: null }
  }

  /** What is on disk right now — see the protocol's note on why not the running session. */
  private skillsList(): SkillsListResult {
    const { workspaceRoot } = this.requireInitialized()
    const loaded = loadSkills(workspaceRoot)
    return {
      skills: loaded.skills.map((s) => ({
        name: s.name, scope: s.scope, description: s.description, path: s.path, files: s.files,
      })),
      problems: loaded.problems,
      dirs: [
        { scope: 'project', path: projectSkillsDir(workspaceRoot) },
        { scope: 'user', path: userSkillsDir() },
      ],
    }
  }

  /** The project file's `mcpServers` object, verbatim — see the protocol's rationale. */
  private mcpRawRead(): McpRawReadResult {
    const { workspaceRoot } = this.requireInitialized()
    const path = projectSettingsPath(workspaceRoot)
    let json = '{}'
    if (existsSync(path)) {
      try {
        const doc: unknown = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof doc === 'object' && doc !== null && !Array.isArray(doc)) {
          const servers = (doc as Record<string, unknown>)['mcpServers']
          if (servers !== undefined) json = JSON.stringify(servers, null, 2)
        }
      } catch { /* an unparseable file is reported by loadLayers; the editor starts from {} */ }
    }
    return { json, path }
  }

  /**
   * Replaces the `mcpServers` key with the edited JSON document.
   *
   * Two checks and no more, both BEFORE anything is written: the text must parse, and its
   * root must be an object of objects — the one shape `loadServers` can read at all. A typo
   * comes back as this method's error with the file untouched. Anything deeper (a server
   * with neither command nor url) is deliberately NOT judged here: it is legal to save a
   * half-written entry, and the connect that follows reports it through the same problems
   * pipeline every hand edit has always used. Direct editing means the file is the truth,
   * so unlike the form this replaces, nothing is merged per entry — what you saved is what
   * is there.
   */
  private mcpRawSave(params: McpRawSaveParams): McpRawSaveResult {
    const { workspaceRoot } = this.requireInitialized()
    let edited: unknown
    try {
      edited = JSON.parse(params.json)
    } catch (e) {
      throw new Error(`that is not valid JSON: ${(e as Error).message}`)
    }
    if (typeof edited !== 'object' || edited === null || Array.isArray(edited)) {
      throw new Error('the document root must be an object: { "server-name": { ... }, ... }')
    }
    for (const [name, entry] of Object.entries(edited as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`"${name}" must be an object with a "command" or a "url"`)
      }
    }

    const path = projectSettingsPath(workspaceRoot)
    let doc: Record<string, unknown> = {}
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8')
      let candidate: unknown
      try {
        candidate = JSON.parse(raw)
      } catch (e) {
        throw new Error(`${path} is not valid JSON (${(e as Error).message}); fix it by hand first`)
      }
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        throw new Error(`${path} has a non-object JSON root; fix it by hand first`)
      }
      doc = candidate as Record<string, unknown>
    }

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ ...doc, mcpServers: edited }, null, 2)}\n`, 'utf8')
    return {}
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
    // The server is a process the user stops and restarts to change `-c` or to swap the
    // GGUF, and coming back up is the only moment its properties can differ from what we
    // hold. So that transition — and only it — re-reads them. Polling /props on every tick
    // would put a second request on a single-slot server ten times a minute for a value
    // that changes a few times a day; never re-reading it is the bug this fixes.
    // ...and also whenever we simply do not have them. A probe can fail for reasons that
    // never produce a down->up edge later: /props timed out on a cold start while /health
    // was already answering, or the server answered 200 with a body this build could not
    // read a window size out of. `serverWasUp` was true throughout, so the edge never
    // arrived, and a null window size can never heal — the readout stays absent for the life
    // of the process. Cheap to add: this only fires while the value is missing, so a healthy
    // session pays for it exactly zero times.
    if (serverUp && (this.serverWasUp === false || this.contextLength === null)) {
      await this.refreshServerProps()
    }
    this.serverWasUp = serverUp
    const result: StatusResult = { serverUp, model: this.model }
    if (this.contextLength !== null) result.contextLength = this.contextLength
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
  /** The Plan card's dismiss: the USER retiring a plan the harness had no reason to —
   * watched live, a finished-but-ungated task left an unclosable 6/6 card. Empties the
   * store (plan.json included) and announces it, so the card disappears everywhere. */
  private todosClear(): Record<string, never> {
    const { toolset } = this.requireInitialized()
    if (toolset.todos.list().length > 0) {
      toolset.todos.set([])
      this.emit('todos', { items: [] })
    }
    return {}
  }

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
  multiSelect?: boolean
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
    ...(entry.multiSelect === true ? { multiSelect: true } : {}),
    ...(entry.options !== undefined ? { options: entry.options } : {}),
  }
}

/**
 * settings.json's `"compaction": { "triggerTokens": N }` — the absolute rot threshold the
 * context-rot probe calibrates (`spike/context-rot-probe.mjs`). Most specific file wins,
 * exactly like the verify command; absent or malformed means undefined, which is the
 * ratio-only behaviour every workspace had before the knob existed.
 */
function loadTriggerTokens(workspaceRoot: string): number | undefined {
  for (const path of [
    localSettingsPath(workspaceRoot), projectSettingsPath(workspaceRoot), userSettingsPath(),
  ]) {
    try {
      const parsed = JSON.parse(settingsText(readFileSync(path, 'utf8'))) as {
        compaction?: { triggerTokens?: unknown }
      }
      // Floor BEFORE the bound: a ratio-style value like 0.8 would floor to 0 after
      // passing `v > 0`, and a 0 threshold makes every send trigger a compaction.
      const v = parsed.compaction?.triggerTokens
      if (typeof v === 'number' && Number.isFinite(v) && Math.floor(v) >= 1) return Math.floor(v)
    } catch { /* absent file, or malformed — the permission loader already reports that */ }
  }
  // Watched live at 179k context: llama.cpp's prompt-state stash refused the slot state
  // ("prompt state size 9397.605 MiB exceeds cache size limit 8192.000 MiB, skipping"),
  // so the first divergent-tail request (the distiller) evicted the whole prefix and the
  // next turn re-prefilled ~187k tokens for nine minutes into the step deadline. The
  // hybrid DeltaNet state cannot be rewound, so past the stash limit EVERY side request
  // (distill, gate, review) costs a full re-prefill. State measures ~0.052 MiB/token,
  // the server's default --cache-ram is 8192 MiB → the cliff sits at ~157k tokens.
  // Compacting at 140k keeps the whole session on the working side of it, with margin
  // for mid-turn growth; settings.json `compaction.triggerTokens` still overrides.
  // The number itself lives in session.ts, which needs it for the same reason when the
  // window arrives late — one constant, so the two cannot drift apart.
  return DEFAULT_TRIGGER_TOKENS
}
