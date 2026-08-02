import type { AgentMode } from '../permissions/engine.js'

export interface PromptOptions {
  workspaceRoot: string
  mode: AgentMode
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
  ]

  if (opts.mode === 'plan') {
    return [
      ...common,
      '',
      'You are in PLAN mode. You cannot modify anything: no editing tools are available to',
      'you at all. Investigate, then reply with a concrete plan — which files change and',
      'how. The user will approve it before any change is made.',
    ].join('\n')
  }
  if (opts.mode === 'autopilot') {
    return [
      ...common,
      '',
      'You are in AUTOPILOT mode: act without waiting for confirmations, but stay strictly ' +
      'inside the workspace.',
    ].join('\n')
  }
  // 'normal' and 'auto-edit' both use the common prompt verbatim: what differs between
  // them is which tool calls the permission engine gates, not what the model is told.
  return common.join('\n')
}
