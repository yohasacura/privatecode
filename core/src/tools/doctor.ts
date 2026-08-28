import { diagnose, renderDiagnosis } from '../doctor/diagnose.js'
import { SessionStore } from '../session/store.js'
import type { Tool } from './types.js'

export interface DoctorArgs {
  since?: string
}

/**
 * The agent measuring itself, in a form that can leave the machine.
 *
 * The work that would teach us most is the work nobody can show us: real sessions on a real
 * codebase, under NDA, on a laptop whose logs cannot be sent anywhere. This closes that gap
 * from the other side — the agent reads its own history where the history already is, and
 * only counts come out.
 *
 * Everything about how that stays safe is in `doctor/diagnose.ts`, and it is worth reading
 * before trusting this: the report is built only from numbers and from a closed set of
 * category names declared in that file, so there is no code path by which a path, a command,
 * a line of code or a sentence of anybody's conversation could appear in it. That is a
 * property of the types, not a promise about behaviour, which is what makes "send it as it
 * is" a sentence anybody can act on without auditing the output first.
 */
export const doctorTool: Tool<DoctorArgs> = {
  name: 'doctor',
  readOnly: true,
  description:
    'Diagnose this agent from its own history: how many sessions and turns, which tools get ' +
    'called, how often each one fails and what KIND of failure, how much work is exact ' +
    'repetition, which app versions the sessions ran under. Returns counts only — no paths, ' +
    'no commands, no code, no conversation text — so the result is safe to copy out of a ' +
    'confidential machine and send to whoever maintains this. Use it when asked how the ' +
    'agent is doing, what it gets wrong most, or for a report to hand back.',
  parameters: {
    type: 'object',
    properties: {
      since: {
        type: 'string',
        description:
          'Only sessions last touched on or after this date, as YYYY-MM-DD. Leave it out ' +
          'for everything on this machine.',
      },
    },
    required: [],
  },
  validate(raw) {
    const r = raw as Partial<DoctorArgs>
    if (r?.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(r.since)) {
      // Rejected rather than ignored: a misspelled date compares as a plain string against
      // an ISO timestamp and would silently narrow the scan to nothing, which reads as a
      // healthy agent with no history.
      return { ok: false, error: `since must be a date as YYYY-MM-DD, not "${String(r.since)}"` }
    }
    return { ok: true, args: r?.since !== undefined ? { since: r.since } : {} }
  },
  async execute(args, ctx) {
    const root = ctx.workspace.root
    const all = new SessionStore(root).list()
    const metas = args.since === undefined
      ? all
      : all.filter((m) => m.updatedAt >= `${args.since}T00:00:00.000Z`)

    if (metas.length === 0) {
      return {
        ok: true,
        content: args.since === undefined
          ? 'There are no stored sessions in this workspace to diagnose.'
          : `No sessions in this workspace were touched on or after ${args.since}.`,
      }
    }

    const d = diagnose(root, metas)
    if (d.sessions === 0) {
      // Metas exist but no transcript did. Worth saying plainly rather than rendering a
      // report of zeroes that reads as "this agent has done nothing wrong".
      return {
        ok: true,
        content: `${metas.length} sessions are listed but none has a transcript on disk, so ` +
          'there is nothing to measure.',
      }
    }
    return { ok: true, content: renderDiagnosis(d) }
  },
}
