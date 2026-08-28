import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { diagnose, renderDiagnosis } from '../doctor/diagnose.js'
import { PRIVATE_DIR } from '../private-dir.js'
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
 * property of the code's shape rather than of its care — every value that is printed as
 * itself is either written in that file or checked for MEMBERSHIP of a set written in it.
 * That distinction is not pedantry: the first version checked those values for the right
 * SHAPE instead, and an adversarial review broke it in one line, because an MCP tool is
 * named after a server in the user's own config and looks exactly like a tool name.
 */
export const doctorTool: Tool<DoctorArgs> = {
  name: 'doctor',
  readOnly: true,
  description:
    'Diagnose this agent from its own history: how many sessions and turns, which tools get ' +
    'called, how often each one fails and what KIND of failure, how much work is exact ' +
    'repetition, which app versions the sessions ran under. Also which CHECKS handed a turn ' +
    'back — a failed build, an unmet contract, a review finding — what the model did about ' +
    'each, whether that satisfied the check, and what the answering cost in turns and calls. ' +
    'Returns counts only — no paths, no commands, no code, no conversation text — so the ' +
    'result is safe to copy out of a confidential machine and send to whoever maintains ' +
    'this. Use it when asked how the agent is doing, what it gets wrong most, whether the ' +
    'checks are worth what they cost, or for a report to hand back.',
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
      // The VALUE is not echoed. It is model output, and this message lands in a transcript
      // that `doctor` itself later reads — quoting an argument back is how a path the model
      // invented gets a second life. Naming the shape is the whole of what helps anyway.
      return { ok: false, error: 'since must be a date written as YYYY-MM-DD' }
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
    const report = renderDiagnosis(d)

    // Written to a FILE as well as returned, and the file is the point.
    //
    // What travels has to be the artifact, not a retelling. The model has the whole
    // conversation in context while it reads this, so a report it paraphrases could pick up
    // a detail from anywhere — and "do not add anything" is an instruction, which this
    // project has measured at 0 for 703. A file the person attaches is structure: whatever
    // the model says about it afterwards, the thing that leaves the machine is this text.
    let written: string | null = join(PRIVATE_DIR, 'diagnosis.md')
    try {
      writeFileSync(join(root, written), `${report}
`, 'utf8')
    } catch {
      // Not fatal, and not silent. The report in the reply is still complete and still safe;
      // only the convenience of having it as a file is lost.
      written = null
    }

    return {
      ok: true,
      content: written === null
        ? `${report}

(the report could not be written to a file, so copy it from here)`
        : `${report}

Saved to ${written} — send that file. It is the whole report, and ` +
          'it contains nothing that is not above.',
    }
  },
}
