import { classify, type FailureKind } from './diagnose.js'
import { nextMoveBetween, subjectsOf, type NextMove, type SubjectKind } from './behaviour.js'

/**
 * A failure, what was done about it, and whether that worked.
 *
 * The counting layer says `not-found: 9`. This layer says *the model asked for something it
 * had never been shown, then dropped a leading part of it, and that worked seven times out
 * of nine* — which is a cause, an attempted cure, and a verdict on the cure. Every one of
 * those three is a category; none of them is a value.
 *
 * ============================================================================
 * WHAT AN EPISODE IS
 * ============================================================================
 *
 * One failure and the next attempt at the same thing, seen as a pair:
 *
 *     attempt -> FAILED (a category)   [the subject: what kind, what shape, ever seen?]
 *     attempt -> the next move (a category)
 *             -> worked, or did not
 *
 * Reading them in pairs rather than one at a time is the whole point. A failure alone says a
 * mistake happened; a failure with its next move says what the model THOUGHT the mistake was,
 * and the outcome says whether it was right. Those three together are what a person means
 * by "diagnose it", and they are all derivable without a single quoted character.
 *
 * PROVENANCE is the sharpest of them and the cheapest. Before blaming a tool's description
 * or a schema, ask whether the value the model used had ever appeared in anything the model
 * was shown. If it had not, the model invented it, and no amount of describing the tool
 * better will help — the fix is upstream, in what it was given to work from. That question
 * is answered by a substring search over earlier results, ON THIS MACHINE, and reported as
 * a boolean.
 */

/** One failure with its sequel. Every field is a category, a boolean or a count. */
export interface Episode {
  /** The tool or gate. Membership-checked by the caller before it gets here. */
  what: string
  failure: FailureKind
  /** What kind of thing the failing argument was — a location, a pattern, a command. */
  subject: SubjectKind | 'none'
  /** Had that value ever appeared in something the actor was shown earlier in the session?
   * `null` when there was no subject to ask about. */
  invented: boolean | null
  nextMove: NextMove
  /** Whether the attempt after that move succeeded. */
  fixed: boolean
}

/** One attempt as the episode builder needs it. Values live here and are never reported. */
export interface RawAttempt {
  what: string
  args: string
  ok: boolean
  /** The result text, for classifying. Read, never kept. */
  result: string
}

/** How much earlier output to keep for the provenance question. A session's results can run
 * to megabytes and the question only needs recent memory — a value the model saw forty
 * calls ago it has arguably forgotten too. */
const PROVENANCE_WINDOW = 400_000

/**
 * Turns a session's attempts into episodes.
 *
 * `shown` accumulates what the actor has been given: the text of every result it has seen.
 * The provenance question is asked against that, before the current result joins it — a
 * value that appears in the failure message it caused would otherwise always look "seen".
 */
export function episodesFrom(attempts: readonly RawAttempt[]): Episode[] {
  const episodes: Episode[] = []
  let shown = ''

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i] as RawAttempt
    if (a.ok) {
      shown = `${shown}\n${a.result}`.slice(-PROVENANCE_WINDOW)
      continue
    }

    const failure = classify(a.result)
    const subjects = subjectsOf(a.args)
    // The FIRST subject is the one blamed. A call has at most a couple, and the leading one
    // is what the tool is about — `path` for a read, `command` for a run. Blaming all of
    // them would double-count one mistake.
    const subject = subjects[0]

    // Asked only where the answer MEANS something.
    //
    // A command is always "invented" — the model composes it, it was never in a result — and
    // so is a regex, and so is a file it is writing. Reporting those as invented was measured
    // on a demo run and it drowned the one case where the word carries weight: a LOCATION or
    // a NAME could have been observed, so choosing one that never was is the model working
    // from nothing, and no rewrite of a tool description touches it.
    //
    // Asked before this result joins `shown`, or the value would be found inside the very
    // message complaining about it.
    const observable = subject !== undefined
      && (subject.kind === 'location' || subject.kind === 'name')
    const invented = observable && subject !== undefined
      ? !shown.includes(subject.value)
      : null

    const next = attempts[i + 1]
    let nextMove: NextMove
    let fixed = false
    if (next === undefined) {
      nextMove = 'gave-up'
    } else if (next.what !== a.what) {
      nextMove = 'switched-tool'
      fixed = next.ok
    } else {
      const nextSubject = subjectsOf(next.args)[0]
      nextMove = subject !== undefined && nextSubject !== undefined
        ? nextMoveBetween(subject.value, nextSubject.value, subject.kind)
        : (a.args === next.args ? 'retried-identically' : 'changed-keys')
      fixed = next.ok
    }

    episodes.push({
      what: a.what,
      failure,
      subject: subject?.kind ?? 'none',
      invented,
      nextMove,
      fixed,
    })
    shown = `${shown}\n${a.result}`.slice(-PROVENANCE_WINDOW)
  }
  return episodes
}

