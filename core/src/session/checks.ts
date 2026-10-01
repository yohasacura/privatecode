import { extname } from 'node:path'

/**
 * What the harness does by itself around a turn, decided in one place.
 *
 * Every mechanism here is something the model did not ask for: a forced generation before it
 * starts, a note injected between its steps, a build it did not run, a fix round it was handed.
 * Each one was built for a measured failure and each one is right on the task it was built
 * for. The owner's verdict from daily use (2026-10-01) is that, together and by default, they
 * cost more than they catch: they drag a small model off its own line of work and it starts
 * making mistakes — and on work that is not code at all (a letter, an explanation) they had
 * nothing to check and ran anyway, reading through the project for a task about none of it.
 *
 * So the default is freedom: the model works the way Claude Code's does, with its tools and
 * its prompt, and nothing checks by itself. `/check` and `/review` run the checks on demand.
 * Turning the checks ON for a session (the composer switch, or `"checks": "on"` in
 * settings.json) runs what the `"gates"` profile names — and only around CODE: a turn that
 * wrote prose, or a request the contract distiller judged to change no code, is left alone.
 *
 * The conditions used to be scattered through `session.ts` as a dozen separate tests of the
 * profile and the switch, and they had drifted: with the checks off, the plan nudges still
 * fired, the contract still distilled and was still folded into the request, and a turn that
 * wrote nothing but ended "done" still opened the audit and its fix rounds. One table, read
 * everywhere, is what keeps "off" meaning off.
 */

/**
 * How much the checks run, when they are on.
 *
 * Measured on 2026-09-02 (docs/SPEED-2026-09-02.md), every one a forced generation:
 *
 *   contract   10–14 s   premises  12–13 s   lenses  15–17 s   acceptance  24–25 s
 *
 *   thorough — everything: contract, plan, premises, lenses, build, audit, fresh reviewer.
 *   fast     — the lean contract and the audit, which are what hold a task to its goal and
 *              catch "done" said early, plus the build; no premises, lenses, reviewer or plan
 *              nudges.
 *   off      — no contract at all, so no audit or review either: only the build.
 *
 * A judgement about the person's own time, so it lives in settings.json (`"gates"`), most
 * specific layer wins; absent means thorough.
 */
export type GateProfile = 'thorough' | 'fast' | 'off'

export interface ChecksPolicy {
  /** Distil a task-shaped request into a contract, fold it into the request and seed the
   * plan from it. Everything below that needs a contract needs this. */
  contract: boolean
  /** The smaller contract: a goal and at most four criteria. */
  leanContract: boolean
  /** A big task's plan is decomposed by its own forced generation instead of being the
   * criteria verbatim. */
  decompose: boolean
  /** The plan-focus and plan-upkeep notes between steps. */
  planNudges: boolean
  /** The premise check and the understanding lenses, at the first write of code. */
  firstWrite: boolean
  /** The compiler check and the project's verify command right after a step that edited
   * code. */
  buildAfterEdit: boolean
  /** The verify command when a turn that changed code ends, with its fix rounds. */
  buildAtEnd: boolean
  /** The acceptance audit against the contract, with its fix rounds. */
  audit: boolean
  /** Audit every turn that wrote code, not only one that looks finished. */
  auditOnWrite: boolean
  /** The fresh-context reviewer, by itself. `/review` runs it whatever this says. */
  review: boolean
}

const NOTHING: ChecksPolicy = {
  contract: false, leanContract: false, decompose: false, planNudges: false, firstWrite: false,
  buildAfterEdit: false, buildAtEnd: false, audit: false, auditOnWrite: false, review: false,
}

export function checksPolicy(on: boolean, profile: GateProfile): ChecksPolicy {
  if (!on) return NOTHING
  switch (profile) {
    case 'thorough':
      return {
        contract: true, leanContract: false, decompose: true, planNudges: true, firstWrite: true,
        buildAfterEdit: true, buildAtEnd: true, audit: true, auditOnWrite: false, review: true,
      }
    case 'fast':
      return {
        ...NOTHING, contract: true, leanContract: true,
        buildAfterEdit: true, buildAtEnd: true, audit: true, auditOnWrite: true,
      }
    case 'off':
      return { ...NOTHING, buildAfterEdit: true, buildAtEnd: true }
  }
}

/**
 * Files a person reads rather than a build compiles. Writing one cannot break the build, and
 * a check that runs because one was written is the "составь письмо → dotnet build" failure.
 *
 * Deliberately short. A file that is not on it counts as code, because a check skipped by
 * mistake is invisible and one run by mistake costs seconds: `.json` and `.yaml` can break a
 * build, `.html` and `.mdx` are compiled, and a `.csv` is often a test fixture.
 */
const PROSE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.text', '.rst', '.adoc', '.asciidoc', '.org', '.rtf',
  '.eml', '.msg', '.doc', '.docx', '.odt', '.pptx', '.xlsx', '.pdf',
])

/**
 * Whether writing `path` is a change to code, the only kind of change the checks are about.
 *
 * Takes any spelling a tool argument or a result can carry — relative, absolute, either slash
 * — and answers from the name alone, so it costs nothing on the path every write takes.
 * PrivateCode's own folder is never code: a skill, a command or a settings file written there
 * configures the agent and builds nothing.
 */
export function isCodePath(path: string): boolean {
  const normalised = path.replace(/\\/g, '/')
  if (/(^|\/)\.privatecode\//.test(normalised)) return false
  return !PROSE_EXTENSIONS.has(extname(normalised).toLowerCase())
}
