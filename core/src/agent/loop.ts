import type { InteractionPort } from '../interaction.js'
import { LlamaRequestError, type LlamaClient } from '../llama/client.js'
import type { ChatMessage, ChatResult, StreamProgress, Timings, ToolCall } from '../llama/types.js'
import { BROWSER_TOOL, MCP_TOOL_PREFIX, type AgentMode, type PermissionEngine } from '../permissions/engine.js'
import { suggestRules } from '../permissions/rules.js'
import { Transcript } from '../transcript/transcript.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ApprovalPreview, PermissionKey, Tool, ToolContext, ToolResult } from '../tools/types.js'
import { buildSystemPrompt } from './prompt.js'
import type { LoopDetector } from './loop-detector.js'
import type { HookRunner } from '../hooks/hooks.js'

/**
 * How long a step may go SILENT before it is abandoned.
 *
 * Not a ceiling on the step: a step that is still streaming is still working, and it was
 * measured killing real work when the two were conflated. See `Agent.stepClock`.
 *
 * 90 s, unchanged, because the number was always sized for the thing it now measures: long
 * enough that an ordinary gap between tokens never trips it, short enough that a server which
 * accepts the connection and then goes quiet does not stall the UI until the client's
 * ten-minute transport timeout.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 90_000

/**
 * Prefill cost per token, with margin — the one unavoidable silence.
 *
 * llama.cpp emits nothing at all while it processes the part of the prompt its cache does not
 * already hold, so the gap before a step's FIRST token is not idleness, it is work whose
 * length is known in advance. Measured on this machine during the run that found this:
 * 15,393 new tokens → 36.3 s (2.36 ms/token), 15,409 → 58.8 s (3.82), 11,963 → 25.0 s (2.09).
 * 4 ms carried the slowest of those plus room for a GPU also driving a display.
 *
 * RETUNED 2026-08-22 to **2 ms**, after the served model changed. Prefill is now measured at
 * 726-739 tok/s (`docs/SPIKE-KAT-CODER.md` §2), i.e. ~1.37 ms/token, so 2 ms still carries a
 * ~46% margin over the measurement. This can only ever make a wait SHORTER, and no healthy
 * step is at risk: the whole 196k window at 730 tok/s is 269 s, comfortably inside
 * MAX_COLD_START_MS either way. What it buys is the other end — a server that has actually
 * wedged used to hold the window for the full nine minutes on an allowance sized for a
 * machine three times slower.
 *
 * `Session` measured the same rate independently while warming a compacted session (393
 * tok/s) and had this constant privately; it now imports it, so the two cannot drift.
 */
export const PREFILL_MS_PER_TOKEN = 2

/** Ceiling on any single wait, below the client's ten-minute transport timeout so a server
 * that goes silent is still caught by something. */
export const MAX_COLD_START_MS = 9 * 60_000

/** The same chars/4 rule `Transcript.approxTokens` uses; applied here to the bytes appended
 * since the last request, which is what the server has not already processed. */
function prefillAllowanceMs(newChars: number): number {
  return Math.ceil((newChars / 4) * PREFILL_MS_PER_TOKEN)
}

/**
 * Default token budget for one generation.
 *
 * 8000, because the measurement that matters was taken under exactly the configuration
 * this class ships: `docs/DESIGN.md` §7 records median thinking of **5591 tokens** on a
 * hard edit at `tool_choice: 'auto'`, with one run reaching **6119**. The previous default
 * of 4000 sat below that median, so the median hard edit was guaranteed to truncate — and
 * the branch then carried a whole truncation-continuation path to recover from a failure
 * the default itself had chosen. 8000 clears the measured median and the measured tail,
 * and is the same budget the spike used when taking those numbers.
 *
 * This is not a licence to spiral: 8000 is a ceiling, not a target, and raising it further
 * was measured as buying a longer spiral rather than a better answer (`max_tokens=2000`
 * gave 1/5 completions, `8000` gave 2/5 — the lever is `tool_choice`, not the budget).
 * What the budget buys is that a step which *would* have finished is not cut off.
 */
export const DEFAULT_MAX_TOKENS_PER_STEP = 8_000

/**
 * `StepInfo.draftAcceptance` (Plan 4 Task 8's producer for the field the protocol
 * reserved): `undefined` unless the server reports BOTH `draft_n` and `draft_n_accepted`
 * AND `draft_n > 0` -- a step with no drafting attempted (no draft model configured, or a
 * completion too short to draft against) has nothing to report a rate FOR, and `0/0`
 * would misleadingly read as "0% accepted" rather than "not applicable this step".
 */
function computeDraftAcceptance(timings: Timings | undefined): number | undefined {
  const draftN = timings?.draft_n
  const accepted = timings?.draft_n_accepted
  if (draftN === undefined || accepted === undefined || draftN <= 0) return undefined
  return accepted / draftN
}

export interface StepStartInfo {
  /** 1-based index of this step within the turn. */
  step: number
  /**
   * How long this step may go silent before it is abandoned — NOT a budget for the whole
   * step, which is unbounded as long as tokens keep arriving (see `Agent.stepClock`). Emitted
   * at step *start* so a UI can run a countdown; the countdown restarts from every streamed
   * delta, because that is exactly what the core's own clock does.
   */
  timeoutMs: number
  /**
   * The budget for the wait before this step's FIRST token — `timeoutMs` plus the prefill
   * allowance for everything appended since the last request (`firstTokenBudget`). The clock
   * is armed with THIS number until the first token arrives, so a countdown rendered against
   * the flat `timeoutMs` alone reaches zero and sits there while the step is healthy —
   * watched live: a step prefilling two ~20k-token search results showed "0s to timeout"
   * for half a minute and then completed. Until something streams, count against this.
   */
  firstTokenTimeoutMs: number
}

export interface StepInfo {
  /** 1-based index of this step within the turn; pairs with the StepStartInfo. */
  step: number
  seconds: number
  completionTokens?: number
  /**
   * The server's own count of this step's prompt (input) tokens -- the newest one is the
   * best available estimate of the whole transcript's current size, since it already
   * includes everything the model was actually shown, prior completions included. Used by
   * `Session.contextUsage()`/`fillRatio()` for real (non-heuristic) context accounting.
   */
  promptTokens?: number
  tokensPerSecond?: number
  /**
   * Speculative-decoding draft-token acceptance rate for this step (`timings.
   * draft_n_accepted / timings.draft_n`), present only when the server actually ran with
   * a draft model AND drafted at least one token this step -- `draft_n === 0` (no
   * speculative decoding attempted, e.g. a very short completion) reports no rate at all
   * rather than a misleading `0/0`. Protocol 4's `step.done` event reserved this field
   * ahead of this producer (host.ts's own StepDoneEvent doc comment); this is that
   * producer.
   */
  draftAcceptance?: number
  continued: boolean
}

