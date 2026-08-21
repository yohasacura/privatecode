/**
 * The wire contract between the (future) Tauri UI and the agent sidecar: a request/reply/
 * event envelope, one named params/result interface per method and one named data
 * interface per event, and the ndjson framing helpers (`encodeLine` / `LineDecoder`) that
 * turn those envelopes into a byte stream and back.
 *
 * Pure module: no side effects, no runtime dependency on anything the sidecar itself does
 * (llama.cpp client, workspace, tool registry). Where the UI's shape already exists
 * elsewhere in core -- `SessionMeta`, `TodoItem`, `AgentMode`, `ApprovalDecision`,
 * `ApprovalRequest`, `UserQuestion` -- it is imported and reused rather than redefined, so
 * the two are structurally incapable of drifting apart. Everything else here (the
 * `tool.result` fields, the compaction state union, `TurnSummary`) has no counterpart
 * among those four import sources and is defined fresh; see the doc comment on each for
 * why it isn't imported from wherever the "real" shape happens to live today.
 */
import type { ApprovalDecision, ApprovalRequest, TodoItem, UserQuestion } from '../interaction.js'
import type { AgentMode } from '../permissions/engine.js'
import type { SessionMeta } from '../session/store.js'

// ---------------------------------------------------------------------------------------
// Envelope (verbatim -- see Plan 4 Task 1 brief).
// ---------------------------------------------------------------------------------------

/** UI -> sidecar request. */
export interface HostRequest { id: number; method: string; params?: unknown }
/** sidecar -> UI reply. Exactly one per request id. */
export type HostReply =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } }
/** sidecar -> UI event (unsolicited). */
export interface HostEvent { event: string; data: unknown }
export type HostOutbound = HostReply | HostEvent

/** Discriminates a `HostOutbound` message as a `HostEvent` (has 'event' field). */
export function isHostEvent(msg: HostOutbound): msg is HostEvent {
  return 'event' in msg
}

// ---------------------------------------------------------------------------------------
// Shared shapes.
// ---------------------------------------------------------------------------------------

/**
 * The typed spelling of a `{}` params or result: an object with no properties a caller may
 * read, as opposed to `{}` (the type), which -- famously -- describes almost any value at
 * all. Used everywhere the method table says a bare `{}`.
 */
export type Empty = Record<string, never>

/**
 * How one turn ended, shared verbatim between `send`'s result (nested under `turn`) and
 * the `turn.done` event (the same three fields, flat). Deliberately redeclared here rather
 * than imported from `agent/loop.ts`'s `TurnResult` to decouple the wire contract from
 * internal execution-layer types: an internal refactor to agent/loop.ts cannot silently
 * change the UI protocol. Must be kept in sync by hand if the agent loop's values ever
 * change.
 */
export type StoppedBecause = 'done' | 'max_steps' | 'aborted' | 'timeout' | 'truncated'

export interface TurnSummary {
  steps: number
  /** The model's closing prose, or a one-line statement of why the turn stopped. */
  finalText: string
  stoppedBecause: StoppedBecause
  /** False only when the turn aborted before the user message reached the transcript
   * (Esc during contract distillation). The front end must roll back its optimistic
   * message row and return the text to the composer: nothing "continues from here",
   * because the model never received the message. Absent on every delivered turn. */
  delivered?: boolean
}

// ---------------------------------------------------------------------------------------
// Methods: one params/result interface per method, named `<Method>Params`/`<Method>Result`.
// ---------------------------------------------------------------------------------------

export interface InitParams {
  workspaceRoot: string
  serverUrl: string
  /** Session id to resume instead of starting fresh. */
  resume?: string
  /**
   * Resume this workspace's most recent session, whichever it is. Ignored when `resume`
   * names one explicitly, and a no-op in a workspace with no sessions yet.
   *
   * A separate field rather than a magic `resume: 'last'`, because the two questions are
   * genuinely different: one names a session, the other asks the host which one that would
   * be. The app asks it on every launch — closing a window used to throw away the
   * conversation you were in the middle of, and starting fresh is one click away.
   */
  continueLast?: boolean
}
export interface InitResult {
  sessionId: string
  mode: AgentMode
  /** The model's context window in tokens, or null when the server never reported one. */
  contextLength: number | null
  problems: string[]
  title: string
  /** The conversation so far, empty for a new session. See `TranscriptEntry`. */
  items: TranscriptEntry[]
  /** What to call this workspace: its profile name, or the primary folder's own name. */
  workspaceName: string
  /** How many folders it is made of. The window says so when it is more than one — a
   * titlebar that names only the primary folder would be describing a fifth of the jail. */
  folderCount: number
  /**
   * How full the context is right now.
   *
   * `promptTokens` is the server's own count from the last step THIS PROCESS ran, so it is
   * null for a session that was resumed rather than driven; `approxTokens` is the
   * transcript's own estimate and is always available. The window showed nothing at all
   * until you spoke — a number it could have computed the whole time.
   */
  contextUsed: { promptTokens: number | null; approxTokens: number }
  /**
   * Where compaction will fire, in tokens — the same figure `step.done` carries.
   *
   * Without it a resumed session colours its bar against 80% of the window until the first
   * step lands, which on a default setup is 210k while compaction actually fires at 140k. So
   * the reading that matters most — "am I about to be compacted" — was wrong for exactly the
   * stretch where you have just reopened a long conversation and are looking at the bar to
   * decide whether to keep going.
   */
  compactAt?: number
}

