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
}

// ---------------------------------------------------------------------------------------
// Methods: one params/result interface per method, named `<Method>Params`/`<Method>Result`.
// ---------------------------------------------------------------------------------------

export interface InitParams {
  workspaceRoot: string
  serverUrl: string
  /** Session id to resume instead of starting fresh. */
  resume?: string
}
export interface InitResult {
  sessionId: string
  mode: AgentMode
  /** The model's context window in tokens, or null when the server never reported one. */
  contextLength: number | null
  problems: string[]
  title: string
}

export interface SendParams { text: string }
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

export interface SessionsResumeParams { id: string }
/** Same shape as `init`'s result -- see `SessionsNewResult`. */
export type SessionsResumeResult = InitResult

export type CompactParams = Empty
export interface CompactResult { applied: boolean }

export interface ApprovalReplyParams { requestId: string; decision: ApprovalDecision }
export type ApprovalReplyResult = Empty

export interface QuestionReplyParams { requestId: string; answer: string }
export type QuestionReplyResult = Empty

export interface FsTreeEntry { name: string; dir: boolean }
/** Jailed to the workspace root, like every other path the sidecar accepts from the UI. */
export interface FsTreeParams { path?: string }
export interface FsTreeResult { entries: FsTreeEntry[] }

/** Jailed to the workspace root; the result is capped at 2000 lines (see `truncated`). */
export interface FsReadParams { path: string }
export interface FsReadResult { lines: string[]; truncated: boolean }

export type StatusParams = Empty
export interface StatusResult { serverUp: boolean; model?: string }

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
  compact: { params: CompactParams; result: CompactResult }
  'approval.reply': { params: ApprovalReplyParams; result: ApprovalReplyResult }
  'question.reply': { params: QuestionReplyParams; result: QuestionReplyResult }
  'fs.tree': { params: FsTreeParams; result: FsTreeResult }
  'fs.read': { params: FsReadParams; result: FsReadResult }
  status: { params: StatusParams; result: StatusResult }
  'jobs.list': { params: JobsListParams; result: JobsListResult }
  'jobs.stop': { params: JobsStopParams; result: JobsStopResult }
  'terminal.run': { params: TerminalRunParams; result: TerminalRunResult }
  'config.get': { params: ConfigGetParams; result: ConfigGetResult }
  'config.set': { params: ConfigSetParams; result: ConfigSetResult }
}
export type HostMethodName = keyof HostMethodMap

// ---------------------------------------------------------------------------------------
// Events: one data interface per event, named `<Event>Event`.
// ---------------------------------------------------------------------------------------

export interface StepStartEvent { step: number; timeoutMs: number }
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

/** `ApprovalRequest` (tool/summary/detail/suggestedRules) plus the id the UI's reply must
 * echo back via `approval.reply`. */
export interface ApprovalRequestEvent extends ApprovalRequest { requestId: string }

/** `UserQuestion` (question/options) plus the id the UI's reply must echo back via
 * `question.reply`. */
export interface QuestionRequestEvent extends UserQuestion { requestId: string }

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
  'step.done': StepDoneEvent
  'thinking.delta': ThinkingDeltaEvent
  'text.delta': TextDeltaEvent
  'assistant.text': AssistantTextEvent
  'tool.call': ToolCallEvent
  'tool.result': ToolResultEvent
  'approval.request': ApprovalRequestEvent
  'question.request': QuestionRequestEvent
  todos: TodosEvent
  compaction: CompactionEvent
  'settings.problem': SettingsProblemEvent
  'turn.done': TurnDoneEvent
}
export type HostEventName = keyof HostEventMap

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