export interface AgentEvents {
  /** Every step emits exactly one of these, and exactly one matching onStepDone. */
  onStepStart?(info: StepStartInfo): void
  onThinking?(text: string): void
  /**
   * Incremental reasoning text, fired as the server streams it. Only ever fires when
   * either this or `onTextDelta` is present on `events` — that presence is what switches
   * the underlying call from `chat()` to `chatStream()`. `onThinking` above still fires
   * once, with the whole assembled blob, after the step's call(s) finish; a host that
   * wires both gets incremental text during generation and the same final callback it
   * always got.
   */
  onThinkingDelta?(text: string): void
  /** Incremental visible-text equivalent of `onThinkingDelta`; see there for when it fires. */
  onTextDelta?(text: string): void
  /**
   * The step ran out of room mid-thought and a forced continuation is starting *now*.
   * Without this the median hard step is silent across two full generations.
   *
   * `firstTokenTimeoutMs` is the budget the clock is re-armed with for the continuation's
   * own first token — the carried-back reasoning is thousands of tokens the server has not
   * seen, so this silence is prefill again, and a countdown still holding the flat budget
   * called a healthy continuation "out of time". Same reasoning as
   * `StepStartInfo.firstTokenTimeoutMs`, at the other moment a request starts cold.
   */
  onContinuation?(step: number, firstTokenTimeoutMs?: number): void
  /**
   * The server died mid-call, came back healthy, and the SAME request is being re-sent
   * right now. The dead attempt's partial deltas are superseded — the retry re-streams
   * from the start — so a renderer should discard its open reasoning/writing cards
   * rather than let the fresh stream append onto them.
   */
  /** `firstTokenTimeoutMs` is the budget the retry re-armed the clock with — the relaunched
   * server has an empty KV cache, so it is a COLD-prefill allowance, not the flat step
   * budget. Carried for the same reason `onContinuation` carries it: the window runs its own
   * countdown, and without the new number it kept the old one and sat at "0s to timeout" for
   * minutes of a perfectly healthy prefill. Optional argument, so a listener that ignores it
   * behaves exactly as before. */
  onStepRetry?(firstTokenTimeoutMs: number): void
  /** A running tool's live output (run_command's stdout/stderr as it arrives). Chunks,
   * not lines; display-only — the tool result stays the authoritative record. */
  onToolOutput?(name: string, text: string): void
  /**
   * A tool call being WRITTEN, fired as the server streams its arguments.
   *
   * `onToolCall` below fires once, when the call is complete and about to run. That is too
   * late to be the only signal: on a large edit the model spends most of the step generating
   * the argument, and until this existed there was nothing to show for that time -- no path,
   * no progress, an interface that simply stopped. `args` is a FRAGMENT of a JSON document,
   * not valid JSON on its own; concatenate by `index` and parse only what `onToolCall`
   * hands over.
   *
   * Fires under the same condition as the other delta callbacks: streaming is only switched
   * on when a host wires one of them.
   */
  onToolCallDelta?(info: { index: number; name?: string; args?: string }): void
  /**
   * How far the current step's request has got — prefill, then generation.
   *
   * The state this exists for is the one with nothing to stream: while the server reads the
   * prompt, no reasoning, no text and no tool argument is produced, so every other callback
   * here is silent, and the window's only honest options were "working" or an inference
   * drawn from the SHAPE of the transcript. This is the measurement instead. Fires under the
   * same opt-in rule as the other delta callbacks, and is throttled in the client.
   */
  onProgress?(progress: StreamProgress): void
  onToolCall?(name: string, args: string): void
  /** `callId` is the model's own id for this call. Passed because the host records how each
   * call ended in a file beside the session -- the transcript keeps the result TEXT, which
   * is all the model needs, and loses whether it worked, which is all the window needs. */
  onToolResult?(name: string, result: ToolResult, callId: string): void
  onAssistantText?(text: string): void
  /** Emitted once the model call(s) of the step are over, before the tool runs. */
  onStepDone?(info: StepInfo): void
}

export interface AgentOptions {
  client: LlamaClient
  registry: ToolRegistry
  context: ToolContext
  /** The assembled AGENTS.md block, if the caller loaded one. Read once, here, and never
   * re-read: it lands in the system message, which is message 0 of an append-only
   * transcript. */
  memory?: string
  /** The project map for the system prompt; see `outline/repo-map.ts`. */
  repoMap?: string
  /** The database's shape, for the cached prefix. See `PromptOptions.databaseSchema`. */
  databaseSchema?: string
  /** What earlier sessions learned; see `memory/project-notes.ts`. Frozen into message 0
   * like the rest — a note recorded mid-session lands in the NEXT one. */
  notes?: string
  /** The skills catalogue for the system prompt; see `skills/skills.ts`. Frozen into
   * message 0 like `memory`, and for the same reason — which is why a skill's DESCRIPTION
   * needs a new session while its body does not. */
  skills?: string
  /** User-configured after-tool hooks. Absent means none, the normal case. */
  hooks?: HookRunner
  /**
   * Refuses a call that has already returned the same answer twice.
   *
   * Owned by the `Session`, not created here: the loop that matters spans turns, and an
   * Agent lives for one. Absent means the check does not run at all, which is what every
   * caller that predates it gets.
   */
  loopDetector?: LoopDetector
  /**
   * Tool names the model may use this turn. Omit for all of them.
   *
   * This filters the schemas offered, which is the primary defence — llama.cpp builds its
   * constraint grammar from exactly that list. The loop also refuses a call to anything
   * outside the list before executing it, because plan mode is a user-facing safety
   * guarantee and must not rest solely on a remote server's grammar.
   *
   * In `mode: 'plan'` this is a ceiling, not a grant: the constructor always narrows it
   * (or, if omitted, sets it) to the registry's `readOnlyNames()`. There is no way to
   * pass a mutating tool through in plan mode by naming it here.
   */
  allowedTools?: string[]
  mode?: AgentMode
  /**
   * The permission gate `runTool` consults before a tool executes. Omitting this option
   * entirely reproduces today's behavior exactly — every tool runs unconsulted, gate code
   * included — so an existing caller that never heard of permissions is unaffected.
   */
  permissions?: PermissionEngine
  /**
   * Consulted immediately before a tool runs. A returned string REPLACES the call's result
   * and the tool never executes; `undefined` lets it through.
   *
   * Separate from `permissions` although both gate a call, because they answer different
   * questions and confusing them would be a security smell: permissions decide whether an
   * action is ALLOWED, and this decides whether the turn is ready for it. Its one use is the
   * understanding check — the last quiet moment before exploration turns into code — and
   * turning the first write into a result that carries the user's answers is the only place
   * those answers can reach the model without appending to a transcript mid-step, which
   * would leave an assistant tool-call message separated from its replies.
   */
  onBeforeTool?(name: string, args: string): Promise<string | undefined>
  /**
   * How an `ask` verdict is put to the user. Required for `permissions` to ever produce
   * anything other than a flat refusal: with an engine but no port, an `ask` verdict
   * cannot be shown to anyone, so the call is refused with a message telling the model to
   * suggest it to the user instead of retrying.
   */
  interaction?: InteractionPort
  /**
   * A ceiling on the CHARACTERS one step's executed tool results may append, in total.
   * Absent means unbounded, which is what every caller that predates it gets.
   *
   * It exists because a batched step is atomic: one assistant message and its N tool
   * replies cannot be split by the compaction tail selector without invalidating the
   * transcript. So a step whose results exceed the context window can neither be kept nor
   * summarised away — the server refuses the next request and no amount of after-the-fact
   * compaction helps. Watched at the real 131,072 window: twelve batched reads, ~198k
   * tokens appended by one step, HTTP 400. The Session sets this from the window size;
   * the loop only enforces it, because the loop does not know the window.
   */
  stepResultBudgetChars?: number
  /**
   * A ceiling on the steps ONE turn may take. Unbounded by default.
   *
   * It used to default to 40, which is about ten minutes of work, and a turn that reached it
   * stopped mid-task and said so. That is the wrong shape of guard for a tool meant to run
   * for days: counting steps does not distinguish an agent that is stuck from one that is
   * simply doing something large, and the only thing it reliably caught was the second kind.
   *
   * What remains in its place is not nothing. A repeated action is caught by `loopDetector`,
   * which sees what a counter cannot; the user's abort ends a turn at any depth; and a turn
   * whose context fills now compacts and carries on rather than dying (see `beforeStep`).
   * Those bound the failure this limit was aimed at, and they do it without also bounding
   * the work.
   *
   * Still honoured when a caller sets it -- the CLI's `--steps` is a deliberate ceiling for
   * a one-shot run, and `stoppedBecause: 'max_steps'` is still how reaching one is reported.
   */
  maxSteps?: number
  /**
   * Runs between steps, and may hand the turn a new transcript to continue on.
   *
   * This exists so a turn can outlive its own context window. Compaction replaces the
   * transcript OBJECT (the append-only law holds per-object), so before this hook the only
   * safe moment to compact was between turns, while no `Agent` held a reference -- which
   * meant a long turn had no way to make room and eventually met the server's refusal.
   *
   * Returning a `StepPreamble` tells this loop the transcript underneath it has changed; it
   * adopts the new one for every later step. Returning nothing means carry on unchanged,
   * which is the common case and costs a comparison.
   */
  beforeStep?: (step: number) => Promise<StepPreamble | undefined>
  /**
   * Token budget for one generation. Defaults to DEFAULT_MAX_TOKENS_PER_STEP.
   *
   * Generous by design: thinking needs room. Truncation is handled, not avoided — but a
   * default that guarantees truncation on the median hard edit is not "handled", it is
   * chosen. See DEFAULT_MAX_TOKENS_PER_STEP.
   */
  maxTokensPerStep?: number
  /**
   * Wall-clock ceiling for one step, covering the model call and its continuation.
   * Defaults to DEFAULT_STEP_TIMEOUT_MS. Exceeding it ends the turn with
   * `stoppedBecause: 'timeout'` rather than surfacing a transport error.
   */
  stepTimeoutMs?: number
  /**
   * How often an expired first-token window re-checks `/slots` before giving up, while the
   * server reports prefill progress. Tests shrink it; everything else keeps the default.
   */
  prefillRecheckMs?: number
  /**
   * Sampling override for every request of this agent's turns. The one intended caller is
   * the session's escalated retry, which raises temperature after two same-approach
   * failures; `assertSafeSampling` still guards the floor, and everything else keeps the
   * frozen profile by leaving this absent.
   */
  sampling?: import('../llama/types.js').Sampling
  /**
   * A separate, larger deadline for the FIRST step only.
   *
   * `stepTimeoutMs` is sized for generation against a WARM prompt cache — "roughly two
   * generations plus headroom". The first step of a turn whose prompt prefix just changed is
   * not that: llama.cpp matches its cache by longest common prefix, so a compaction swap or
   * a session resumed in a fresh process makes the server re-prefill the entire prompt
   * before it emits a single token. Measured in this repo (Transcript's own benchmark):
   * 27.7 s to re-prefill a ~14.9k-token history. At a hundred thousand tokens the ordinary
   * 90 s budget is spent before generation begins.
   *
   * Reported from the running app: a session was compacted successfully and the very next
   * step died with "a step took longer than its time limit".
   */
  firstStepTimeoutMs?: number
  /**
   * `tool_choice` for the first call of each step. Defaults to `'auto'`.
   *
   * Measured on a hard edit at max_tokens=8000 (docs/DESIGN.md §7): `'auto'` completes
   * 2/5 with 5591 median thinking tokens, `'required'` completes 4/5 with 1262 — denying
   * the model the option of merely talking is the single strongest lever there is. It is
   * not the default because a turn must be able to end with prose: a step that is always
   * forced to call a tool can never terminate, so `'required'` belongs to a caller who
   * knows this turn must end in an action. The truncation continuation always uses
   * `'required'` regardless, since by then talking has already failed.
   *
   * Known gap, deliberately left open here: the strongest measured lever is applied only
   * as a per-*turn* setting, so a turn that is mostly actions and ends in one summary step
   * cannot have `'required'` on the action steps and `'auto'` on the last one. Choosing
   * per step — required while work remains, auto once it does not — needs a signal this
   * loop does not have yet, and belongs to a later plan. Until then the default stays
   * `'auto'` and DEFAULT_MAX_TOKENS_PER_STEP carries the cost.
   */
  toolChoice?: 'auto' | 'required'
  transcript?: Transcript
  events?: AgentEvents
  signal?: AbortSignal
}