/**
 * One moment of a stored conversation, in the shape the UI already knows how to fold.
 *
 * A resumed session used to come back as a title and nothing else: you clicked yesterday's
 * work in the rail and got an empty chat with the right name on it. The transcript was on
 * disk the whole time -- it is what the model is being sent -- and there was simply no way
 * to ask for it.
 *
 * These deliberately mirror the LIVE events rather than the finished rows: the app turns
 * each one into the same reducer action the live path dispatches, so a restored conversation
 * is assembled by exactly the code that assembles a running one. A second renderer for
 * history would be a second thing to keep in step, and it would drift.
 */
export type TranscriptEntry =
  /**
   * A user-role message. `harness: true` marks one the HARNESS wrote, not the person.
   *
   * The two share a role because the chat template has nowhere else to put them — a plan
   * focus note, a mid-turn verify result and a contract preamble are all `role: 'user'` so
   * the model reads them as instructions. On screen they are not the same thing at all, and
   * conflating them is what made a resumed session show four "your messages" when the
   * person had sent two.
   */
  | { kind: 'user'; text: string; harness?: true }
  | { kind: 'reasoning'; step: number; text: string }
  | { kind: 'tool-call'; name: string; args: string }
  /** `ok` for calls made before this feature existed is unknown and reported as `true`;
   * see `toolOutcomes` for why that is the honest default and what records the real one. */
  | { kind: 'tool-result'; name: string; ok: boolean; content: string }
  | { kind: 'assistant'; text: string }
  /**
   * Where the conversation was folded away, and what replaced it.
   *
   * A compaction rewrites the transcript into a briefing plus a tail, and the briefing is
   * carried in a `user` message so the model reads it as instruction. Replayed literally,
   * that message came back as something the USER had written -- five thousand characters of
   * "Session briefing from the earlier part of this conversation", attributed to a person
   * who never typed it, followed by an assistant "Understood; continuing from the briefing."
   * The single most consequential event in a session appeared in its record as a forgery and
   * nowhere as itself.
   *
   * `droppedMessages` comes from the on-disk marker and is absent for a transcript whose
   * marker could not be read; the briefing is always available, since it IS the message.
   */
  | { kind: 'compaction'; summary: string; droppedMessages?: number }

export interface SendParams {
  text: string
  /**
   * Workspace-relative paths the user attached with `@`. Read host-side and placed before
   * the text, so the model does not spend a step on a `read_file` for a path the person
   * already knew. Budgeted — see `attachFiles` — and every path still goes through the
   * workspace jail, because protocol params are not trusted just because a picker produced
   * them.
   */
  attach?: string[]
}
export interface SendResult { turn: TurnSummary }

export type AbortParams = Empty
export type AbortResult = Empty

export interface SetModeParams { mode: AgentMode }
export type SetModeResult = Empty

export type SessionsListParams = Empty
export interface SessionsListResult { sessions: SessionMeta[]; problems: string[] }

export type SessionsNewParams = Empty
/** Same shape as `init`'s result -- a fresh session, described the same way. */
export type SessionsNewResult = InitResult

/**
 * READS a stored session without becoming it.
 *
 * `sessions.resume` is a switch: it tears down the live session, which aborts whatever turn
 * is running. That made "let me glance at yesterday's conversation" and "abandon what I am
 * doing" the same click. This is the other half — the transcript, off disk, with the running
 * session untouched.
 */
export interface SessionsReadParams { id: string }
export interface SessionsReadResult {
  sessionId: string
  title: string
  mode: AgentMode
  updatedAt: string
  items: TranscriptEntry[]
}

export interface SessionsResumeParams { id: string }
/** Same shape as `init`'s result -- see `SessionsNewResult`. */
export type SessionsResumeResult = InitResult

export type CompactParams = Empty
export interface CompactResult { applied: boolean }

export interface ApprovalReplyParams { requestId: string; decision: ApprovalDecision }
export type ApprovalReplyResult = Empty

export interface QuestionReplyParams { requestId: string; answer: string }
export type QuestionReplyResult = Empty

/** Fuzzy file lookup for the composer's `@` picker and the command palette. Not the model's
 * `find_files`, which takes a glob: a person typing `@stat` is half-remembering a name. */
export interface FsFindParams { query: string; limit?: number }
export interface FsFindResult { paths: string[] }

/**
 * The working tree, for the Changes panel.
 *
 * Separate from the model's read-only `git_status` tool, which returns prose for a context
 * window. This returns structure for a panel, and `git.commit` does the one thing the
 * model's tool deliberately cannot: a commit is where work becomes permanent, and that is a
 * person's decision, made over a message they can read and edit.
 */
export type GitStatusParams = Empty
export interface GitFileChange {
  path: string
  code: string
  staged: boolean
  untracked: boolean
  /** A rename's OLD path (workspace-addressed) — unstaging must send both names, or the
   * old name's staged deletion survives alone and Commit would delete the file. */
  oldPath?: string
}

