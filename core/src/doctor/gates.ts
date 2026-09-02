import { EDITING_TOOL_NAMES, READ_ONLY_TOOL_NAMES } from '../tools/built-in-names.js'
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
  /**
   * Whether anything at all happened AFTER this firing, so `refired` means something.
   *
   * False for the very last firing in a session, which had nothing observed after it. A
   * check that fired and then the file ended did not "pass" — nobody watched. Counting it
   * as satisfied is the flattering guess, and this module's one recurring lesson is that a
   * diagnosis is worth nothing the moment it is confident where it is weakest.
   */
  outcomeKnown: boolean
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
  /**
   * What the model did, CROSS-TABULATED with whether it worked.
   *
   * Two separate lists is what this replaced, and the live model itself is what showed the
   * flaw: given `1 not satisfied` on one line and `words 1, edits 1` on another, it read
   * the report back as "half the time it replied in words, the other half it changed files
   * but apparently didn't get it right" — inverting which answer had worked, and inventing
   * a second failure that the numbers say did not happen. The reader has no way to pair
   * them, so the reader guesses.
   *
   * The tool half of this diagnosis never had that problem: it says "then dropped a leading
   * part of it, WHICH WORKED 3 of 3 times". A move and its verdict belong on one line.
   */
  answers: Partial<Record<GateAnswer, {
    times: number
    /** Firings of this kind answered this way whose outcome was actually observed. */
    observed: number
    satisfied: number
  }>>
}

/**
 * What the model did in one gap between a check and the next turn boundary.
 *
 * Tool names arrive already membership-checked (`safeToolName`), so `unknown-tool` and
 * `mcp-tool` are the only two that are not ours. Neither can be called an edit, which is
 * the conservative direction — an unrecognised tool that did change a file reads as `ran`,
 * understating fixes rather than inventing them — and neither can be called `looked`
 * either, because that word asserts nothing changed.
 */
export function answerFrom(
  steps: number, toolNames: readonly string[], preempted = false,
): GateAnswer {
  if (steps === 0) return preempted ? 'preempted' : 'nothing'
  if (toolNames.length === 0) return 'words-only'
  if (toolNames.some((n) => EDITING_TOOL_NAMES.has(n))) return 'edited'
  // `looked` is a CLAIM that nothing changed, so it is granted only when every tool used is
  // one we ship and declare read-only. Everything else — `Agent`, `sql_deploy`,
  // `background_task`, an MCP tool, a name we do not recognise — did something, and saying
  // so is the conservative direction: it understates how much, never what.
  if (toolNames.every((n) => READ_ONLY_TOOL_NAMES.has(n))) return 'looked'
  return 'ran'
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
    const a = s.answers[e.answer] ?? { times: 0, observed: 0, satisfied: 0 }
    a.times++
    if (e.outcomeKnown) {
      a.observed++
      if (!e.refired) a.satisfied++
    }
    s.answers[e.answer] = a
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
  'compaction-briefing': 'context compacted, history replaced',
  'verify-working': 'build failed while the model worked',
  'verify-unchanged': 'build still failing, errors unchanged',
  'overflow-retry': 'context filled, turn retried',
  continue: 'a step ran out of room and was continued',
  'unattended-nudge': 'an overnight run was told to keep going',
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
  ran: 'did something that may have changed the workspace',
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
export function renderGates(stats: readonly GateStat[], notes = 0): string[] {
  // Neither a note nor a compaction briefing reaches here any more — the walk passes both
  // through without opening a check — so the filter is a belt, and `notes` is counted by
  // the caller. It stays because a kind added to `HarnessKind` and to the pass-through set
  // but not to this filter would otherwise print as a check that took a turn back.
  const handBacks = stats.filter((s) => s.kind !== 'note' && s.kind !== 'compaction-briefing')
  if (handBacks.length === 0 && notes === 0) return []
  const pct = (n: number, of: number): string => (of === 0 ? '0%' : `${Math.round((n / of) * 100)}%`)
  /** Grammar is not decoration here. This page is forwarded as evidence, and "1 times" in
   * the middle of it invites the reader to discount the numbers beside it. */
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  const out: string[] = [
    '',
    'checks and nudges — what handed a turn back, and what the model did with it:',
  ]
  for (const s of handBacks) {
    // Each answer with its own verdict, because the answer alone does not say whether it
    // worked and the two on separate lines get paired wrongly by whoever reads them.
    const answers = Object.entries(s.answers)
      .map(([a, v]) => [a, v ?? { times: 0, observed: 0, satisfied: 0 }] as const)
      .sort((a, b) => b[1].times - a[1].times)
      .map(([a, v]) => `${ANSWER_LABEL[a as GateAnswer] ?? a}: ${v.times}` +
        (v.observed === 0
          ? ', and nothing followed, so whether it worked is not known'
          : `, which satisfied the check ${v.satisfied} of ${v.observed}`))
      .join('\n      ')
    out.push(
      `  ${GATE_LABEL[s.kind].padEnd(34)} ${String(s.fired).padStart(4)} ${s.fired === 1 ? 'time ' : 'times'}` +
      `  ${String(s.refired).padStart(4)} not satisfied (${pct(s.refired, s.fired)})` +
      (s.longestRun > 1 ? `  worst run ${s.longestRun}` : '') +
      `\n      cost ${plural(s.steps, 'model turn')} and ${plural(s.calls, 'tool call')}` +
      (answers === '' ? '' : `\n      ${answers}`),
    )
  }
  if (notes > 0) {
    // Printed even when nothing handed a turn back, which is the healthy case and was
    // previously rendered as no section at all — leaving `harness turns 9` on the summary
    // line with nowhere in the report to see what those nine were.
    out.push(`  (${plural(notes, 'status note')} not counted above: a note is a line, not a hand-back)`)
  }
  return out
}
