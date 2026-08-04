import type { AgentMode } from '../permissions/engine.js'

export interface PromptOptions {
  workspaceRoot: string
  mode: AgentMode
  /**
   * The assembled `AGENTS.md` block (see `memory/project-memory.ts`), or absent.
   *
   * It goes LAST, after the mode paragraph, for two reasons: the mode paragraph belongs
   * next to the base rules it modifies, and standing project facts read best as the final
   * thing before the conversation starts. When absent this function returns byte-for-byte
   * what it returned before memory existed.
   */
  memory?: string
}

/**
 * Kept deliberately short. The tool schemas already describe the tools; repeating that
 * here wastes context and, on a 3B-active model, dilutes instruction following.
 *
 * The "decide and act" paragraph is load-bearing, not politeness: measured, it is one of
 * the two levers that stop the thinking runaway (docs/SPIKE-TEMPERATURE.md).
 */
export function buildSystemPrompt(opts: PromptOptions): string {
  const common = [
    `You are PrivateCode, a coding agent working in the local workspace ${opts.workspaceRoot}.`,
    '',
    'Work in small steps. Each step: use exactly one tool, look at the result, then decide',
    'the next step. Never claim something works unless a command or test you ran says so.',
    '',
    'Do not deliberate at length, and do not re-check a decision you have already made —',
    'if you notice yourself going over the same reasoning twice, stop and call the tool.',
    'Prefer the smallest change that satisfies the request.',
    '',
    'Prefer a targeted search over a broad one.',
    '',
    // Qwen3.6 is trained predominantly on Chinese and, with no language pinned, drifts
    // into it mid-sentence -- observed in a Russian answer that finished a clause in
    // Chinese. The model has no way to know this is unwanted unless told; nothing else in
    // this prompt mentions language at all.
    'Reply in the same language the user writes in. Never switch languages inside an',
    'answer, and never mix scripts in one sentence. Keep code, identifiers, paths and',
    'command output exactly as they are, in whatever language they are already in.',
  ]

  const parts = [...common]
  if (opts.mode === 'plan') {
    parts.push(
      '',
      'You are in PLAN mode. You cannot modify anything: no editing tools are available to',
      'you at all. Investigate, then reply with a concrete plan — which files change and',
      'how. The user will approve it before any change is made.',
    )
  } else if (opts.mode === 'autopilot') {
    parts.push(
      '',
      'You are in AUTOPILOT mode: act without waiting for confirmations, but stay strictly ' +
      'inside the workspace.',
    )
  }
  // 'normal' and 'auto-edit' add nothing: what differs between them is which tool calls the
  // permission engine gates, not what the model is told.

  // Memory goes LAST -- see PromptOptions.memory. An absent or empty block leaves this
  // function returning byte-for-byte what it returned before memory existed, which is what
  // keeps every existing assertion about this prompt meaningful.
  if (opts.memory !== undefined && opts.memory !== '') parts.push('', opts.memory)
  return parts.join('\n')
}
