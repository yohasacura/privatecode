import { EDITING_TOOL_NAMES } from '../tools/built-in-names.js'
import type { HarnessKind } from '../host/replay.js'

/**
 * The checks, as an actor that can be diagnosed.
 *
 * A gate is not a feature of the transcript, it is a PARTICIPANT in it: it takes a turn, it
 * costs steps, and the model answers it. The tool half of this diagnosis already treats the
 * model that way — an attempt, a failure, a next move, a verdict on the next move — and a
 * gate deserves exactly the same reading, for a reason that is about money. A tool call that
 * fails costs one call. A gate that hands the turn back costs a whole turn of generation,
 * against the prompt, with the whole context, and it does it on work the person already
 * thought was finished.
 *
 * ============================================================================
 * WHAT IS COUNTED, AND WHY EACH ONE
 * ============================================================================
 *
 * WHICH gate. `harnessMessages` was one lump number and could not distinguish "the build
 * failed nine times" from "nine status lines were printed". The kind comes from
 * `splitUserMessage`, matched against the constants the harness itself writes.
 *
 * WHAT THE MODEL DID ABOUT IT. The answer to a gate is everything the model did before the
 * next turn boundary, in five categories. `words-only` is the one to read first: a gate hands
 * back a build log and the model replies with prose and no tool call at all. This project has
 * that failure named already — the agent loop ships a `TALKED_INSTEAD_OF_ACTING` nudge for
 * it — and a count of it PER GATE says which check the model argues with rather than obeys.
 *
 * WHETHER IT WORKED. If the same gate fires again before the person speaks, the answer did
 * not satisfy it. Runs of that are the expensive failure and the one nobody sees: the person
 * sent one message and the machine took six turns over it.
 *
 * WHAT IT COST. Assistant turns and tool calls spent answering each gate. This is the number
 * that turns "the gates feel slow" into a share of the work.
 *
 * ============================================================================
 * PRIVACY
 * ============================================================================
 *
 * Nothing in this module reads text. It is handed a `HarnessKind` — a literal union — and
 * tool NAMES that the caller has already checked for membership of the shipped set. There is
 * no expression here whose type could carry a fragment of a build log, a criterion, a
 * reviewer's finding or a path, which is the same guarantee the rest of the doctor rests on,
 * obtained the same way: by never being given the material in the first place.
 */

/**
 * What the model did with a turn a check handed back to it.
 *
 * Ordered by how much it did, and the order is the finding — `edited` at one end is the model
 * taking the check seriously, `words-only` at the other is the model explaining itself to a
 * build log.
 */
export type GateAnswer =
  /** It changed files. The check was treated as a thing to fix. */
  | 'edited'
  /** It ran something but changed no file — re-running the build, looking at the failure. */
  | 'ran'
  /** Read-only tools only: it went and looked, and changed nothing. */
  | 'looked'
  /** No tool call at all. It replied in prose to a machine. */
  | 'words-only'
  /** Nothing followed: the session ended, or the person cut in. */
  | 'nothing'
  /** Another check spoke before the model got a turn — the chain moved on, or a compaction
   * retry replaced the turn. Told apart from `nothing` deliberately: `nothing` reads as the
   * model or the person abandoning the check, which is a strong claim and would be a wrong
   * one here. */
  | 'preempted'

/** One firing of one check, with what came of it. Every field is a category or a count. */
export interface GateEvent {
  kind: HarnessKind
  answer: GateAnswer
  /** The same check fired again before the person's next message. */
  refired: boolean
  /** Where this firing sat in an unbroken run of the same check — 1 for the first. */
  round: number
  /** Assistant turns spent answering it. */
  steps: number
  /** Tool calls spent answering it. */
  calls: number
}

/** One check's record over all the history that was read. */
export interface GateStat {
  kind: HarnessKind
  fired: number
  /** Firings the model's answer did not satisfy — it fired again before the person spoke. */
  refired: number
  /** The worst unbroken run within a single person-turn. `1` means it never repeated. */
  longestRun: number
  /** Model turns and tool calls spent answering this check. */
  steps: number
  calls: number
  answers: Partial<Record<GateAnswer, number>>
}

/**
 * What the model did in one gap between a check and the next turn boundary.
 *
 * Tool names arrive already membership-checked (`safeToolName`), so `unknown-tool` and
 * `mcp-tool` are the only two that are not ours — both count as work done, neither can be
 * called an edit, which is the conservative direction: an unrecognised tool that did change
 * a file will read as `ran`, understating fixes rather than inventing them.
 */