/** What `beforeStep` changed about the turn it ran inside. */
export interface StepPreamble {
  /** The transcript the rest of the turn continues on. */
  transcript: Transcript
  /**
   * How long the NEXT step alone may take, when the change made the server's prompt cache
   * cold. llama.cpp matches its cache by longest common prefix, so replacing the transcript
   * means the whole prompt is prefilled again before a token is generated -- the ordinary
   * per-step budget is sized for a warm cache and is spent before generation begins. This is
   * `firstStepTimeoutMs`'s reasoning, applied to the other moment the cache goes cold.
   */
  timeoutMs?: number
}

export interface TurnResult {
  steps: number
  /**
   * The model's own closing prose when there is any — including prose that accompanied a
   * tool call — otherwise a one-line statement of why the turn stopped.
   */
  finalText: string
  stoppedBecause: 'done' | 'max_steps' | 'aborted' | 'timeout' | 'truncated'
  /**
   * Set to false by `Session.send()` alone, on the one abort path where the user message
   * never reached the transcript (signal already aborted before runTurn appended it —
   * e.g. Esc during contract distillation). The loop never sets it: any turn that ran a
   * step was delivered. A front end seeing false must roll its optimistic message row
   * back, or the next "continue" continues from a message the model never saw.
   */
  delivered?: false
}

/** What one step produced, once its model call(s) are over. */
type StepOutcome =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'truncated' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

type ChatOutcome =
  | { kind: 'ok'; result: ChatResult }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

const CONTINUE_NUDGE =
  'You ran out of room while thinking. Stop deliberating and take the next action now, ' +
  'using one tool call.'

/** How much of a looping ramble to keep: enough to show where it was heading, far too little
 * to prime the next step with. */
const LOOP_KEEP_CHARS = 1_500

/** Sentences below this length are punctuation and filler, not evidence of a loop. */
const LOOP_MIN_SENTENCE = 25
/** Repetition below this share is ordinary writing — restating a constraint, numbering
 * steps. Above it, the text is mostly the same thing said again. */
const LOOP_REPEAT_SHARE = 0.5
/** Short thinking cannot be a runaway, whatever its shape. */
const LOOP_MIN_CHARS = 2_000

/**
 * Whether a stretch of thinking is the same thing over and over.
 *
 * Deliberately crude and deliberately conservative: it decides whether to DROP text, so a
 * false positive costs the model context it might have used. Sentences are compared whole
 * after normalising whitespace and case — a spiral repeats them verbatim, which is what makes
 * it visible to the eye and to this.
 */
export function looksRepetitive(text: string): boolean {
  if (text.length < LOOP_MIN_CHARS) return false
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((s) => s.length >= LOOP_MIN_SENTENCE)
  if (sentences.length < 6) return false
  const distinct = new Set(sentences).size
  return 1 - distinct / sentences.length >= LOOP_REPEAT_SHARE
}

const TRUNCATED_TWICE =
  'You ran out of room while thinking twice in a row, so that step was abandoned and ' +
  'nothing was done. Do not restate your plan: choose the smallest possible next action ' +
  'and call one tool immediately.'

/**
 * Which external surfaces this turn can actually reach, for the system prompt.
 *
 * Derived from the registry AND the turn's allowed list, because plan mode narrows the
 * list without changing the registry: telling a plan-mode session how to use a browser it
 * cannot call would be a permanent instruction to do something impossible, in message 0 of
 * a transcript that is never rewritten.
 */
function describeExternalTools(
  registry: ToolRegistry, allowed: string[] | undefined,
): { browser: boolean; mcpServers: string[] } {
  const names = registry.names().filter((n) => allowed === undefined || allowed.includes(n))
  const servers = new Set<string>()
  for (const name of names) {
    if (!name.startsWith(MCP_TOOL_PREFIX)) continue
    const rest = name.slice(MCP_TOOL_PREFIX.length)
    const cut = rest.indexOf('__')
    if (cut > 0) servers.add(rest.slice(0, cut))
  }
  return { browser: names.includes(BROWSER_TOOL), mcpServers: [...servers].sort() }
}

/** How long a dead request waits for the watchdog's relaunch before giving up: model
 * reload measured at ~19-30 s, plus the launcher's own restart delay and margin. */
const SERVER_RESTART_WAIT_MS = 90_000

/** Between /slots checks once a first-token window has expired but the server reports
 * prefill progress. Short enough that a prefill which STALLS still dies quickly; long
 * enough that a legitimate multi-minute re-prefill costs a handful of probes. */
const PREFILL_RECHECK_MS = 20_000

/**
 * What a per-turn decline is counted against — the tool plus the thing it wanted to act on.
 *
 * `PermissionKey` carries that thing in a different field per tool family: `target` for
 * browser/web/database/use_skill, `command` for run_command/background_task, `paths` for the
 * file tools. Counting on `target` alone therefore collapsed to `run_command:` or
 * `edit_file:` for exactly the tools that produce most approvals, and declining
 * `npm install -g x` and then, ten steps later, an unrelated `git clean -fdx` reached two
 * "for the same target" — handing the model the escalation that tells it to abandon the
 * work, derived from two decisions about entirely different commands.
 *
 * Normalized the way the rule language normalizes the same fields (permissions/rules.ts):
 * a command loses its whitespace runs and case, a path its backslashes and case. On Windows
 * `src\App.ts` and `src/app.ts` are one file, so two declines for it are two declines for
 * the same thing, whichever way the model spelled it.
 *
 * A key with none of the three — `remember`, `git_status`, `browser` close — still collapses
 * to `tool:`, which is what those tools mean: every call of them asks the same question.
 */
function denialIdentity(key: PermissionKey): string {
  const acted = [
    ...(key.target !== undefined ? [key.target.trim().toLowerCase()] : []),
    ...(key.command !== undefined ? [key.command.trim().replace(/\s+/g, ' ').toLowerCase()] : []),
    ...(key.paths ?? []).map((p) => p.replace(/\\/g, '/').toLowerCase()),
  ]
  // Newline as the separator: the normalization above has already collapsed every
  // whitespace run in a command to a single space, and neither a path nor a URL carries
  // one, so no two different keys can join into the same string.
  return `${key.tool}:${acted.join('\n')}`
}

export class Agent {
  /** Declines per `denialIdentity` within this agent's one turn (a fresh Agent is built per
   * send), backing the second-decline escalation in the deny branch below. */
  private readonly denialsThisTurn = new Map<string, number>()
  private readonly opts: Required<
    Pick<AgentOptions, 'maxSteps' | 'maxTokensPerStep' | 'mode' | 'stepTimeoutMs' | 'toolChoice'>
  > & AgentOptions
  /** Not `readonly`: `beforeStep` may replace it mid-turn when the conversation is compacted
   * to make room. Reassigned in exactly one place, `runTurn`. */
  transcript: Transcript
  /** Transcript size, in characters, as of the last request sent. The difference against the
   * current size is what the server has NOT already prefilled — see `firstTokenBudget`. */
  private charsAtLastRequest = 0