/**
 * One repository the workspace touches.
 *
 * `relation` is what stops the panel from lying about scope: `folder` is the ordinary case,
 * `above` means a folder is a subdirectory of a bigger repository and only its own subtree is
 * being shown, `nested` means the repository sits inside a folder and is its own project.
 */
export interface GitRepoView {
  /** Absolute toplevel. The identity a commit is addressed to. */
  root: string
  label: string
  branch: string | null
  relation: 'folder' | 'above' | 'nested'
  files: GitFileChange[]
  /** A starting point for the message field, derived from the files themselves. */
  suggestion: string
  problem?: string
}

export interface GitStatusResult {
  repos: GitRepoView[]
  /** Writable folders under no version control — nothing to commit, which is worth saying. */
  unversioned: { mount: string }[]
  problem?: string
}

/**
 * Put ONE file back to how it was before this session started, optionally with the user's
 * reason. The whole-workspace rewind is the wrong tool when a turn got four files right and
 * the fifth wrong, which is the common case.
 */
/** Full-text search across the workspace's stored conversations. Titles are the first line
 * of a session, which is the worst summary of what a long one became. */
/** One folder as the manager shows it. `git` is prose, deliberately: the four states a
 * folder can be in are not a flag, and "part of monorepo" is the one people need told. */
export interface WorkspaceFolderView {
  name: string
  root: string
  access: 'write' | 'read'
  primary: boolean
  git: string
}
export type WorkspaceGetParams = Empty
export interface WorkspaceGetResult {
  name: string
  folders: WorkspaceFolderView[]
  problems: string[]
}

/** The attached folders, whole — this replaces the list rather than patching it, so the file
 * on disk always matches what the manager was showing when Save was pressed. */
export interface WorkspaceSetParams {
  name?: string
  folders: { path: string; name?: string; access: 'write' | 'read' }[]
}
/** Nothing comes back: changing the folders changes the jail, the map, the undo units and
 * the file index, so the caller re-runs `init` rather than being handed a patch. */
export type WorkspaceSetResult = Empty

export interface SessionsSearchParams { query: string; limit?: number }
export interface SessionHit {
  sessionId: string; title: string; updatedAt: string; count: number; snippet: string
}
export interface SessionsSearchResult { hits: SessionHit[] }

export interface CheckpointsRestoreFileParams { path: string; note?: string }
export interface CheckpointsRestoreFileResult { removed: boolean }

export interface GitDiffParams { path: string; untracked?: boolean }
export interface GitDiffResult { diff: string }

/**
 * Staging, as its own visible act. Paths are workspace-addressed; the host resolves the
 * owning repository itself and refuses a set that spans two — same discipline as commit.
 */
export interface GitStageParams { paths: string[] }
export interface GitStageResult { ok: boolean; problem?: string }

/** Commits the INDEX of one repository — what the user staged, never more. `root` comes
 * from `git.status`; the host re-verifies it belongs to this workspace and that nothing
 * staged falls outside the workspace's own folders before anything permanent happens. */
export interface GitCommitParams { root: string; message: string }
export interface GitCommitResult { ok: boolean; sha?: string; problem?: string }

export interface FsTreeEntry { name: string; dir: boolean }
/** Jailed to the workspace root, like every other path the sidecar accepts from the UI. */
export interface FsTreeParams { path?: string }
export interface FsTreeResult { entries: FsTreeEntry[] }

/** Jailed to the workspace root; the result is capped at 2000 lines (see `truncated`). */
export interface FsReadParams { path: string }
export interface FsReadResult {
  lines: string[]
  truncated: boolean
  /**
   * For an image file: a `data:` URL the app can put straight in an `<img>`.
   *
   * The agent's own screenshots land in `.privatecode/browser/*.png`, and a screenshot the
   * person cannot look at is a screenshot that had no reason to be taken — the model has no
   * vision tower, so the human is its entire audience. When this is present, `lines` is
   * empty: there is no sensible text rendering of a PNG.
   */
  image?: { dataUrl: string; bytes: number }
}

export type StatusParams = Empty
/** One configured MCP server, as the app's settings panel sees it. A server that silently
 * contributes nothing is worse than one that fails loudly, so `failed` carries its reason. */
export interface McpServerInfo {
  name: string
  state: 'connected' | 'failed'
  toolCount: number
  problem?: string
}

export interface StatusResult {
  serverUp: boolean
  /**
   * What the server reports it is serving, from its `/props` model path — not a constant
   * this build was compiled with. Point the app at a different GGUF and this follows;
   * before, it kept displaying the model the tool was originally written for.
   */
  model?: string
  /**
   * The server's context window, in tokens. Worth showing beside the model because the two
   * change together and the second explains the first: a 32k window compacts many times in
   * a session where a 131k one never does.
   */
  contextLength?: number
  /** Absent before `init`. Empty means none are configured, which is the normal case. */
  mcpServers?: McpServerInfo[]
  /** Whether a browser is currently open, and where it is. */
  browser?: { running: boolean; url?: string }
}

/**
 * One long-running process, as the UI's Jobs and Terminal panels see it. Mirrors
 * `tools/background-task.ts`'s `JobSnapshot` intentionally but is redeclared here rather
 * than imported, for the same reason as `ToolResultEvent` and `TurnSummary`: an internal
 * refactor of the tool must not silently change the wire contract. Must be kept in sync by
 * hand if that snapshot shape changes.
 */