export function answerFrom(
  steps: number, toolNames: readonly string[], preempted = false,
): GateAnswer {
  if (steps === 0) return preempted ? 'preempted' : 'nothing'
  if (toolNames.length === 0) return 'words-only'
  if (toolNames.some((n) => EDITING_TOOL_NAMES.has(n))) return 'edited'
  if (toolNames.includes('run_command')) return 'ran'
  return 'looked'
}

/** Rolls the events of every session into one record per check. */
export function gateStatsFrom(events: readonly GateEvent[]): GateStat[] {
  const by = new Map<HarnessKind, GateStat>()
  for (const e of events) {
    const s = by.get(e.kind)
      ?? { kind: e.kind, fired: 0, refired: 0, longestRun: 0, steps: 0, calls: 0, answers: {} }
    s.fired++
    if (e.refired) s.refired++
    s.longestRun = Math.max(s.longestRun, e.round)
    s.steps += e.steps
    s.calls += e.calls
    s.answers[e.answer] = (s.answers[e.answer] ?? 0) + 1
    by.set(e.kind, s)
  }
  return [...by.values()].sort((a, b) => b.fired - a.fired)
}

/** What each check is, in words a person who has never read this code can act on. */
const GATE_LABEL: Record<HarnessKind, string> = {
  acceptance: 'contract not met',
  review: 'diff review found problems',
  premises: 'premise check refused the turn',
  verify: 'build or tests failed',
  'verify-broken': 'verification could not run',
  'verify-working': 'build failed while the model worked',
  'verify-unchanged': 'build still failing, errors unchanged',
  'overflow-retry': 'context filled, turn retried',
  continue: 'nudged to keep going',
  truncation: 'output truncated twice',
  'talked-not-acted': 'talked instead of acting',
  'step-timeout': 'step hit its time limit',
  'max-steps': 'turn stopped at the step limit',
  undone: 'a change was undone',
  note: 'status note',
  'other-harness': 'harness message of an unrecognised kind',
}

const ANSWER_LABEL: Record<GateAnswer, string> = {
  edited: 'changed files',
  ran: 'ran something',
  looked: 'only looked',
  'words-only': 'replied in words, called nothing',
  nothing: 'did not reply',
  preempted: 'another check spoke first',
}

/**
 * The checks as a block of the report.
 *
 * Notes are excluded from the hand-back table and counted on their own line. They are
 * harness turns and they are not hand-backs, and mixing them in was the flaw in the single
 * `harnessMessages` number this section replaces: a healthy session prints plenty of notes,
 * and a report where those inflate the gate count says the checking is expensive when it is
 * not.
 */
export function renderGates(stats: readonly GateStat[]): string[] {
  const handBacks = stats.filter((s) => s.kind !== 'note')
  if (handBacks.length === 0) return []
  const pct = (n: number, of: number): string => (of === 0 ? '0%' : `${Math.round((n / of) * 100)}%`)
  /** Grammar is not decoration here. This page is forwarded as evidence, and "1 times" in
   * the middle of it invites the reader to discount the numbers beside it. */
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  const out: string[] = [
    '',
    'checks and nudges — what handed a turn back, and what the model did with it:',
  ]
  for (const s of handBacks) {
    const answers = Object.entries(s.answers).map(([a, n]) => [a, n ?? 0] as const)
      .sort((a, b) => b[1] - a[1])
      .map(([a, n]) => `${ANSWER_LABEL[a as GateAnswer] ?? a} ${n}`)
      .join(', ')
    out.push(
      `  ${GATE_LABEL[s.kind].padEnd(34)} ${String(s.fired).padStart(4)} ${s.fired === 1 ? 'time ' : 'times'}` +
      `  ${String(s.refired).padStart(4)} not satisfied (${pct(s.refired, s.fired)})` +
      (s.longestRun > 1 ? `  worst run ${s.longestRun}` : '') +
      `\n      cost ${plural(s.steps, 'model turn')} and ${plural(s.calls, 'tool call')}` +
      (answers === '' ? '' : `\n      ${answers}`),
    )
  }
  const notes = stats.find((s) => s.kind === 'note')
  if (notes !== undefined) {
    out.push(`  (${plural(notes.fired, 'status note')} not counted above: a note is a line, not a hand-back)`)
  }
  return out
}