  constructor(opts: AgentOptions) {
    // The option is the single source of truth for the mode when given; otherwise the
    // engine's own `mode` (a caller that already configured the engine itself) is trusted
    // instead of silently overriding it to 'normal'. A reviewer demonstrated the desync
    // this prevents: `new Agent({ permissions: engineInPlanMode })` with no `mode` option
    // used to yield agent-mode 'normal' (no plan narrowing at all) while the engine's own
    // `modeDefault` still answered 'plan mode' for every `ask` tier — the full tool list
    // AND auto-allow, strictly worse than normal mode's ask-before-write.
    const mode = opts.mode ?? opts.permissions?.mode ?? 'normal'
    // Defaults must come AFTER the spread: an explicitly-undefined property would
    // otherwise overwrite them.
    this.opts = {
      ...opts,
      maxSteps: opts.maxSteps ?? Infinity,
      maxTokensPerStep: opts.maxTokensPerStep ?? DEFAULT_MAX_TOKENS_PER_STEP,
      mode,
      stepTimeoutMs: opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      toolChoice: opts.toolChoice ?? 'auto',
    }
    // Plan mode's "no editing tools are available to you at all" (prompt.ts) is a promise
    // to the user, not a hint to the model, and it must not depend on every call site
    // remembering to pass allowedTools. So it is not the caller's to get right: whatever
    // was passed is narrowed to the registry's own readOnly declarations, and when
    // nothing was passed the readOnly set becomes the whole list. A caller cannot widen
    // plan mode past what the registry itself calls safe, and forgetting allowedTools
    // entirely (the defect a reviewer found) is no longer able to open anything.
    if (mode === 'plan') {
      const readOnly = opts.registry.readOnlyNames()
      this.opts.allowedTools = opts.allowedTools
        ? opts.allowedTools.filter((n) => readOnly.includes(n))
        : readOnly
    }
    // The engine's own `mode` field is what `decide()` actually reads. Now that `mode`
    // above already resolved the single source of truth (the option if given, else the
    // engine's own), write it back whenever an engine is present so both sides always
    // agree — this also covers the case the option WAS given (e.g. `mode: 'autopilot'`
    // with an engine constructed as 'normal'), which the old `opts.mode`-only guard synced
    // one way but never the other.
    if (opts.permissions) {
      opts.permissions.mode = mode
    }
    this.transcript = opts.transcript ?? new Transcript()
    if (this.transcript.messages().length === 0) {
      this.transcript.append({
        role: 'system',
        content: buildSystemPrompt({
          workspaceRoot: opts.context.workspace.root,
          mode: this.opts.mode,
          // Read from the registry rather than passed in by the caller: the prompt must
          // describe the tools that exist, and the registry is the only thing that knows.
          external: describeExternalTools(opts.registry, this.opts.allowedTools),
          // Conditional spread, not `memory: opts.memory`: tsconfig sets
          // exactOptionalPropertyTypes, so an explicit undefined is not the same as absent.
          ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
          ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
          ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
          ...(opts.repoMap !== undefined ? { repoMap: opts.repoMap } : {}),
          ...(opts.databaseSchema !== undefined ? { databaseSchema: opts.databaseSchema } : {}),
          ...(opts.context.workspace.multi
            ? {
              folders: opts.context.workspace.mounts.map((m) => ({ name: m.name, access: m.access })),
            }
            : {}),
        }),
      })
    }
  }

  async runTurn(userText: string): Promise<TurnResult> {
    // Checked before the append: an already-cancelled turn must not leave a user message
    // stranded in an append-only transcript that nothing will ever answer.
    if (this.opts.signal?.aborted) {
      return { steps: 0, finalText: '', stoppedBecause: 'aborted' }
    }
    this.transcript.append({ role: 'user', content: userText })
    const schemas = this.opts.registry.schemas(this.opts.allowedTools)
    let lastText = ''

    // Carries a cold-cache budget across exactly ONE step boundary: the step that follows a
    // transcript swap pays for a full re-prefill, and the one after that is warm again.
    let coldTimeoutMs: number | undefined

    for (let step = 1; step <= this.opts.maxSteps; step++) {
      if (this.opts.signal?.aborted) {
        return { steps: step - 1, finalText: lastText, stoppedBecause: 'aborted' }
      }

      if (this.opts.beforeStep) {
        const preamble = await this.opts.beforeStep(step)
        if (preamble) {
          this.transcript = preamble.transcript
          coldTimeoutMs = preamble.timeoutMs
          // A different object: nothing in it has been prefilled, whatever its length, and
          // a shorter replacement would otherwise read as zero new characters.
          this.charsAtLastRequest = 0
        }
      }

      const outcome = await this.runStep(step, schemas, coldTimeoutMs)
      coldTimeoutMs = undefined

      if (outcome.kind === 'aborted') {
        return { steps: step - 1, finalText: lastText, stoppedBecause: 'aborted' }
      }
      if (outcome.kind === 'timeout') {
        const seconds = this.opts.stepTimeoutMs >= 1000
          ? `${Math.round(this.opts.stepTimeoutMs / 1000)} s`
          : `${this.opts.stepTimeoutMs} ms`
        this.transcript.append({
          role: 'user',
          content: `The previous step hit its ${seconds} time limit before you replied, ` +
                   'so it was abandoned and nothing was done. Take one small action next.',
        })
        return {
          steps: step,
          finalText: lastText ||
            `Stopped: step ${step} passed its ${seconds} time limit with no reply.`,
          stoppedBecause: 'timeout',
        }
      }
      if (outcome.kind === 'truncated') {
        // The forced continuation truncated as well: two generations, no action taken.
        // Reported as a failure, never as a finished turn with empty text.
        this.transcript.append({ role: 'user', content: TRUNCATED_TWICE })
        return {
          steps: step,
          finalText: lastText ||
            'Stopped: the model ran out of room to think twice in a row and took no action.',
          stoppedBecause: 'truncated',
        }
      }

      const message = outcome.message
      const text = message.content ?? ''
      // Prose that rides along with a tool call is still the model talking to the user.
      if (text !== '') {
        lastText = text
        this.opts.events?.onAssistantText?.(text)
      }

      const calls = message.tool_calls ?? []
      if (calls.length === 0) {
        this.transcript.append(this.assistantMessage(message))
        return {
          steps: step,
          finalText: lastText || 'The model ended the turn without producing an answer.',
          stoppedBecause: 'done',
        }
      }

      this.transcript.append(this.assistantMessage(message))

      // Every call the model proposed, run in order, each through the same gate.
      //
      // This used to run `calls[0]` and refuse the rest with "one tool call per step". The
      // model was never told that rule — nothing in prompt.ts said it — and it proposed
      // several often enough to matter. Measured on a 13-step turn against the live model:
      // 3 steps proposed more than one call, the discarded arguments cost 8% of the turn's
      // generated tokens, and 3 of the 13 steps existed ONLY to redo a call that had been
      // thrown away — about 23% of the wall clock. Telling the model to emit one call would
      // have saved the 8% and none of the 23%, because it would still need a step per edit.
      //
      // Strictly sequential, never concurrent, and stopping at the first failure. The reason
      // one action per step was ever right is that the model should see a result before the
      // next action lands; three edits to three different files are generated from the same
      // information and need no such ordering, but a call that FAILED changes what the calls
      // after it should be. So the remainder are answered, not run — which also keeps the
      // property this loop cannot give up: an assistant turn carrying an unanswered
      // tool_call is invalid on a strict OpenAI endpoint and would poison every later
      // request of the session.
      //
      // Sequential also keeps `Session.lastToolArgs` exact: it pairs a call's arguments with
      // its result through a single slot per tool NAME, which holds for as long as no second
      // call of the same name is announced before the first one's result.
      let halted: string | undefined
      // What this step's executed calls have appended so far, in characters. The budget is
      // the third halt condition, same shape as failure and abort: crossing it answers the
      // remaining calls instead of executing them.
      let resultChars = 0
      for (const call of calls) {
        // Re-read every iteration, not once: Esc lands wherever it lands, and a step running
        // four calls is four times the window it can land in. The remaining calls are still
        // answered — `runTurn` returns 'aborted' at the top of the next step, and it must not
        // leave the transcript it returns invalid on the way out.
        if (halted === undefined && this.opts.signal?.aborted) {
          halted = 'the turn was cancelled partway through this step'
        }
        // Checked BEFORE each call, so the call that crosses the budget still lands — a
        // result's size cannot be known before executing it — and only what follows is
        // refused. Found at the real 131k window, not by reading: the model batched twelve
        // reads into one step, the loop ran them all, and ~198k tokens of results landed in
        // the transcript in one go. Compaction could not save it afterwards, because a
        // batched step is ATOMIC to the tail selector — one assistant message whose twelve
        // tool replies cannot be split from it without invalidating the transcript — so a
        // step bigger than the window can neither be kept nor summarised away. The only
        // place this can be prevented is here, before the block exists.
        const budget = this.opts.stepResultBudgetChars
        if (halted === undefined && budget !== undefined && resultChars > budget) {
          halted = 'this step\'s results already filled the room a single step may take'
        }
        if (halted !== undefined) {
          // `Not run:`, which is this codebase's existing contract for a call STOPPED BEFORE
          // IT EXECUTED — the same prefix a permission denial, a deferral and a loop-detector
          // refusal use. It said `Not executed:` once, and the difference was not cosmetic:
          // `commandsFrom` decides whether a command ran by testing exactly `/^Not run[:.]/`,
          // so a skipped `run_command` was written into the work log under "**Ran:** `npm
          // test` → failed". Someone reading the night's log would conclude the suite was run
          // and is broken, when it never executed.
          const content = `Not run: ${halted}, so the calls after it were left alone. ` +
                          'Re-issue this one on a later step if it is still needed.'
          // Announced, not only recorded. A skipped call is already in the transcript, so a
          // resumed session shows it — `replayEntries` reads the `Not run:` prefix as a
          // failure — but nothing told a WATCHING window, and once arguments streamed there
          // was a card open for it. Every unanswered call left a row pulsing forever: seen in
          // a live run as `-> find_files -> find_files -> find_files` against one `(ok)`.
          this.opts.events?.onToolCall?.(call.function.name, call.function.arguments)
          this.answer(call, { ok: false, content })
          continue
        }
        this.opts.events?.onToolCall?.(call.function.name, call.function.arguments)
        // Before the call, not after: whatever this returns is meant to reach the model
        // INSTEAD of what the tool would have done.
        //
        // Guarded like the permission gate's own host boundary (see `runTool`), and for the
        // identical reason. This sits BETWEEN the assistant message being appended and the
        // `role: 'tool'` reply that answers it: a throw here escapes `runTurn` with the call
        // unanswered, `Session.send` rethrows it, `Host.send`'s try/finally never emits
        // `turn.done`, and `persistIfPossible` writes the orphan to disk — so it survives
        // resume, and `compaction.ts` deliberately leaves an unanswered call "exactly as
        // unanswered as it was". That is the one state this loop's own comment calls
        // poisonous to every later request of the session, reached by a `writeFileSync` in
        // `saveMeta` losing a race with OneDrive, an AV hold or a full disk.
        let instead: string | undefined
        try {
          instead = await this.opts.onBeforeTool?.(call.function.name, call.function.arguments)
        } catch (e) {
          instead = 'Not run: the pre-write check could not complete ' +
            `(${e instanceof Error ? e.message : String(e)}). Nothing was written. ` +
            'Re-issue this call on a later step if it is still needed.'
        }
        if (instead !== undefined) {
          this.answer(call, { ok: false, content: instead })
          resultChars += instead.length
          // And the REST of the step stops with it. A step may batch several calls, and the
          // gate's message ends "Nothing was written" — true of the call it landed on and a
          // lie about the three edits queued behind it, which would have run anyway while the
          // model was being told to go and re-read the code first. Halting is the existing
          // contract for a call stopped before it executed, and it answers the remaining
          // calls rather than dropping them, so the transcript stays valid.
          halted = 'the turn was interrupted to check something before writing'
          continue
        }
        const result = await this.runTool(call.function.name, call.function.arguments)
        this.answer(call, result)
        resultChars += result.content.length
        if (!result.ok) halted = `${call.function.name} failed earlier in this step`
      }
    }

    this.transcript.append({
      role: 'user',
      content: `The turn was stopped after ${this.opts.maxSteps} steps without finishing. ` +
               'Nothing further was run. Say what you did and what is left.',
    })
    return {
      steps: this.opts.maxSteps,
      finalText: lastText ||
        `Stopped: the ${this.opts.maxSteps}-step limit was reached before the task finished.`,
      stoppedBecause: 'max_steps',
    }
  }