export interface JobInfo {
  id: string
  command: string
  /** `'agent'` = started by a `background_task` tool call (permission-gated);
   * `'user'` = started from the app's own terminal by the person sitting at it. */
  origin: 'agent' | 'user'
  /** Epoch milliseconds. */
  startedAt: number
  running: boolean
  exitCode: number | null
  stopped: boolean
  output: string
  clipped: boolean
}

/**
 * The user's own slash commands (`.privatecode/commands/<name>.md`). The app needs them to
 * offer a picker; expansion itself happens host-side in `send`, so a front end that skips
 * this method still gets working commands, just undiscoverable ones.
 */
export type CommandsListParams = Empty
export interface CommandsListResult {
  commands: { name: string; description: string }[]
}

/** Never errors before `init`: with no session there are simply no jobs. */
export type JobsListParams = Empty
export interface JobsListResult { jobs: JobInfo[] }

export interface JobsStopParams { id: string }
export type JobsStopResult = Empty

/**
 * Runs a command the USER typed into the app's terminal panel, in the workspace root, as a
 * background job. Deliberately not permission-gated: the permission engine exists to bound
 * what the MODEL may do unattended, and this path has no model in it -- the user typed the
 * command themselves, in their own workspace, in an app they launched. It is also never
 * added to the model's transcript, so a command run here cannot silently become context.
 */
export interface TerminalRunParams { command: string }
export interface TerminalRunResult { id: string }

/**
 * The UI's own small preferences -- last-used server URL and a short recent-workspaces
 * list -- persisted to `%APPDATA%/PrivateCode/ui.json` (see `host/ui-config.ts`). NOT the
 * permissions settings file (`permissions/settings.ts`'s `userSettingsPath()`,
 * `settings.json`): that file holds security-relevant allow/ask/deny rules, audited and
 * layered three ways; this one holds nothing security-relevant at all, so it is a
 * deliberately separate file with no layering.
 */
export type ConfigGetParams = Empty
export interface ConfigGetResult { serverUrl?: string; recentWorkspaces: string[] }

export interface ConfigSetParams {
  serverUrl?: string
  /** Records this workspace path as most-recently-used (most-recent-first, deduplicated,
   * capped) -- the UI's own concern, not something `init` does implicitly, so a workspace
   * is only ever remembered when the UI explicitly asks to. */
  recentWorkspace?: string
}
export type ConfigSetResult = Empty

/**
 * Every method this protocol defines, method name -> {params, result}. Nothing in this
 * module reads it -- it exists so a typed RPC client/dispatcher elsewhere can look up both
 * shapes for one method name without importing a chain of individual types.
 */
export interface HostMethodMap {
  init: { params: InitParams; result: InitResult }
  send: { params: SendParams; result: SendResult }
  abort: { params: AbortParams; result: AbortResult }
  setMode: { params: SetModeParams; result: SetModeResult }
  'sessions.list': { params: SessionsListParams; result: SessionsListResult }
  'sessions.new': { params: SessionsNewParams; result: SessionsNewResult }
  'sessions.resume': { params: SessionsResumeParams; result: SessionsResumeResult }
  'sessions.read': { params: SessionsReadParams; result: SessionsReadResult }
  'sessions.search': { params: SessionsSearchParams; result: SessionsSearchResult }
  'workspace.get': { params: WorkspaceGetParams; result: WorkspaceGetResult }
  'workspace.set': { params: WorkspaceSetParams; result: WorkspaceSetResult }
  'prompt.improve': { params: PromptImproveParams; result: PromptImproveResult }
  'prompt.expand': { params: PromptExpandParams; result: PromptExpandResult }
  compact: { params: CompactParams; result: CompactResult }
  'approval.reply': { params: ApprovalReplyParams; result: ApprovalReplyResult }
  'question.reply': { params: QuestionReplyParams; result: QuestionReplyResult }
  'fs.tree': { params: FsTreeParams; result: FsTreeResult }
  'fs.find': { params: FsFindParams; result: FsFindResult }
  'checkpoints.restoreFile': {
    params: CheckpointsRestoreFileParams; result: CheckpointsRestoreFileResult
  }
  'git.status': { params: GitStatusParams; result: GitStatusResult }
  'git.diff': { params: GitDiffParams; result: GitDiffResult }
  'git.stage': { params: GitStageParams; result: GitStageResult }
  'git.unstage': { params: GitStageParams; result: GitStageResult }
  'git.commit': { params: GitCommitParams; result: GitCommitResult }
  'fs.read': { params: FsReadParams; result: FsReadResult }
  status: { params: StatusParams; result: StatusResult }
  'commands.list': { params: CommandsListParams; result: CommandsListResult }
  'jobs.list': { params: JobsListParams; result: JobsListResult }
  'jobs.stop': { params: JobsStopParams; result: JobsStopResult }
  'terminal.run': { params: TerminalRunParams; result: TerminalRunResult }
  'todos.clear': { params: Empty; result: Empty }
  'config.get': { params: ConfigGetParams; result: ConfigGetResult }
  'config.set': { params: ConfigSetParams; result: ConfigSetResult }
  'checkpoints.list': { params: CheckpointsListParams; result: CheckpointsListResult }
  'checkpoints.rewind': { params: CheckpointsRewindParams; result: CheckpointsRewindResult }
  'decisions.list': { params: DecisionsListParams; result: DecisionsListResult }
  'decisions.resolve': { params: DecisionsResolveParams; result: DecisionsResolveResult }
  'worklog.read': { params: WorklogReadParams; result: WorklogReadResult }
  'permissions.list': { params: PermissionsListParams; result: PermissionsListResult }
  'permissions.remove': { params: PermissionsRemoveParams; result: PermissionsRemoveResult }
  'permissions.add': { params: PermissionsAddParams; result: PermissionsAddResult }
  'skills.list': { params: SkillsListParams; result: SkillsListResult }
  'mcp.rawRead': { params: McpRawReadParams; result: McpRawReadResult }
  'mcp.rawSave': { params: McpRawSaveParams; result: McpRawSaveResult }
  'run.start': { params: RunStartParams; result: RunStartResult }
  'run.stop': { params: RunStopParams; result: RunStopResult }
}
export type HostMethodName = keyof HostMethodMap

