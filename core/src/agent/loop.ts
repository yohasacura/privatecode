import type { InteractionPort } from '../interaction.js'
import type { LlamaClient } from '../llama/client.js'
import type { ChatMessage, ChatResult } from '../llama/types.js'
import type { AgentMode, PermissionEngine } from '../permissions/engine.js'
import { suggestRules } from '../permissions/rules.js'
import { Transcript } from '../transcript/transcript.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ApprovalPreview, PermissionKey, Tool, ToolContext, ToolResult } from '../tools/types.js'
import { buildSystemPrompt } from './prompt.js'

/**
 * Default per-step wall-clock ceiling.
 *
 * A hard single-file edit measures 35-40 s (docs/DESIGN.md §7), and a truncated step
 * generates twice, so the budget has to cover two of those without letting a server that
 * accepts the connection and then goes quiet stall the UI until the client's ten-minute
 * transport timeout. 90 s is roughly two generations plus headroom.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 90_000

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

export interface StepStartInfo {
  /** 1-based index of this step within the turn. */
  step: number
  /**
   * Wall-clock budget for the whole step, continuation included. Emitted at step *start*
   * so a UI can run a countdown: the measured worst case is a 119 s silent step, and
   * silence is the failure, not the duration.
   */
  timeoutMs: number
}

export interface StepInfo {
  /** 1-based index of this step within the turn; pairs with the StepStartInfo. */
  step: number
  seconds: number
  completionTokens?: number
  tokensPerSecond?: number
  continued: boolean
}

export interface AgentEvents {
  /** Every step emits exactly one of these, and exactly one matching onStepDone. */
  onStepStart?(info: StepStartInfo): void
  onThinking?(text: string): void
  /**
   * The step ran out of room mid-thought and a forced continuation is starting *now*.
   * Without this the median hard step is silent across two full generations.
   */
  onContinuation?(step: number): void
  onToolCall?(name: string, args: string): void
  onToolResult?(name: string, result: ToolResult): void
  onAssistantText?(text: string): void
  /** Emitted once the model call(s) of the step are over, before the tool runs. */
  onStepDone?(info: StepInfo): void
}

export interface AgentOptions {
  client: LlamaClient
  registry: ToolRegistry
  context: ToolContext
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
   * How an `ask` verdict is put to the user. Required for `permissions` to ever produce
   * anything other than a flat refusal: with an engine but no port, an `ask` verdict
   * cannot be shown to anyone, so the call is refused with a message telling the model to
   * suggest it to the user instead of retrying.
   */
  interaction?: InteractionPort
  maxSteps?: number
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

export interface TurnResult {
  steps: number
  /**
   * The model's own closing prose when there is any — including prose that accompanied a
   * tool call — otherwise a one-line statement of why the turn stopped.
   */
  finalText: string
  stoppedBecause: 'done' | 'max_steps' | 'aborted' | 'timeout' | 'truncated'
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

const TRUNCATED_TWICE =
  'You ran out of room while thinking twice in a row, so that step was abandoned and ' +
  'nothing was done. Do not restate your plan: choose the smallest possible next action ' +
  'and call one tool immediately.'

export class Agent {
  private readonly opts: Required<
    Pick<AgentOptions, 'maxSteps' | 'maxTokensPerStep' | 'mode' | 'stepTimeoutMs' | 'toolChoice'>
  > & AgentOptions
  readonly transcript: Transcript

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
      maxSteps: opts.maxSteps ?? 40,
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

    for (let step = 1; step <= this.opts.maxSteps; step++) {
      if (this.opts.signal?.aborted) {
        return { steps: step - 1, finalText: lastText, stoppedBecause: 'aborted' }
      }

      const outcome = await this.runStep(step, schemas)

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

      // One action per step: if the model proposes several, take the first. The rest are
      // still answered — an assistant turn carrying an unanswered tool_call is invalid on
      // a strict OpenAI endpoint, and would poison every later request of the session.
      const call = calls[0]!
      this.opts.events?.onToolCall?.(call.function.name, call.function.arguments)
      const result = await this.runTool(call.function.name, call.function.arguments)
      this.opts.events?.onToolResult?.(call.function.name, result)
      this.transcript.append({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: result.content,
      })
      for (const skipped of calls.slice(1)) {
        this.transcript.append({
          role: 'tool',
          tool_call_id: skipped.id,
          name: skipped.function.name,
          content: `Not executed: one tool call per step, and ${call.function.name} ran ` +
                   'first. Re-issue this one on a later step if it is still needed.',
        })
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
  ): Promise<StepOutcome> {
    const started = performance.now()
    const timeoutMs = this.opts.stepTimeoutMs
    const deadline = AbortSignal.timeout(timeoutMs)
    this.opts.events?.onStepStart?.({ step, timeoutMs })

    let continued = false
    let last: ChatResult | undefined
    try {
      const first = await this.chat(schemas, this.opts.toolChoice, deadline)
      if (first.kind !== 'ok') return first
      last = first.result
      this.report(first.result.message)

      if (first.result.finishReason !== 'length') {
        return { kind: 'message', message: first.result.message }
      }

      continued = true
      this.appendTruncated(first.result.message)
      this.transcript.append({ role: 'user', content: CONTINUE_NUDGE })
      this.opts.events?.onContinuation?.(step)

      const again = await this.chat(schemas, 'required', deadline)
      if (again.kind !== 'ok') return again
      last = again.result
      this.report(again.result.message)
      if (again.result.finishReason === 'length') return { kind: 'truncated' }
      return { kind: 'message', message: again.result.message }
    } finally {
      this.opts.events?.onStepDone?.({
        step,
        seconds: (performance.now() - started) / 1000,
        ...(last?.usage?.completion_tokens !== undefined
          ? { completionTokens: last.usage.completion_tokens } : {}),
        ...(last?.timings?.predicted_per_second !== undefined
          ? { tokensPerSecond: last.timings.predicted_per_second } : {}),
        continued,
      })
    }
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
    deadline: AbortSignal,
  ): Promise<ChatOutcome> {
    const signal = this.opts.signal
      ? AbortSignal.any([this.opts.signal, deadline])
      : deadline
    try {
      const result = await this.opts.client.chat({
        messages: [...this.transcript.messages()] as ChatMessage[],
        tools: schemas,
        toolChoice,
        maxTokens: this.opts.maxTokensPerStep,
        signal,
      })
      return { kind: 'ok', result }
    } catch (e) {
      // The caller's cancel wins over our own deadline when both fired.
      if (this.opts.signal?.aborted) return { kind: 'aborted' }
      if (deadline.aborted) return { kind: 'timeout' }
      throw e
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
        const key: PermissionKey = prepared.tool.permissionKey?.(prepared.args) ?? { tool: name }
        const decision = engine.decide(key)
        if (decision.verdict === 'deny') {
          return { ok: false, content: `Not run. ${decision.reason}` }
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
          if (decided.verdict === 'deny') {
            const why = decided.comment ? `: "${decided.comment}"` : ''
            return {
              ok: false,
              content: `The user declined this ${name} call${why}. Take their comment into ` +
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
    return this.opts.registry.executePrepared(prepared, this.toolContext())
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
  private toolContext(): ToolContext {
    const turn = this.opts.signal
    if (!turn) return this.opts.context
    const own = this.opts.context.signal
    return {
      ...this.opts.context,
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
  private appendTruncated(m: ChatMessage): void {
    if (!m.content && !m.reasoning_content) return
    const out: ChatMessage = { role: 'assistant', content: m.content ?? null }
    if (m.reasoning_content) out.reasoning_content = m.reasoning_content
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