  /**
   * Answers one proposed call: the transcript message first, then the event.
   *
   * The order matters in exactly one direction. `onToolResult` reaches a host — today an
   * in-process callback, tomorrow IPC — and the transcript message is what keeps the
   * assistant turn valid, so appending first means a throw out of a host handler cannot
   * leave a `tool_call` unanswered. That is the one state that poisons every later request
   * of the session, and it is not worth risking to save a line.
   */
  private answer(call: ToolCall, result: ToolResult): void {
    this.transcript.append({
      role: 'tool',
      tool_call_id: call.id,
      name: call.function.name,
      content: result.content,
    })
    this.opts.events?.onToolResult?.(call.function.name, result, call.id)
  }

  /**
   * One step: one model call, plus the forced continuation if it truncated.
   *
   * finish_reason "length" means the model was still thinking when the budget ran out.
   * The partial turn goes into the transcript before the nudge, so the reasoning really
   * is carried (and really is served from the prefix cache) instead of being thrown away
   * for the model to re-derive from zero; the continuation then forces an action, which
   * is what actually breaks a spiral.
   *
   * A continuation that truncates *again* has done nothing at all. That is not a rare
   * tail — median thinking on a hard edit is 5591 tokens against a 4000-token budget —
   * so it is reported as its own failure rather than falling through as a completed turn
   * with no tool calls, which the caller cannot tell apart from "I'm finished".
   *
   * The step counts as one step either way, and emits exactly one onStepStart and one
   * onStepDone. The deadline covers the model calls; tools carry their own timeouts.
   */
  private async runStep(
    step: number,
    schemas: ReturnType<ToolRegistry['schemas']>,
    coldTimeoutMs?: number,
  ): Promise<StepOutcome> {
    const started = performance.now()
    // Two moments face a cold cache, not one. The first step of a turn is the obvious one:
    // the prefix may be a session just resumed, or one a compaction rewrote between turns.
    // The other is a step that follows a compaction WITHIN this turn -- `beforeStep` reports
    // it by handing over a budget, because the loop cannot see the server's cache itself.
    // Every other step appends to a prefix the server has just processed.
    const timeoutMs = coldTimeoutMs
      ?? (step === 1 ? this.opts.firstStepTimeoutMs ?? this.opts.stepTimeoutMs : this.opts.stepTimeoutMs)
    // Computed once and used for BOTH the event and the clock: `firstTokenBudget` advances
    // `charsAtLastRequest`, so a second call would see zero fresh characters and hand the
    // clock a smaller budget than the one just announced.
    const firstTokenTimeoutMs = this.firstTokenBudget(timeoutMs)
    const clock = this.stepClock(this.opts.stepTimeoutMs)
    this.opts.events?.onStepStart?.({ step, timeoutMs, firstTokenTimeoutMs })

    let continued = false
    let last: ChatResult | undefined
    try {
      // `timeoutMs` is the floor for this step's FIRST request: the caller's cold-cache
      // budget when it knows the prefix changed under it, otherwise the flat budget.
      clock.beforeRequest(firstTokenTimeoutMs)
      const first = await this.chat(schemas, this.opts.toolChoice, clock)
      if (first.kind !== 'ok') return first
      last = first.result
      this.report(first.result.message)

      if (first.result.finishReason !== 'length') {
        return { kind: 'message', message: first.result.message }
      }

      continued = true
      this.appendTruncated(first.result.message)
      this.transcript.append({ role: 'user', content: CONTINUE_NUDGE })
      // The continuation carries the abandoned reasoning back into the prompt, which can be
      // thousands of tokens the server has not seen. Same allowance, no cold floor — and
      // computed once, for the event and the clock, for `firstTokenBudget`'s usual reason.
      const continuationBudgetMs = this.firstTokenBudget(this.opts.stepTimeoutMs)
      this.opts.events?.onContinuation?.(step, continuationBudgetMs)
      clock.beforeRequest(continuationBudgetMs)
      const again = await this.chat(schemas, 'required', clock)
      if (again.kind !== 'ok') return again
      last = again.result
      this.report(again.result.message)
      if (again.result.finishReason === 'length') return { kind: 'truncated' }
      return { kind: 'message', message: again.result.message }
    } finally {
      clock.stop()
      const draftAcceptance = computeDraftAcceptance(last?.timings)
      this.opts.events?.onStepDone?.({
        step,
        seconds: (performance.now() - started) / 1000,
        ...(last?.usage?.completion_tokens !== undefined
          ? { completionTokens: last.usage.completion_tokens } : {}),
        ...(last?.usage?.prompt_tokens !== undefined
          ? { promptTokens: last.usage.prompt_tokens } : {}),
        ...(last?.timings?.predicted_per_second !== undefined
          ? { tokensPerSecond: last.timings.predicted_per_second } : {}),
        ...(draftAcceptance !== undefined ? { draftAcceptance } : {}),
        continued,
      })
    }
  }