// ---------------------------------------------------------------------------------------
// Events: one data interface per event, named `<Event>Event`.
// ---------------------------------------------------------------------------------------

export interface StepStartEvent {
  step: number
  timeoutMs: number
  /** Prefill-inclusive budget for the wait before this step's first token — see
   * `StepStartInfo.firstTokenTimeoutMs`. A countdown should use this until something
   * streams, and `timeoutMs` after. Optional so an older replayed payload stays valid. */
  firstTokenTimeoutMs?: number
}
/** A forced continuation is starting inside the step: the silence that follows is prefill
 * of the carried-back reasoning, budgeted at `firstTokenTimeoutMs` — the countdown must
 * count against it, not the flat between-token budget. */
export interface StepContinuationEvent { step: number; firstTokenTimeoutMs?: number }
/** The server died mid-call, came back healthy, and the SAME request is being re-sent.
 * The dead attempt's partial deltas are superseded — the retry re-streams from the start —
 * so a renderer must discard its open reasoning/writing cards, or the fresh stream appends
 * onto the dead partials and the step reads as one spliced generation. */
export type StepRetryEvent = Record<string, never>
export interface StepDoneEvent {
  step: number
  seconds: number
  tokensPerSecond?: number
  promptTokens?: number
  completionTokens?: number
  /**
   * Speculative-decoding draft-token acceptance rate for this step, present only when the
   * server ran with a draft model and drafted at least one token this step. Produced by
   * `agent/loop.ts`'s `StepInfo.draftAcceptance` (Plan 4 Task 8) and forwarded verbatim by
   * `host.ts`'s `onStepDone` handler.
   */
  draftAcceptance?: number
  /**
   * How full the window is NOW, by the same arithmetic the compaction gate uses, and
   * `compactAt` is the count at which it will fire.
   *
   * `promptTokens` above is the raw server measurement for the moment the step's request was
   * built, and it is blind to everything appended since — a batched step's tool results
   * above all. The status bar divided that raw number by the window while the gate divided a
   * corrected one, so the bar could read comfortably while compaction was about to happen.
   * These two carry the gate's own numbers so there is one answer to one question.
   */
  contextUsed?: number
  compactAt?: number
}

export interface ThinkingDeltaEvent { text: string }
export interface TextDeltaEvent { text: string }
export interface AssistantTextEvent { text: string }

export interface ToolCallEvent {
  name: string
  /** The raw JSON-arguments string the model produced, unparsed. */
  args: string
}

/**
 * A tool call being written, while it is being written.
 *
 * `tool.call` fires once, when the call is finished and about to run. On a large edit the
 * model spends most of the step producing the argument, and with only the finished event to
 * go on the window had nothing to show for that time — it stopped. This carries the call as
 * it is generated: the name arrives first, then the argument in fragments.
 *
 * `args` is a SLICE of a JSON document and is not valid JSON alone. Concatenate by `index`;
 * a consumer that needs structure waits for `tool.call`.
 */
export interface ToolCallDeltaEvent {
  /** Which call this belongs to. Parallel calls interleave in one stream. */
  index: number
  /** Present on the first fragment of a call, absent on the rest. */
  name?: string
  /** Present on argument fragments, absent on the first. */
  args?: string
}
/**
 * Mirrors `tools/types.ts`'s `ToolResult` intentionally but is redeclared here rather than
 * imported to decouple the wire contract from internal execution-layer types: an internal
 * refactor to tools/types.ts cannot silently change the UI protocol. Must be kept in sync
 * by hand if the tool result shape ever changes.
 */
export interface ToolResultEvent {
  name: string
  ok: boolean
  /** Exactly what the model was given. */
  content: string
  /** The untruncated result for display, when the tool clipped `content` to protect the
   * model's context window. Absent when the two are the same. See `ToolResult.display`. */
  display?: string
}

/**
 * One run of the project's own verify command, pass or fail.
 *
 * Emitted even on a pass: a check that silently added thirty seconds to every writing turn
 * would read as the app hanging, and "it ran and the project is fine" is worth one line.
 */
