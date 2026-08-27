import { Agent, type AgentOptions } from './loop.js'
import type { LlamaClient } from '../llama/client.js'
import type { AgentMode, PermissionEngine } from '../permissions/engine.js'
import { ReadMemory } from '../tools/read-memory.js'
import type { ToolRegistry } from '../tools/registry.js'
import { Transcript } from '../transcript/transcript.js'
import type { Workspace } from '../workspace.js'

/**
 * A worker with one job, its own short conversation, and no memory of yours.
 *
 * The shape is not new here — the diff reviewer has been one since it stopped being a single
 * generation: a bounded read-only `Agent` over its OWN transcript, with an explicit tool
 * subset and a forced answer at the end. This generalises that, because two measurements say
 * it is worth having more than one of.
 *
 * **It is cheap.** `spike/narrow-agent-probe.mts`, same planted defect, same model: the wide
 * reviewer took 114.4 s, 50.0 s and 69.3 s to reach an answer a narrow question reached in
 * 4.8 s, 6.0 s and 3.6 s. Both were right, 3/3 each — so the honest claim is not that narrow
 * is more accurate here, it is that it is roughly sixteen times cheaper for the same answer.
 *
 * **It stays cheap.** `spike/agent-switch-cost-probe.mts`: this server runs ONE slot, so the
 * obvious fear was that alternating workers would each pay a full prefill on every switch.
 * They do not. Six distinct 35k prefixes were all still warm after all six had run — 174 to
 * 196 ms to come back to any of them, against 66–73 s to read one in cold. A role is paid for
 * once per session, not once per call.
 *
 * The two properties that make a worker a worker rather than a function call:
 *
 * - **Its own transcript.** The six steps it spends opening files never land in the caller's
 *   context; only its answer does. That is the whole context argument, and it is why the
 *   answer is clipped on the way back — an unbounded return would put the reading back in.
 * - **Its own `ReadMemory`.** Read memory answers "you already read this, unchanged" instead
 *   of repeating a file, which is right within one worker and wrong across two: a fresh
 *   worker has read nothing, and being told otherwise by somebody else's memory is the fresh
 *   context leaking away through the one door left open. The reviewer learned this first.
 */

/** What a worker is allowed to touch. Read-only sets only, for now — see `ROLES`. */
const READ_TOOLS = ['read_file', 'search_code', 'list_dir', 'find_files', 'symbol_outline'] as const

export interface SubAgentRole {
  /** What the caller names. */
  name: string
  /** One line, shown to the caller in the tool schema so it can pick. */
  purpose: string
  /**
   * Prepended to the task.
   *
   * A brief and NOT a system prompt, deliberately: `Agent` builds message 0 itself, and that
   * message carries the workspace rules and the prompt-injection guard. A worker that opens
   * files needs both exactly as much as the caller does.
   */
  brief: string
  tools: readonly string[]
  mode: AgentMode
  maxSteps: number
}

export const ROLES: readonly SubAgentRole[] = [
  {
    name: 'investigate',
    purpose: 'Answer one question about this codebase by reading it. Read-only.',
    brief:
      'You are answering ONE question about this codebase for someone who cannot see your ' +
      'reading. Open what you need, then answer the question and nothing else.\n\n' +
      'What you write back is all they get — they do not see the files you opened, so do ' +
      'not refer to "the file above". Name paths and line numbers.\n\n' +
      'If the codebase does not answer the question, say that. A confident guess is worse ' +
      'than "not found here": they will act on it and you will not be there to correct it.',
    tools: READ_TOOLS,
    mode: 'plan',
    maxSteps: 8,
  },
  {
    name: 'critique',
    purpose: 'Read a change already made and say what is wrong with it. Read-only.',
    brief:
      'You are looking for what is WRONG with a change someone else just made. Open the ' +
      'files it touched and the ones that use them.\n\n' +
      'Report what you find as specific claims with a path and a line — "this is fine" is ' +
      'an answer, and so is "I could not tell". What is NOT an answer is a defect you ' +
      'noticed and left out because it seemed out of scope: you were not asked about scope, ' +
      'you were asked what is wrong.',
    tools: READ_TOOLS,
    mode: 'plan',
    maxSteps: 8,
  },
]

export const ROLE_NAMES: readonly string[] = ROLES.map((r) => r.name)