  /**
   * The step's deadline, which measures SILENCE rather than elapsed time.
   *
   * This is what `DEFAULT_STEP_TIMEOUT_MS` and `StepStartInfo.timeoutMs` have always said the
   * budget was for — "a server that accepts the connection and then goes quiet", "silence is
   * the failure, not the duration" — and it used to be a flat `AbortSignal.timeout` over the
   * whole step, which is not the same thing at all. While a step held one tool call the two
   * were close enough that the difference never showed.
   *
   * Then a step started carrying several. Measured live, three runs of "create four thorough
   * ~100-line files": the model batched all four into one generation, ~5000 tokens of
   * arguments at the 57 tok/s this machine generates at, and every run died on the 90 s
   * ceiling having written NOTHING. The same task under one-call-per-step finished 3/3 in
   * 166 s, because the same work was spread over six steps that each fit. The turn was killed
   * for producing too much, too fast, in one piece.
   *
   * Re-arming on every delta fixes that without loosening the guard it exists to be: a server
   * that stops answering still trips at `timeoutMs` of quiet, wherever in the step it goes
   * quiet, and a step is still bounded overall by `maxTokensPerStep` — 8000 tokens is ~140 s
   * of generation, not an unbounded wait.
   *
   * The non-streaming path (`chat()`, used by compaction and by every caller that wires no
   * delta callback) produces no deltas and therefore keeps exactly the old flat deadline.
   * Prefill produces no deltas either, which is why `firstStepTimeoutMs` and the cold budget
   * from `beforeStep` still matter: re-prefilling a 100k-token prompt IS silence, and a real
   * one takes minutes.
   */
  private stepClock(steadyMs: number): {
    signal: AbortSignal
    /** Arm for the wait before a request's first token, which includes prefill. */
    beforeRequest(budgetMs: number): void
    /** A token arrived; from here on only the flat between-token budget applies. */
    touch(): void
    stop(): void
  } {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    // While a request is waiting for its FIRST token, an expired window asks the server
    // before killing anything. The char-counter behind `firstTokenBudget` predicts prefill
    // from what THIS process appended — it cannot see a server-side cache eviction, and
    // one evicted 180k-token prefix turned into a nine-minute re-prefill that died against
    // a deadline sized for a few hundred fresh tokens (watched live). `/slots` reports the
    // server's own progress on exactly that work: growing means the silence is prefill,
    // not failure, and the window re-arms; stalled or unreachable dies as it always did.
    // Generation re-arms through `touch()` on every delta, so the extension never loosens
    // the between-token guard.
    let awaitingFirstToken = false
    let lastProcessed = -1
    const quiet = (): void => { controller.abort(new Error('step went quiet')) }
    const fire = (): void => {
      if (!awaitingFirstToken) { quiet(); return }
      void this.opts.client.slotPrefillProgress().then((p) => {
        if (controller.signal.aborted) return
        if (p !== null && p.processing && p.processed > lastProcessed) {
          lastProcessed = p.processed
          arm(this.opts.prefillRecheckMs ?? PREFILL_RECHECK_MS)
          return
        }
        quiet()
      })
    }
    const arm = (ms: number): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(fire, ms)
      // Node keeps the process alive for a pending timer. A step's clock must never be the
      // reason a CLI run or a test worker refuses to exit.
      timer.unref?.()
    }
    arm(steadyMs)
    return {
      signal: controller.signal,
      beforeRequest: (budgetMs) => {
        if (!controller.signal.aborted) { awaitingFirstToken = true; lastProcessed = -1; arm(budgetMs) }
      },
      touch: () => { if (!controller.signal.aborted) { awaitingFirstToken = false; arm(steadyMs) } },
      stop: () => { if (timer !== undefined) clearTimeout(timer) },
    }
  }

  /**
   * How long to wait for the first token of the request about to be sent.
   *
   * The flat budget bounds the gap BETWEEN tokens. The gap before the first one is a
   * different quantity: llama.cpp reuses its cache by longest common prefix, so everything
   * appended since the last request has to be processed before a token can appear, and that
   * is work with a knowable length rather than idleness.
   *
   * Found by measurement, not reasoning. A step that batched three ~15k-token file reads made
   * the NEXT step prefill 46k new tokens — 116-185 s at the rates above — against a flat 90 s,
   * and a live turn died with the model perfectly healthy. The same shape had been quietly
   * eating the budget for a while: one 15k-token read already cost 58.8 s of the 90.
   *
   * `floorMs` is the caller's own larger budget when it knows the cache is cold for a reason
   * this counter cannot see — a compaction swap, or a session resumed in a fresh process.
   * Taking the max composes the two rather than letting either override the other.
   */
  private firstTokenBudget(floorMs: number): number {
    const chars = this.transcript.messages()
      .reduce((n, m) => n + (m.content?.length ?? 0) + (m.reasoning_content?.length ?? 0), 0)
    const fresh = Math.max(0, chars - this.charsAtLastRequest)
    this.charsAtLastRequest = chars
    const budget = Math.max(floorMs, this.opts.stepTimeoutMs + prefillAllowanceMs(fresh))
    return Math.min(MAX_COLD_START_MS, budget)
  }

  /**
   * One HTTP call, with cancellation and the step deadline turned into outcomes.
   *
   * A cancel button always lands *inside* a call — a step lasts 35-40 s — so an abort
   * mid-call is the normal case, not the exotic one, and must not escape as a transport
   * error.
   */
  private async chat(
    schemas: ReturnType<ToolRegistry['schemas']>,
    toolChoice: 'auto' | 'required',
    clock: { signal: AbortSignal; touch(): void; beforeRequest(budgetMs: number): void },
  ): Promise<ChatOutcome> {
    const deadline = clock.signal
    const signal = this.opts.signal
      ? AbortSignal.any([this.opts.signal, deadline])
      : deadline
    const events = this.opts.events
    const request = {
      messages: [...this.transcript.messages()] as ChatMessage[],
      tools: schemas,
      toolChoice,
      maxTokens: this.opts.maxTokensPerStep,
      // A caller-supplied override for the whole turn — the escalated retry raises the
      // temperature to sample a DIFFERENT approach off the identical cached prefix.
      // Absent everywhere else, which keeps the frozen QWEN_SAMPLING default.
      ...(this.opts.sampling !== undefined ? { sampling: this.opts.sampling } : {}),
      signal,
    }
    // One retry, after waiting the server back to health. Watched live: llama.cpp dies
    // silently on a VRAM spike mid-generation ("stream read error (TypeError:
    // terminated)" during thinking), the launcher's watchdog relaunches it, and the model
    // reload takes ~20-30 s. The prompt is unchanged between attempts, so the retry costs
    // one cheap re-prefill through the cache — while NOT retrying costs the whole turn for
    // an outage the server has already recovered from. Deltas the dead attempt streamed
    // are superseded by the fresh attempt's; the step deadline keeps running throughout,
    // so a retry that would overrun the step reports 'timeout' exactly as before.
    for (let attempt = 0; ; attempt++) {
    try {
      // Streaming is opt-in per host: only switched on when a host actually wired a delta
      // callback. Integration tests and compaction never set one, so they keep calling
      // chat() exactly as before. Everything below this call — truncation continuation,
      // tool dispatch, transcript append, timeout/abort mapping — reads the ASSEMBLED
      // ChatResult that both methods return in the same shape; nothing downstream knows
      // which path produced it.
      const result = events?.onThinkingDelta || events?.onTextDelta || events?.onToolCallDelta ||
        events?.onProgress
        ? await this.opts.client.chatStream(request, {
          onDelta: (d) => {
            // Every delta that carries GENERATION is proof the server is alive — reasoning,
            // visible text, or a fragment of a tool argument. Re-arming here rather than only
            // for the kinds a host happens to render is the point: a step spends most of a
            // large edit emitting `toolCallArguments` and nothing else.
            //
            // A progress-only delta deliberately does NOT re-arm. It says the server is
            // working, not that the generation is moving, and `firstTokenTimeoutMs` is a
            // prefill-INCLUSIVE budget: letting prefill chunks extend it would quietly turn
            // a total budget into a between-chunks one, so a prefill that crawls forever
            // would never time out. That may well be the better policy — it is not this
            // change's to make, and this change is meant to be purely observational.
            if (d.progress === undefined) clock.touch()
            else events?.onProgress?.(d.progress)
            if (d.reasoning) events?.onThinkingDelta?.(d.reasoning)
            if (d.content) events?.onTextDelta?.(d.content)
            if (d.toolCallIndex !== undefined && (d.toolCallName !== undefined || d.toolCallArguments !== undefined)) {
              events?.onToolCallDelta?.({
                index: d.toolCallIndex,
                ...(d.toolCallName !== undefined ? { name: d.toolCallName } : {}),
                ...(d.toolCallArguments !== undefined ? { args: d.toolCallArguments } : {}),
              })
            }
          },
        })
        : await this.opts.client.chat(request)
      return { kind: 'ok', result }
    } catch (e) {
      // The caller's cancel wins over our own deadline when both fired.
      if (this.opts.signal?.aborted) {
        this.appendInterrupted(e)
        return { kind: 'aborted' }
      }
      if (deadline.aborted) return { kind: 'timeout' }
      if (attempt === 0 && e instanceof LlamaRequestError) {
        const healthy = await this.opts.client.waitHealthy(SERVER_RESTART_WAIT_MS, this.opts.signal)
        // The cancel is re-checked on BOTH outcomes of the wait, not only when the server
        // came back. `waitHealthy` answers `false` for two different things — the budget
        // ran out, and the signal aborted (client.ts) — so pressing Esc during a 90 s wait
        // for the watchdog used to fall straight through to `throw e`: the transport error
        // escaped runStep, runTurn and Session.send, the host never emitted `turn.done`,
        // and a cancelled turn surfaced in the window as "stream read error (TypeError:
        // terminated)". Cancelling during the wait is the likeliest moment there is to
        // cancel — the window has been frozen for however long the outage has lasted.
        if (this.opts.signal?.aborted) { this.appendInterrupted(e); return { kind: 'aborted' } }
        if (healthy) {
          if (deadline.aborted) return { kind: 'timeout' }
          // Zeroed BEFORE the budget is computed, because `firstTokenBudget` both reads and
          // ADVANCES `charsAtLastRequest`: computing first would price only the handful of
          // characters appended since the last request, which is exactly the reading that is
          // no longer true once the server has forgotten everything.
          // RE-ARM, or the retry inherits a clock that is already most of the way through
          // its budget. The dead attempt's deltas had called `touch()`, which clears
          // `awaitingFirstToken` and leaves only the flat between-token allowance running;
          // `waitHealthy` then burns 20-30 s of it on the model reload. What comes back is
          // a process with an EMPTY KV cache, so the retried request must prefill the whole
          // prompt from nothing — and the turn died on "passed its 90 s time limit" against
          // a server that was perfectly healthy and working hard. Worse, with
          // `awaitingFirstToken` false the /slots prefill extension written for exactly this
          // silence short-circuits and never even probes. `charsAtLastRequest = 0` is what
          // makes `firstTokenBudget` price the WHOLE prompt rather than the few characters
          // appended since the last request, which is the honest reading now that nothing
          // on the far side remembers any of it. The app's own reducer already re-arms for
          // this wait; the core did not.
          this.charsAtLastRequest = 0
          const retryBudget = this.firstTokenBudget(this.opts.stepTimeoutMs)
          clock.beforeRequest(retryBudget)
          // Announced AFTER the budget exists so the window can adopt it, and before the
          // re-send so a renderer that keeps appending does not splice the retry's stream
          // onto the dead attempt's partial reasoning.
          events?.onStepRetry?.(retryBudget)
          continue
        }
      }
      throw e
    }
    }
  }

  /**
   * Runs a tool, refusing anything outside `allowedTools` before it can act, then — if a
   * `PermissionEngine` was supplied — gating the call through it before execution.
   *
   * The schemas sent to the server are already filtered, and on the real server the
   * grammar keeps the model inside them — but "no editing tools are available to you at
   * all" is a promise made to the user in plan mode, and it must not depend on a remote
   * process behaving. A refusal goes back as an ordinary tool message so the model can
   * correct itself.
   *
   * The permission gate runs strictly after that allowedTools refusal: plan mode's
   * guarantee is enforced by the tool list itself, not by whatever the engine happens to
   * decide for a tool it should never see in the first place.
   *
   * `prepare` runs before the gate so the engine's `decide()` — and, on an `ask` verdict,
   * the approval preview shown to the user — sees the tool's OWN validated args (e.g. a
   * resolved `path`), not the model's raw JSON string. This also means a call with bad
   * JSON or arguments that fail validation is rejected exactly as before, without ever
   * reaching the engine.
   */
  private async runTool(name: string, args: string): Promise<ToolResult> {
    const allowed = this.opts.allowedTools
    if (allowed && !allowed.includes(name)) {
      return {
        ok: false,
        content: `The tool "${name}" is not available in this mode and was not run. ` +
                 `Available tools: ${allowed.join(', ') || 'none'}.`,
      }
    }

    const prepared = this.opts.registry.prepare(name, args)
    if (!prepared.ok) return { ok: false, content: prepared.content }

    // Before the permission gate, and deliberately: this call is not going to be run, so
    // there is nothing to ask the user about. Putting it after would surface an approval
    // card for an action that is about to be refused anyway — the worst possible moment to
    // interrupt someone, and during an unattended run it would fill the decision queue with
    // questions about a loop.
    const detector = this.opts.loopDetector
    if (detector?.wouldRepeat(name, args)) {
      // Deliberately NOT recorded. The refusal is the detector's own output, not something
      // the tool returned, and recording it as a result made the next identical call look
      // like progress — the window's last two entries were then "the real answer" and "the
      // refusal", which differ, so the call was allowed to run again. Measured: the tool ran
      // twice, was refused once, and then ran twice more. Leaving the refusal out of the
      // window means every further attempt meets the same wall, which is the point.
      return { ok: false, content: detector.refusal(name) }
    }

    // The whole gate is wrapped: `port.requestApproval` is a host boundary (today an
    // in-process callback, tomorrow IPC/JSON), and a rejection from it must not propagate
    // out of `runTool`. Left unguarded, that throw would escape past the assistant message
    // that already carries the tool_call — the exact poisoned-transcript state the class
    // comment on `runTurn` warns about, since no tool reply would ever be appended for it —
    // and `runTurn` would reject instead of returning a `TurnResult`. `executePrepared`
    // already never throws on its own, so it stays outside this try: nothing here needs it
    // caught twice.
    try {
      const engine = this.opts.permissions
      if (engine) {
        const key: PermissionKey =
          prepared.tool.permissionKey?.(prepared.args, this.toolContext()) ?? { tool: name }
        const decision = engine.decide(key)
        if (decision.verdict === 'deny') {
          return this.remember(detector, name, args, { ok: false, content: `Not run. ${decision.reason}` })
        }
        if (decision.verdict === 'ask') {
          const port = this.opts.interaction
          if (!port) {
            return {
              ok: false,
              content: 'Not run: this action needs the user\'s approval and no interactive ' +
                       'host is connected. Suggest it to the user instead.',
            }
          }
          const preview = await this.approvalPreviewFor(prepared, name, args)
          const decided = await port.requestApproval({
            tool: name,
            summary: preview.summary,
            detail: preview.detail,
            // An explicit ask RULE (decision.source === 'rule') was written specifically to
            // require asking every time this key matches; suggesting "always allow" here
            // would be a lie, since decide() consults the ask tier before ever looking at
            // sessionAllow, so no allow rule could ever win over it for the same key. A
            // mode-default ask (source: 'mode') carries no such conflict and still offers
            // its normal suggestions.
            suggestedRules: decision.source === 'rule' ? [] : suggestRules(key),
          })
          // The dialog can resolve after the turn was cancelled — a step lasts 35-40 s, an
          // Esc press can land at any point in that window, and "pending approval" is no
          // exception. Re-checked here, immediately after the await, rather than trusting
          // the caller to notice: a stale `allow` must not execute into an aborted turn.
          if (this.opts.signal?.aborted) {
            return {
              ok: false,
              content: 'Not run: the turn was cancelled while approval was pending.',
            }
          }
          if (decided.verdict === 'defer') {
            // Not a refusal by a person: nobody was there. Said in those terms so the model
            // moves sideways to other work instead of reasoning about an objection nobody
            // made. See `ApprovalDecision`'s `defer` arm.
            return this.remember(detector, name, args, { ok: false, content: `Not run: ${decided.reason}` })
          }
          if (decided.verdict === 'deny') {
            const why = decided.comment ? `: "${decided.comment}"` : ''
            // Watched live: a denied edit came back as a "different" edit to the same file,
            // twice, three times — each one a fresh variant, so the exact-args dedup guard
            // rightly stayed silent, and every variant cost the user another approval card.
            // One denial is feedback on the attempt; two on the same tool+target are
            // feedback on the GOAL, and the escalation says so instead of letting variant
            // number four arrive.
            const identity = denialIdentity(key)
            const denials = (this.denialsThisTurn.get(identity) ?? 0) + 1
            this.denialsThisTurn.set(identity, denials)
            return {
              ok: false,
              content: denials >= 2
                ? `The user declined this ${name} call${why} — decline #${denials} for ` +
                  'the same target this turn. STOP proposing further variants of this ' +
                  'change: the user does not want it. Ask them what they actually want, or ' +
                  'finish the turn explaining what was not done and why.'
                : `The user declined this ${name} call${why}. Take their comment into ` +
                  'account and adjust your approach; do not simply retry the same call.',
            }
          }
          if (decided.verdict !== 'allow') {
            // `ApprovalDecision` is a closed union in TS, but the port is a host boundary —
            // at runtime it can hand back `{}`, a typo'd verdict, `null`, or anything else
            // JSON allows. Only a recognized 'allow' proceeds; everything else fails closed
            // rather than being treated as consent.
            return {
              ok: false,
              content: 'Not run: the approval reply was not recognized, so it was treated ' +
                       'as a denial.',
            }
          }
          if (decided.remember) {
            try {
              engine.remember(decided.remember.rule, decided.remember.layer)
            } catch { /* remembering must never fail the approved call */ }
          }
        }
      }
    } catch (e) {
      return {
        ok: false,
        content: `Not run: the approval flow failed (${e instanceof Error ? e.message : String(e)}); ` +
                 'treated as a denial.',
      }
    }
    const result = await this.opts.registry.executePrepared(prepared, this.toolContext(name))
    detector?.record(name, args, result.content)

    // After-tool hooks fire HERE: after the tool ran, before `runTurn` appends the tool
    // message. A hook's note is therefore folded into the result the transcript records,
    // so nothing is ever rewritten and the append-only law holds. A hook cannot veto --
    // the action already happened, and vetoing after the fact is what the permission
    // engine does properly, before.
    const hooks = this.opts.hooks
    if (!hooks) return result
    const key: PermissionKey =
      prepared.tool.permissionKey?.(prepared.args, this.toolContext()) ?? { tool: name }
    return hooks.afterTool(key, result, this.opts.context.signal)
  }

  /**
   * Records a gate outcome with the loop detector, then returns it unchanged.
   *
   * A denial and a deferral ARE results the call produced — unlike the detector's own
   * refusal, which is its output and must stay out of its window. Recording them is what
   * stops the model re-issuing a call the gate already turned down: the live rehearsal saw
   * it queue the same `npx tsc --noEmit` three times, because a deferred call never reached
   * the `record` after `executePrepared` and so was invisible to the detector.
   */
  private remember(
    detector: LoopDetector | undefined, name: string, args: string, result: ToolResult,
  ): ToolResult {
    detector?.record(name, args, result.content)
    return result
  }

  /**
   * Human-readable text for an approval prompt: the tool's own `approvalPreview` when it
   * has one, otherwise the bare tool name and a clipped view of its raw arguments.
   *
   * A broken preview must never block an otherwise-approvable call — a tool's
   * `approvalPreview` is presentation code, not a gate, so a throw or a missing
   * implementation falls back rather than failing the whole tool call.
   */
  private async approvalPreviewFor(
    p: { tool: Tool<any>; args: any }, name: string, rawArgs: string,
  ): Promise<ApprovalPreview> {
    try {
      const preview = await p.tool.approvalPreview?.(p.args, this.toolContext())
      if (preview) return preview
    } catch { /* fall through */ }
    // Matches the marker the tools' own approvalPreview implementations use (e.g.
    // write-file.ts, edit-file.ts) so a silent clip never reads as the whole argument
    // string to whoever is approving it.
    const detail = rawArgs.length > 1_000
      ? `${rawArgs.slice(0, 1_000)}\n... (clipped)`
      : rawArgs
    return { summary: name, detail }
  }

  /**
   * The context tools are run with, carrying the turn's cancellation.
   *
   * `this.opts.context` used to be passed through untouched, so `ctx.signal` was undefined
   * for every tool call there has ever been. `search_code` already wires
   * `cancelSignal: ctx.signal`, so that branch was dead code: a 30 s ripgrep and an
   * unbounded `find_files` walk both ignored the user's cancel, and interrupt is a stated
   * requirement.
   *
   * The step deadline is deliberately *not* included — it covers the model calls, and
   * tools carry their own timeouts. A caller-supplied context signal is combined rather
   * than replaced, so a caller that already has its own cancellation keeps it.
   */
  private toolContext(toolName?: string): ToolContext {
    const events = this.opts.events
    const live: Pick<ToolContext, 'onLiveOutput'> =
      toolName !== undefined && events?.onToolOutput
        ? { onLiveOutput: (text) => events.onToolOutput?.(toolName, text) }
        : {}
    const turn = this.opts.signal
    if (!turn) return { ...this.opts.context, ...live }
    const own = this.opts.context.signal
    return {
      ...this.opts.context,
      ...live,
      signal: own && own !== turn ? AbortSignal.any([own, turn]) : turn,
    }
  }

  private report(m: ChatMessage): void {
    if (m.reasoning_content) this.opts.events?.onThinking?.(m.reasoning_content)
  }

  /**
   * Appends the assistant turn that ran out of room, so the continuation resumes from the
   * thinking instead of repeating it.
   *
   * Any tool_calls are dropped: a generation cut off on "length" may have emitted a
   * partial call, and an assistant turn carrying a call with no matching tool message is
   * invalid anyway. The continuation re-emits it under tool_choice: 'required'.
   */
  /**
   * Carries the abandoned turn back into the prompt — UNLESS it was a loop.
   *
   * Carrying it is the right default and was measured as such: thinking that ran out of room
   * is usually thinking that got somewhere, and throwing it away makes the model re-derive it
   * from zero at full price.
   *
   * A spiral is the opposite case and the same code path. Reported from a real session: the
   * thinking repeated the same few sentences for the entire 8000-token budget. Appending that
   * puts eight thousand tokens of the model's own repetition permanently into the transcript,
   * where every later step reads it — and a model shown that much of its own looping is
   * likelier to loop again. It explains the shape of the report exactly: compaction did not
   * help, stopping did not help, and only a new session did, because the transcript was what
   * carried the fault.
   *
   * So repetitive thinking is dropped and only its first stretch is kept, enough that the
   * model can see where it was going without being handed the loop back.
   */
  private appendTruncated(m: ChatMessage): void {
    if (!m.content && !m.reasoning_content) return
    const out: ChatMessage = { role: 'assistant', content: m.content ?? null }
    if (m.reasoning_content) {
      out.reasoning_content = looksRepetitive(m.reasoning_content)
        ? `${m.reasoning_content.slice(0, LOOP_KEEP_CHARS)}\n\n[The rest of this was the same ` +
          'few sentences repeating, and has been dropped rather than carried forward.]'
        : m.reasoning_content
    }
    this.transcript.append(out)
  }

  /**
   * User-initiated abort (Esc), never the step deadline or a transport error: the caller
   * only reaches here after confirming `this.opts.signal.aborted` itself, so a timeout or
   * a genuine connection failure never runs this. DESIGN.md's interrupt row: the stream's
   * partial is KEPT in the transcript, marked interrupted, so the prefix it already built
   * stays warm and resuming costs seconds instead of a fresh generation.
   *
   * `err.partial` is only ever set by `chatStream` for a failure that occurred mid-stream
   * (Task 3) -- absent entirely for an abort that fired before the first byte, and present
   * but both fields empty for an abort between the response arriving and the first delta.
   * Either way there is nothing worth keeping, so nothing is appended.
   *
   * No tool_calls, ever -- same principle as appendTruncated: a call cut off mid-stream may
   * be malformed JSON, and an assistant turn carrying a tool_call with no matching tool
   * reply is invalid on the next request anyway.
   */
  private appendInterrupted(e: unknown): void {
    const partial = e instanceof LlamaRequestError ? e.partial : undefined
    if (!partial || (!partial.reasoning && !partial.content)) return
    const marker = '[interrupted by the user before this reply finished]'
    const content = partial.content ? `${partial.content}\n${marker}` : marker
    const out: ChatMessage = { role: 'assistant', content }
    if (partial.reasoning) out.reasoning_content = partial.reasoning
    this.transcript.append(out)
  }

  /**
   * Reasoning is carried forward within a turn. The server runs with --reasoning-preserve,
   * and without it the model forgets its own goal between tool round-trips. Trimming the
   * reasoning of *previous completed turns* is a separate concern and belongs to the
   * context-management plan, where it can be done without breaking the prefix.
   */
  private assistantMessage(m: ChatMessage): ChatMessage {
    const out: ChatMessage = { role: 'assistant', content: m.content ?? null }
    if (m.reasoning_content) out.reasoning_content = m.reasoning_content
    if (m.tool_calls) out.tool_calls = m.tool_calls
    return out
  }
}