export interface VerifyEvent {
  command: string
  ok: boolean
  /** 1 for the check itself; 2 means the model's first fix was verified again. */
  attempt: number
  /** Which folder was checked. Present only in a multi-folder workspace, where "which one"
   * is a question a person actually has. */
  folder?: string
  exitCode?: number
  /** The command could not be run at all -- a configuration problem, not a broken project. */
  problem?: string
}

/** `ApprovalRequest` (tool/summary/detail/suggestedRules) plus the id the UI's reply must
 * echo back via `approval.reply`. */
export interface ApprovalRequestEvent extends ApprovalRequest { requestId: string }

/** `UserQuestion` (question/options) plus the id the UI's reply must echo back via
 * `question.reply`. */
export interface QuestionRequestEvent extends UserQuestion { requestId: string }

/** A running tool's live output chunk (run_command's stdout/stderr as it arrives).
 * Display-only: the tool.result that follows carries the complete record. */
export interface ToolOutputEvent { name: string; text: string }

export interface TodosEvent { items: TodoItem[] }

/**
 * Mirrors `session/session.ts`'s `CompactionEvent` intentionally but is redeclared here
 * rather than imported to decouple the wire contract from internal execution-layer types:
 * an internal refactor to session/session.ts cannot silently change the UI protocol. Must be
 * kept in sync by hand if the compaction event shape ever changes.
 */
export type CompactionState = 'started' | 'ready' | 'applied' | 'postponed' | 'failed'
export interface CompactionEvent {
  state: CompactionState
  /** Only ever present on `'applied'`. */
  droppedMessages?: number
  /** Why a `'postponed'` changed nothing, when the two answers differ for the reader:
   * `'nothing-to-gain'` is "this conversation is too short to be worth summarising", not
   * "it tried and could not help". */
  reason?: 'nothing-to-gain'
  /**
   * What the swap did, present only on `'applied'`.
   *
   * A compaction is the most consequential thing that happens to a session — from then on the
   * model works from this briefing rather than from the conversation — and it used to pass as
   * five seconds of status text. This is what the window needs to show it.
   */
  detail?: {
    beforeTokens: number
    afterTokens: number
    /** The briefing the model wrote for itself, verbatim. */
    summary: string
    keptMessages: number
  }
}

/**
 * How far a running generation has got — the answer to "is it stuck?", measured.
 *
 * Prefill and generation are different phases with different speeds, and only one of them
 * streams anything. While the server reads the prompt there is no reasoning, no text and no
 * tool argument, so every other event here is silent; on a long conversation that silence is
 * the longest stretch of a turn. `prompt` is that phase, `generated` is what follows, and a
 * given event carries exactly one of them.
 *
 * `scope` separates the turn's step from the background compaction, because the two overlap
 * on screen and a single number would flicker between two unrelated generations.
 */
export interface GenerationProgressEvent {
  scope: 'step' | 'compaction'
  /** Prefill: prompt tokens processed of the total, and how many the server took from its
   * cache rather than reading. The cache figure is what explains a turn that suddenly got
   * slow — it is invisible in every other reading. */
  prompt?: { processed: number; total: number; cache: number }
  /** Generation: tokens produced so far, and the server's own rate for them. */
  generated?: { tokens: number; perSecond?: number }
}

export interface SettingsProblemEvent { text: string }

/** Same three fields as `send`'s `SendResult.turn`, flattened -- see `TurnSummary`. */
export type TurnDoneEvent = TurnSummary

/**
 * Every event this protocol defines, event name -> data shape. Same rationale as
 * `HostMethodMap`: unused within this module, offered for a typed listener elsewhere.
 */
export interface HostEventMap {
  'step.start': StepStartEvent
  'step.continuation': StepContinuationEvent
  'step.retry': StepRetryEvent
  'step.done': StepDoneEvent
  'generation.progress': GenerationProgressEvent
  'thinking.delta': ThinkingDeltaEvent
  'text.delta': TextDeltaEvent
  'assistant.text': AssistantTextEvent
  'tool.call.delta': ToolCallDeltaEvent
  'tool.call': ToolCallEvent
  'tool.result': ToolResultEvent
  verify: VerifyEvent
  'approval.request': ApprovalRequestEvent
  'question.request': QuestionRequestEvent
  'tool.output': ToolOutputEvent
  todos: TodosEvent
  compaction: CompactionEvent
  'settings.problem': SettingsProblemEvent
  'turn.done': TurnDoneEvent
  'run.turn': RunTurnEvent
  'run.ended': RunEndedEvent
  'decisions.changed': DecisionsChangedEvent
}
export type HostEventName = keyof HostEventMap

// ---------------------------------------------------------------------------------------
// Long runs: checkpoints, the decision queue, the work log, and the unattended runner.
// ---------------------------------------------------------------------------------------

/** One snapshot of the workspace. Mirrors `checkpoints/store.ts`'s own `Checkpoint`,
 * redeclared here for the same reason as `JobInfo`: an internal refactor must not silently
 * change the wire contract. */
export interface CheckpointInfo {
  id: string
  at: string
  turn?: number
  /** Present when the snapshot was taken while the turn was still running. A long turn
   * contributes several checkpoints, and without this they all read as the same turn --
   * several identical rows to choose a rewind from. */
  step?: number
  summary: string
}

