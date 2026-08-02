import type { LlamaClient } from '../llama/client.js'
import type { ChatMessage } from '../llama/types.js'
import { Transcript } from '../transcript/transcript.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ToolContext, ToolResult } from '../tools/types.js'
import { buildSystemPrompt } from './prompt.js'

export interface StepInfo {
  seconds: number
  completionTokens?: number
  tokensPerSecond?: number
  continued: boolean
}

export interface AgentEvents {
  onThinking?(text: string): void
  onToolCall?(name: string, args: string): void
  onToolResult?(name: string, result: ToolResult): void
  onAssistantText?(text: string): void
  onStepDone?(info: StepInfo): void
}

export interface AgentOptions {
  client: LlamaClient
  registry: ToolRegistry
  context: ToolContext
  /** Tool names the model may use this turn. Omit for all of them. */
  allowedTools?: string[]
  mode?: 'normal' | 'plan'
  maxSteps?: number
  /** Generous by design: thinking needs room. Truncation is handled, not avoided. */
  maxTokensPerStep?: number
  transcript?: Transcript
  events?: AgentEvents
  signal?: AbortSignal
}

export interface TurnResult {
  steps: number
  finalText: string
  stoppedBecause: 'done' | 'max_steps' | 'aborted'
}

export class Agent {
  private readonly opts: Required<Pick<AgentOptions, 'maxSteps' | 'maxTokensPerStep' | 'mode'>> &
    AgentOptions
  readonly transcript: Transcript

  constructor(opts: AgentOptions) {
    // Defaults must come AFTER the spread: an explicitly-undefined property would
    // otherwise overwrite them.
    this.opts = {
      ...opts,
      maxSteps: opts.maxSteps ?? 40,
      maxTokensPerStep: opts.maxTokensPerStep ?? 4000,
      mode: opts.mode ?? 'normal',
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
    this.transcript.append({ role: 'user', content: userText })
    const schemas = this.opts.registry.schemas(this.opts.allowedTools)
    let finalText = ''

    for (let step = 1; step <= this.opts.maxSteps; step++) {
      if (this.opts.signal?.aborted) {
        return { steps: step - 1, finalText, stoppedBecause: 'aborted' }
      }

      const outcome = await this.callModel(schemas, false)
      const message = outcome.message

      if (message.reasoning_content) this.opts.events?.onThinking?.(message.reasoning_content)

      const calls = message.tool_calls ?? []
      if (calls.length === 0) {
        finalText = message.content ?? ''
        this.opts.events?.onAssistantText?.(finalText)
        this.transcript.append(this.assistantMessage(message))
        return { steps: step, finalText, stoppedBecause: 'done' }
      }

      this.transcript.append(this.assistantMessage(message))

      // One action per step: if the model proposes several, take the first and tell it so.
      const call = calls[0]!
      this.opts.events?.onToolCall?.(call.function.name, call.function.arguments)
      const result = await this.opts.registry.run(
        call.function.name, call.function.arguments, this.opts.context,
      )
      this.opts.events?.onToolResult?.(call.function.name, result)
      this.transcript.append({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: result.content,
      })
      if (calls.length > 1) {
        this.transcript.append({
          role: 'user',
          content: `Only the first tool call was executed (${call.function.name}). ` +
                   `Call one tool per step.`,
        })
      }
    }
    return { steps: this.opts.maxSteps, finalText, stoppedBecause: 'max_steps' }
  }

  /**
   * One model call, with the truncation rule applied.
   *
   * finish_reason "length" means the model was still thinking when the budget ran out.
   * The reasoning so far is already in the server's cache, so continuing is cheap — and
   * the continuation forces an action, which is what actually breaks a spiral.
   */
  private async callModel(schemas: ReturnType<ToolRegistry['schemas']>, isContinuation: boolean) {
    const started = performance.now()
    const request = {
      messages: [...this.transcript.messages()] as ChatMessage[],
      tools: schemas,
      toolChoice: (isContinuation ? 'required' : 'auto') as 'required' | 'auto',
      maxTokens: this.opts.maxTokensPerStep,
      ...(this.opts.signal ? { signal: this.opts.signal } : {}),
    }
    let result = await this.opts.client.chat(request)

    if (result.finishReason === 'length' && !isContinuation) {
      this.transcript.append({
        role: 'user',
        content: 'You ran out of room while thinking. Stop deliberating and take the next ' +
                 'action now, using one tool call.',
      })
      // Rebuild the messages: the nudge was appended after `request` was captured.
      result = await this.opts.client.chat({
        ...request,
        messages: [...this.transcript.messages()] as ChatMessage[],
        toolChoice: 'required',
      })
      this.opts.events?.onStepDone?.({
        seconds: (performance.now() - started) / 1000,
        ...(result.usage?.completion_tokens !== undefined
          ? { completionTokens: result.usage.completion_tokens } : {}),
        ...(result.timings?.predicted_per_second !== undefined
          ? { tokensPerSecond: result.timings.predicted_per_second } : {}),
        continued: true,
      })
      return result
    }

    this.opts.events?.onStepDone?.({
      seconds: (performance.now() - started) / 1000,
      ...(result.usage?.completion_tokens !== undefined
        ? { completionTokens: result.usage.completion_tokens } : {}),
      ...(result.timings?.predicted_per_second !== undefined
        ? { tokensPerSecond: result.timings.predicted_per_second } : {}),
      continued: false,
    })
    return result
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