/** One recurring story, with how often it happens and how often the model's own next
 * move worked. Nothing here repairs anything — this is a description of what happened. */
export interface Pattern {
  what: string
  failure: FailureKind
  subject: SubjectKind | 'none'
  nextMove: NextMove
  times: number
  fixed: number
  /** How many of these failures used a value that had never been shown to the actor. */
  invented: number
}

/** Groups episodes into the stories worth telling, most frequent first. */
export function patternsOf(episodes: readonly Episode[]): Pattern[] {
  const by = new Map<string, Pattern>()
  for (const e of episodes) {
    const key = `${e.what}|${e.failure}|${e.subject}|${e.nextMove}`
    const p = by.get(key)
      ?? { what: e.what, failure: e.failure, subject: e.subject, nextMove: e.nextMove, times: 0, fixed: 0, invented: 0 }
    p.times++
    if (e.fixed) p.fixed++
    if (e.invented === true) p.invented++
    by.set(key, p)
  }
  return [...by.values()].sort((a, b) => b.times - a.times)
}

/**
 * The patterns as sentences.
 *
 * Assembled from fragments written HERE and numbers counted from the episodes — the same
 * rule the rest of the diagnosis follows, applied to prose. A sentence is more persuasive
 * than a table and that is exactly why it must be built the same way: the temptation to
 * quote the offending value is strongest at the moment you are explaining it.
 */
export function renderPatterns(patterns: readonly Pattern[], min = 2): string[] {
  const SUBJECT: Record<string, string> = {
    location: 'a place in the workspace',
    pattern: 'something to match with',
    command: 'a command line',
    name: 'a name to resolve',
    content: 'text being written',
    choice: 'a choice from a fixed set',
    other: 'an argument',
    none: 'nothing this analysis could name',
  }
  const NEXT_MOVE: Record<NextMove, string> = {
    'retried-identically': 'tried the exact same thing again',
    narrowed: 'dropped a leading part of it',
    broadened: 'added a leading part to it',
    rejoined: 'kept the same parts and joined them differently',
    'changed-operator': 'changed the shell operator',
    'changed-keys': 'sent different arguments',
    'guessed-again': 'tried something unrelated',
    'switched-tool': 'used a different tool instead',
    'gave-up': 'did not try again',
  }

  const out: string[] = []
  for (const p of patterns) {
    if (p.times < min) continue
    const worked = p.nextMove === 'gave-up'
      ? ''
      : `, which worked ${p.fixed} of ${p.times} times`
    const guessed = p.invented > 0
      ? `\n      in ${p.invented} of ${p.times}, the value had never appeared in anything it had been shown` +
        ' — it was invented, so a better tool description would not have helped'
      : ''
    out.push(
      `  ${p.what} · ${p.failure} on ${SUBJECT[p.subject] ?? 'an argument'} — ${p.times} times` +
      `\n      then ${NEXT_MOVE[p.nextMove]}${worked}${guessed}`,
    )
  }
  return out
}