/**
 * `limit` is how far back the panel can reach, and it needs to be askable.
 *
 * The store's own default is fifty, which spanned days of work while a turn contributed one
 * checkpoint. A long turn now contributes one every two minutes it writes in, so fifty rows
 * cover a few hours — and the panel had no way to look past them, because there was no
 * parameter to send. Absent keeps the store's default.
 */
export interface CheckpointsListParams { limit?: number }
export interface CheckpointsListResult { checkpoints: CheckpointInfo[] }

export interface CheckpointsRewindParams { id: string }
/** `undo` is the checkpoint that puts things back, so the UI can offer the reverse
 * immediately -- a rewind to the wrong point is the failure this whole feature has to
 * survive. */
export interface CheckpointsRewindResult { restored: CheckpointInfo; undo: CheckpointInfo }

/** A request parked because nobody answered it. `kind` decides which half is populated. */
export interface DecisionInfo {
  kind: 'approval' | 'question'
  id: string
  at: string
  /** approval only */
  tool?: string
  summary?: string
  detail?: string
  suggestedRules?: string[]
  /** question only */
  question?: string
  options?: string[]
  multiSelect?: boolean
}

export interface PromptImproveParams { text: string }
/** What the improver suggests ADDING to the draft — the user's own words are never
 * rewritten. Null when the model declined or suggested nothing: the composer keeps its
 * quiet lint chips, never shows an error. */
export interface PromptImproveResult {
  suggestions: { criteria: string[]; constraints: string[]; questions: string[] } | null
}

export interface PromptExpandParams { text: string }
/** The rough command rewritten as a detailed, project-grounded brief — shown as a
 * PREVIEW; only an explicit accept puts it into the composer. Null when the model
 * declined or returned nothing usable: the composer stays quiet, never shows an error. */
export interface PromptExpandResult { expanded: string | null }

export type DecisionsListParams = Empty
export interface DecisionsListResult { decisions: DecisionInfo[] }

/**
 * Answering a parked request.
 *
 * `rule` is the point of the whole queue: a night's worth of approvals should become a
 * handful of permission rules, not a handful of one-off yesses that are gone by tomorrow.
 * It is applied to the live engine exactly as an in-the-moment "always allow" would be.
 */
export interface DecisionsResolveParams {
  id: string
  verdict?: 'allow' | 'deny'
  rule?: { rule: string; layer: 'session' | 'local' | 'project' | 'user' }
  answer?: string
}
export type DecisionsResolveResult = Empty

/**
 * What the agent is standing permission to do, and where each grant is written down.
 *
 * The window could already GRANT a standing permission — from an approval card's "Allow
 * always" and from the decision queue — and had nowhere to show what had been granted. So
 * the one subject the user most needs to audit, on a tool whose whole premise is that it
 * runs on their own machine, was the one thing the interface never displayed.
 *
 * Three layers, always all three, in precedence order and even when empty: an empty `local`
 * layer is a fact about this workspace ("nothing has been granted just here"), and hiding it
 * would make the same screen mean different things on different days.
 */
export type PermissionsListParams = Empty
export interface PermissionRuleView {
  /** The rule as written, e.g. `run_command(npm test:*)` or `edit_file(src/**)`. */
  rule: string
  list: 'allow' | 'ask' | 'deny'
}
export interface PermissionLayerView {
  scope: 'user' | 'project' | 'local'
  /** The file it lives in, shown so a rule is never a thing that came from nowhere. */
  path: string
  rules: PermissionRuleView[]
}
export interface PermissionsListResult {
  layers: PermissionLayerView[]
  /** The mode's own defaults, described in one line each, because a mode grants far more in
   * practice than any rule does and reading only the rules would understate it badly. */
  mode: AgentMode
  /** Malformed layer files, same text `loadLayers` reports at startup. A screen listing
   * permissions must say when a file it is summarising could not be read. */
  problems: string[]
}

/** Withdraw one rule. `removed: false` means it was not there — a revocation that raced
 * another window, or a hand-edited file — which the caller shows rather than swallowing. */
export interface PermissionsRemoveParams {
  scope: 'user' | 'project' | 'local'
  list: 'allow' | 'ask' | 'deny'
  rule: string
}
export interface PermissionsRemoveResult { removed: boolean }

/**
 * Write one rule, from the permissions screen. The mirror of remove, and it closes the
 * asymmetry the screen shipped with: rules could be granted from an approval card, revoked
 * from the list, and never simply WRITTEN — the one thing "configurable" actually means.
 * A rule that fails validation comes back as `problem` and changes nothing anywhere.
 */
export interface PermissionsAddParams {
  scope: 'user' | 'project' | 'local'
  list: 'allow' | 'ask' | 'deny'
  rule: string
}
export interface PermissionsAddResult { problem: string | null }

/**
 * The skills this workspace offers the model — what loaded, and what failed to.
 *
 * Read fresh from disk on every call rather than reported from the running session: the
 * question this answers is "did the folder I just created get picked up", and answering it
 * from a session built before that folder existed would answer the wrong question. The
 * catalogue the RUNNING session is using is frozen in its message 0, so the screen says
 * which of the two a reader is looking at.
 */
