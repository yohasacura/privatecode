import { ROLES, type SubAgentRole } from '../agent/subagent.js'
import type { ApprovalPreview, PermissionKey, Tool } from './types.js'

export interface DelegateArgs {
  role: string
  task: string
}

/**
 * Hand one narrow job to a worker with its own short conversation.
 *
 * Two things are bought here, and only one of them is speed.
 *
 * The obvious one: `spike/narrow-agent-probe.mts` put the same planted defect to the wide
 * reviewer and to a narrow question — 114.4 s, 50.0 s, 69.3 s against 4.8 s, 6.0 s, 3.6 s,
 * both right 3/3. Sixteen times cheaper for the same answer.
 *
 * The one that matters more on a long task: the worker's reading does not land here. Six
 * steps of opened files stay in ITS transcript and the caller gets an answer, which is what
 * keeps a session that has answered forty questions from carrying forty files.
 *
 * Roles are an ENUM rather than a free-form description of a helper, and that is this
 * project's law rather than taste: instructions do not route behaviour on this model,
 * structure does (docs/SPIKE-KAT-CODER.md, 0/703). A caller choosing from a closed list is
 * choosing something the harness can check; a caller writing a brief for an improvised
 * assistant is writing prose nobody validates.
 *
 * The list is built per workspace: the three built-in roles, plus every agent an enabled
 * plugin ships (`agents/<name>.md`, named `plugin:name`) and every `.claude/agents/` file —
 * see `plugins/agents.ts`. `createDelegateTool` is what the host registers; `delegateTool`
 * is the built-in list alone, for the toolset's default and for tests.
 */
export function createDelegateTool(roles: readonly SubAgentRole[]): Tool<DelegateArgs> {
  const names = roles.map((r) => r.name)
  return {
    name: 'Agent',
    // Read-only in effect for the built-in roles, but declared false so the permission gate
    // is asked. That is deliberate: a delegate call spends a generation and several tool
    // calls, and a mode that asks before spending should get to — and a plugin's agent may
    // well write.
    readOnly: false,
    description:
      'Hand one narrow, self-contained job to a worker that has its own short conversation ' +
      'and reports back. Use it when answering something would take several reads that you ' +
      'do not need to keep — the worker does the reading, you get the answer. It cannot see ' +
      'this conversation, so the task has to stand on its own.',
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: [...names],
          description: roles.map((r) => `${r.name}: ${r.purpose}`).join(' '),
        },
        task: {
          type: 'string',
          description:
            'The whole job, in a few sentences. The worker sees this and the workspace, and ' +
            'nothing else — no history, no contract, no earlier answers — so name the files, ' +
            'symbols or behaviour you mean rather than referring back to anything here.',
        },
      },
      required: ['role', 'task'],
    },
    validate(raw) {
      const r = raw as Partial<DelegateArgs>
      if (typeof r?.role !== 'string' || !names.includes(r.role)) {
        return { ok: false, error: `role must be one of: ${names.join(', ')}` }
      }
      if (typeof r?.task !== 'string' || r.task.trim() === '') {
        return { ok: false, error: 'task must be a non-empty description of the job' }
      }
      // A task shorter than this cannot be self-contained, and a worker that has to guess what
      // was meant spends its whole budget guessing. Cheaper to say so now.
      if (r.task.trim().length < 24) {
        return {
          ok: false,
          error: 'task is too short to stand on its own — the worker cannot see this ' +
            'conversation, so say which files, symbols or behaviour you mean',
        }
      }
      return { ok: true, args: { role: r.role, task: r.task.trim() } }
    },
    permissionKey(args): PermissionKey {
      return { tool: 'Agent', command: `${args.role}: ${args.task.slice(0, 120)}` }
    },
    approvalPreview(args): ApprovalPreview {
      const oneLine = args.task.replace(/\s+/g, ' ').trim()
      const role = roles.find((r) => r.name === args.role)
      const kind = role?.tools !== undefined && role.mode === 'plan' ? 'a read-only' : 'a'
      return {
        summary: `${args.role}: ${oneLine.length > 64 ? `${oneLine.slice(0, 61)}...` : oneLine}`,
        detail: `Run ${kind} ${args.role} worker on:\n${args.task}`,
      }
    },
    async execute(args, ctx) {
      // Absent for every host that has no model to run one with — the one-shot CLI, most
      // tests. Said plainly rather than thrown: the caller can do the reading itself.
      if (ctx.delegate === undefined) {
        return { ok: false, content: 'No worker is available here; do the reading yourself.' }
      }
      const outcome = await ctx.delegate(args.role, args.task, ctx.signal)
      const cost = `[${outcome.role}: ${outcome.steps} steps, ${(outcome.ms / 1000).toFixed(1)}s]`
      if (outcome.problem !== undefined && outcome.text === '') {
        return { ok: false, content: `${cost} the worker could not finish: ${outcome.problem}` }
      }
      // A worker that stopped early still read something, and what it got to is worth more
      // than nothing — labelled, so a partial answer is never mistaken for a complete one.
      const caveat = outcome.problem !== undefined
        ? `\n\n(incomplete — ${outcome.problem}; treat this as partial)`
        : ''
      return { ok: true, content: `${cost}\n${outcome.text}${caveat}` }
    },
  }
}

/** The built-in roles alone. */
export const delegateTool: Tool<DelegateArgs> = createDelegateTool(ROLES)