/**
 * What comes back. `text` is what the caller reads; everything else is for the window and
 * the log, so a worker's cost is visible rather than folded into the caller's step.
 */
export interface SubAgentOutcome {
  role: string
  text: string
  steps: number
  ms: number
  /** Set when the worker could not finish — a timeout, an abort, a thrown request. */
  problem?: string
}

/** Enough for a real answer with paths and line numbers; short enough that a worker cannot
 * put its whole reading back into the caller's context, which is what it exists to avoid. */
const MAX_ANSWER_CHARS = 4_000

export interface SubAgentDeps {
  client: LlamaClient
  registry: ToolRegistry
  workspace: Workspace
  /** Ceiling on one step's tool results, sized from the window — see the reviewer's note. */
  stepResultBudgetChars?: number
  /**
   * The session's own permission engine, REQUIRED for any role that is not plan-mode.
   *
   * `Agent` gates a tool call only when it has an engine — `if (engine)` in `loop.ts`, and
   * with none there is no gate at all, not a strict one. Today's roles are plan-mode, and
   * plan mode intersects the tool list with the registry's read-only names, so nothing
   * dangerous is even offered and the missing engine cannot bite.
   *
   * That safety lives in the role TABLE, which is a bad place for it: the first role written
   * with `mode: 'normal'` and a write tool would write with no gate, no approval and no
   * rules, and nothing about adding it would look wrong. So `runSubAgent` refuses that
   * combination outright. Passing an engine is what unlocks a worker that can act.
   */
  permissions?: PermissionEngine
}

/**
 * Runs one worker to completion and returns what it concluded.
 *
 * Never throws: a worker that falls over must cost the caller a turn's worth of nothing, not
 * the turn. The caller is told what happened in `problem` and can decide.
 */
export async function runSubAgent(
  deps: SubAgentDeps, role: SubAgentRole, task: string, signal?: AbortSignal,
): Promise<SubAgentOutcome> {
  const started = Date.now()
  // Checked here rather than trusted to the table above. See `SubAgentDeps.permissions`.
  if (role.mode !== 'plan' && deps.permissions === undefined) {
    return {
      role: role.name, text: '', steps: 0, ms: 0,
      problem: `role "${role.name}" is ${role.mode}, not plan — it can act, and a worker ` +
        'that can act needs the permission engine passed to it. Refusing rather than ' +
        'running it ungated.',
    }
  }
  const transcript = new Transcript()
  const options: AgentOptions = {
    client: deps.client,
    registry: deps.registry,
    context: {
      workspace: deps.workspace,
      // Its own, not the caller's. See the note at the top of this file.
      reads: new ReadMemory(),
    },
    transcript,
    mode: role.mode,
    ...(deps.permissions !== undefined ? { permissions: deps.permissions } : {}),
    allowedTools: [...role.tools],
    maxSteps: role.maxSteps,
    // Load-bearing rather than cosmetic: streaming is opt-in on one of these being present,
    // and the step clock measures SILENCE by re-arming on every delta. Without it the
    // first-token budget applies to the whole request, and a worker reading a large file
    // dies on a deadline meant to catch a hung server. The reviewer was the one Agent built
    // without this and it was watched running past ten minutes.
    events: { onTextDelta: () => {} },
    ...(signal ? { signal } : {}),
    ...(deps.stepResultBudgetChars !== undefined
      ? { stepResultBudgetChars: deps.stepResultBudgetChars }
      : {}),
  }

  try {
    const worker = new Agent(options)
    const turn = await worker.runTurn(`${role.brief}\n\n---\n\n${task}`)
    const text = (turn.finalText ?? '').trim()
    return {
      role: role.name,
      text: text === '' ? '(the worker finished without writing an answer)' : clip(text),
      steps: turn.steps,
      ms: Date.now() - started,
      ...(turn.stoppedBecause !== 'done' ? { problem: `stopped: ${turn.stoppedBecause}` } : {}),
    }
  } catch (e) {
    return {
      role: role.name,
      text: '',
      steps: 0,
      ms: Date.now() - started,
      problem: e instanceof Error ? e.message : String(e),
    }
  }
}

function clip(text: string): string {
  if (text.length <= MAX_ANSWER_CHARS) return text
  return `${text.slice(0, MAX_ANSWER_CHARS)}\n… (answer truncated at ${MAX_ANSWER_CHARS} characters)`
}