export type SkillsListParams = Empty
export interface SkillView {
  name: string
  scope: 'user' | 'project'
  description: string
  /** Its SKILL.md, shown so the edit is never to a mystery location. */
  path: string
  /** Files bundled beside it, which `use_skill` can be asked for by name. */
  files: string[]
}
export interface SkillsListResult {
  skills: SkillView[]
  problems: string[]
  /** The two folders skills are read from, so an empty list can say where to put one. */
  dirs: { scope: 'user' | 'project'; path: string }[]
}

/**
 * The PROJECT settings file's `mcpServers` object, verbatim, for direct editing.
 *
 * VS Code's shape, at the user's request: the configuration IS a JSON document you edit,
 * not a form that models a subset of it. What comes back is exactly what sits in the file
 * (pretty-printed; `{}` when absent), so nothing an editor cannot represent exists —
 * env blocks, headers, cwd, trust flags are all just text here.
 */
export type McpRawReadParams = Empty
export interface McpRawReadResult {
  /** The `mcpServers` object as JSON text. */
  json: string
  /** The file it lives in, shown so the edit is never to a mystery location. */
  path: string
}

/**
 * Replace the `mcpServers` key with the edited document. Syntax and root-shape are checked
 * BEFORE anything is written — a typo comes back as an error and the file is untouched;
 * every other top-level key of the settings file survives. Deeper validation (does each
 * entry have a command or a url) happens where it always has: at connect, through the same
 * problems pipeline the window already shows. Applying is the caller's second step —
 * re-open the workspace, which reconnects servers and rebuilds the prompt naming them.
 */
export interface McpRawSaveParams { json: string }
export type McpRawSaveResult = Empty

export type WorklogReadParams = Empty
/** `text` is empty when nothing has been logged yet, which is the normal state of a
 * workspace that has never run unattended. */
export interface WorklogReadResult { text: string; path: string }

export interface RunStartParams {
  task: string
  maxTurns?: number
  maxHours?: number
}
export type RunStartResult = Empty
export type RunStopParams = Empty
export type RunStopResult = Empty

/** Emitted before each unattended turn, so the composer can show progress without the app
 * having to count `turn.done` events itself. */
export interface RunTurnEvent { turn: number; text: string }
export interface RunEndedEvent { turns: number; stoppedBecause: string; detail: string }
/** Fired whenever the parked count changes, so the card appears without polling. */
export interface DecisionsChangedEvent { pending: number }



// ---------------------------------------------------------------------------------------
// Framing: ndjson in, ndjson out.
// ---------------------------------------------------------------------------------------

/**
 * Serializes one message to a single ndjson line: compact JSON followed by exactly one
 * `\n`. `JSON.stringify` escapes every control character inside string values (a raw `\n`
 * or `\r` in, say, `finalText` comes out as the two-character escape `\n`/`\r`), so the
 * result can never itself contain an embedded newline -- but the assert below is cheap
 * insurance against that guarantee quietly breaking (e.g. a future pretty-printed fallback
 * path) rather than trust it silently forever.
 */
export function encodeLine(msg: HostOutbound | HostRequest): string {
  const json = JSON.stringify(msg)
  if (/[\r\n]/.test(json)) {
    throw new Error(`encodeLine: JSON.stringify produced an embedded newline, refusing to send: ${json}`)
  }
  return `${json}\n`
}

/**
 * Reassembles ndjson (one JSON value per `\n`-terminated line) out of a stream of text
 * chunks that may split a single line across chunk boundaries, or pack several complete
 * lines into one chunk. `\r\n` endings are tolerated -- the trailing `\r` is stripped
 * before parsing -- so a transport that emits CRLF needs no special-casing by its caller.
 *
 * A blank line (empty once its trailing `\r` is stripped) is skipped rather than treated
 * as malformed: this protocol never emits one, but silently tolerating a stray incidental
 * newline costs nothing and avoids an unnecessary throw on a transport that inserts one
 * (e.g. as a keepalive).
 */
export class LineDecoder {
  private buffer = ''
  /** Maximum bytes a single line can reach before a newline. Caps untrusted-peer growth. */
  private static readonly MAX_LINE_CHARS = 1_000_000

  /**
   * Feeds one chunk of raw text in and returns every JSON value the accumulated buffer now
   * completes, in order -- zero, one, or many. A line that fails to parse as JSON throws
   * immediately, naming the exact line content in the error message; the decoder is not
   * expected to keep working usefully after that (the caller owns tearing down the
   * connection), so no attempt is made to recover the lines already parsed earlier in the
   * same call.
   */
  push(chunk: string): unknown[] {
    this.buffer += chunk
    if (this.buffer.length > LineDecoder.MAX_LINE_CHARS) {
      throw new Error(
        `LineDecoder: line buffer exceeded ${LineDecoder.MAX_LINE_CHARS} chars without a newline (untrusted peer growth bound)`
      )
    }
    const lines = this.buffer.split('\n')
    // The last split element is whatever follows the final '\n' seen so far -- a
    // not-yet-terminated partial line, or '' if the buffer ended exactly on a newline --
    // and must be kept for the next push, never parsed now.
    this.buffer = lines.pop() ?? ''

    const results: unknown[] = []
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line.length === 0) continue
      try {
        results.push(JSON.parse(line))
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        throw new Error(`LineDecoder: malformed JSON line (${reason}): ${line}`)
      }
    }
    return results
  }
}
