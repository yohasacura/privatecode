import { readFileSync } from 'node:fs'
import { statePath } from '../private-dir.js'
import { splitUserMessage } from '../host/replay.js'
import { COMPACTION_ACK_TEXT, COMPACTION_BRIEFING_PREFIX } from '../session/compaction.js'
import { PREMISE_FAILURE_PREFIX } from '../session/premises.js'
import { BUILT_IN_TOOL_NAMES, MCP_TOOL_PREFIX } from '../tools/built-in-names.js'
import { episodesFrom, patternsOf, renderPatterns, type Episode, type RawAttempt } from './episodes.js'
import { answerFrom, gateStatsFrom, renderGates, type GateEvent } from './gates.js'
import type { SessionMeta } from '../session/store.js'

/**
 * What this agent has actually been doing, as numbers that can leave the machine.
 *
 * The problem it exists for: the work that would teach us most is the work we can never
 * see. Real sessions on a real codebase, under NDA, on somebody else's laptop — the logs
 * cannot be sent and nobody is going to summarise a week of them by hand. So the agent
 * measures itself where the data already is, and only a diagnosis travels.
 *
 * ============================================================================
 * THE ONE RULE, AND HOW IT IS ENFORCED
 * ============================================================================
 *
 * **No text from a transcript may reach the output.** Not clipped, not redacted, not
 * "probably fine" — none. A report is worthless if it has to be reviewed before sending,
 * because the whole point is that it can be sent without a review.
 *
 * That is not a promise here, it is the shape of the code. Every printed string is either
 * WRITTEN in this file, or checked for MEMBERSHIP of a set written in this file. Nothing is
 * printed because it looked right. `classify` is the only function that ever sees transcript
 * text and its return type is a twelve-value literal union, so there is no expression here
 * whose type would let a fragment of somebody's code, prose, path or command be carried out.
 *
 * The membership-not-shape rule was learned the hard way and is the thing to keep in front
 * of whoever edits this. The first version checked the disk-sourced strings for the right
 * SHAPE — a tool name looking like `[a-z][a-z0-9_]*`, a version looking like a version — and
 * an adversarial review broke both in one line each. A tool name comes off the TRANSCRIPT,
 * which stores model output before the registry is ever consulted, so a hallucinated name
 * naming the codebase is on disk and passes. And an MCP tool is called
 * `mcp__<server>__<tool>`, where the server is a key out of the user's own config — so the
 * ordinary path, on a correctly configured machine, with nothing tampered with, printed a
 * client's name. Shape admits anything shaped right. Membership admits what we shipped.
 *
 * The things deliberately NOT read at all, though they sit right beside what is:
 *   - `SessionMeta.title`, which is the user's own first message
 *   - `SessionMeta.workspaceRoot`, which is a path on their disk
 *   - every `content` field, except inside `classify`
 *   - tool ARGUMENTS, except their length and a hash used only to spot exact repeats
 */

/**
 * Why a tool call failed, as a category rather than as a message.
 *
 * A closed list on purpose. The categories come from failures this project has actually
 * watched happen, and the last one is the honest bucket — a rising `other` is itself the
 * finding that this list needs another entry.
 */
export type FailureKind =
  /** The path or symbol was not there. */
  | 'not-found'
  /** Refused for leaving the workspace. */
  | 'outside-workspace'
  /** The permission engine said no, or the person did. */
  | 'denied'
  /** Malformed arguments: a bad glob, an unparseable regex, invalid JSON. */
  | 'bad-arguments'
  /** Refused for size — too large to read, too much output. */
  | 'too-large'
  /** A command or a step ran out of time. */
  | 'timeout'
  /** PowerShell parse failure, almost always `&&` or `||` where `;` was needed. This one
   * has its own category because it is a MODEL habit rather than a workspace fact, and it
   * is the kind of thing a prompt or a schema can fix. */
  | 'shell-operator'
  /** A command ran and exited non-zero. The workspace's own failure, not the agent's. */
  | 'command-failed'
  /** Binary, or an encoding the tool will not put in context. */
  | 'not-text'
  /** The capability is not present here — no browser, no database, no worker. */
  | 'unavailable'
  /** The tool refused because the model was told to do something else instead. */
  | 'wrong-tool'
  /**
   * The premise check vetoed the call: the model was about to act on something it claimed
   * was in the files and was not.
   *
   * Its own category because it is the only failure here that is a GATE speaking through a
   * tool result. An audit found it landing in `other` — the veto's first line matches none
   * of the buckets above — so the check with the strongest claim to being worth its cost
   * was invisible in the report, and `other` rose without anybody knowing why.
   */
  | 'unverified-premise'
  | 'other'

/**
 * Text in, category out. The only function in this module that reads transcript content,
 * and it cannot return any of it.
 *
 * Ordered most specific first, because several of these overlap: a PowerShell parse error
 * is also a failed command, and "file not found" is also just an error.
 */
export function classify(text: string): FailureKind {
  // The FIRST LINE only, and this is not tidiness.
  //
  // Our failure messages lead with the reason and then quote what went wrong — a near-miss
  // window out of the file, the path, the command, the user's own declined-with-a-comment.
  // Substring-matching the whole thing therefore lets the USER'S CONTENT steer the
  // classification: an inventory measured `search_text was not found…` returning `not-found`
  // normally and `denied` when the quoted window happened to contain the word "permission".
  // That is not a leak — the return type still cannot carry text — but it makes the counts
  // noise, which is worse than useless in a document somebody forwards as evidence. The
  // diagnosis is in the first line; the evidence comes after it.
  const t = (text.split('\n')[0] ?? '').slice(0, 300).toLowerCase()
  // Before `denied` and before `not-found`, both of which it falls into once it is
  // recognised at all. Matched on the gate's own exported constant rather than on a copy of
  // its wording, so rewording the veto cannot quietly return it to `other`.
  if (t.startsWith(PREMISE_FAILURE_PREFIX.toLowerCase())) return 'unverified-premise'
  if (t.includes('token \'&&\'') || t.includes("token '&&'") || t.includes('is not a valid statement separator')
    || (t.includes('&&') && t.includes('parsererror'))) return 'shell-operator'
  // `escapes the workspace` and `resolves outside` are what `Workspace` actually says
  // (`workspace.ts:315`, `:402`, `:416`); without them this category was structurally
  // unreachable for all four write tools, and every jail violation counted as `other`.
  if (t.includes('outside the workspace') || t.includes('not inside this workspace')
    || t.includes('must stay inside') || t.includes('escapes the workspace')
    || t.includes('resolves outside')) return 'outside-workspace'
  // `attached read-only` is a refusal that named neither denial nor permission, so it fell
  // through to `other` — a whole class of "the model wrote where it may not" made invisible.
  if (t.includes('denied') || t.includes('not allowed') || t.includes('refused by the user')
    || t.includes('permission') || t.includes('attached read-only')
    || t.includes('read-only')) return 'denied'
  if (t.includes('not found') || t.includes('enoent') || t.includes('no such file')
    || t.includes('does not exist')) return 'not-found'
  if (t.includes('timed out') || t.includes('timeout')) return 'timeout'
  if (t.includes('too large') || t.includes('refuses files larger')
    || t.includes('exceeds')) return 'too-large'
  // `Invalid arguments for X:` and `could not be parsed as JSON` are the registry's own two
  // spellings (`registry.ts:70`, `:78`, `:81`) and neither matched — so the category whose
  // doc comment claims it covers invalid JSON never once fired for invalid JSON.
  if (t.includes('invalid glob') || t.includes('not a valid regular expression')
    || t.includes('must be a') || t.includes('must have') || t.includes('unparseable')
    || t.includes('could not parse') || t.includes('could not be parsed')
    || t.includes('invalid arguments')) return 'bad-arguments'
  if (t.includes('is binary') || t.includes('byte-order mark')
    || t.includes('not a regular file')) return 'not-text'
  if (t.includes('is not available') || t.includes('no worker is available')
    || t.includes('is not configured')) return 'unavailable'
  if (t.includes('use list_dir') || t.includes('use `recall`') || t.includes('use recall')
    || t.includes('instead')) return 'wrong-tool'
  if (/exit(ed)? (code )?[1-9]/.test(t) || t.includes('exit 1')) return 'command-failed'
  return 'other'
}

/** One tool's record. The name is read from the transcript and checked for MEMBERSHIP of
 * the shipped set on the way in (`safeToolName`) — model output is not registry output. */
export interface ToolStat {
  name: string
  calls: number
  failed: number
  /** Exact repeats: the same tool called with byte-identical arguments it had already been
   * called with in that session. Counted through a hash — the arguments themselves are
   * never kept. This is the waste metric; the read-dedup memory was built off a hand count
   * of it, and this makes it a number anybody can produce. */
  repeats: number
  /** Failure categories and their counts. Keys are `FailureKind`. */
  failures: Partial<Record<FailureKind, number>>
}

/** One build's record. Deliberately the same three numbers as the summary line, so the
 * two are read against each other without arithmetic. */
export interface VersionStat {
  sessions: number
  toolCalls: number
  toolFailures: number
  /** Turns a check took back from the model under this build. */
  handBacks: number
}

export interface Diagnosis {
  /** How many days of history this covers, and how much of it there is. Deliberately a
   * SPAN rather than dates: "28 days" says as much for tuning and names no day. */
  spanDays: number
  sessions: number
  /** Sessions that were opened and never sent to. A high share is its own finding. */
  emptySessions: number
  userMessages: number
  /**
   * Messages the HARNESS wrote in the user's role — a gate handing work back.
   *
   * The single most interesting number here, and the reason it is worth extracting rather
   * than counting `role: 'user'` and calling it a day. A build failure fed to the model, an
   * acceptance gate's unmet criteria, a reviewer's findings: each is a turn the person did
   * not ask for and did pay for. Against `userMessages` it says how much of the work was
   * the work versus the checking of it.
   *
   * Told apart by `splitUserMessage`, which is the same discriminator the transcript replay
   * uses — so this count and what the window shows can never disagree.
   */
  harnessMessages: number
  assistantMessages: number
  toolCalls: number
  toolFailures: number
  /** Failed results whose call was never announced in the transcript, so no tool could be
   * blamed. Counted apart rather than guessed at: attributing them made the failure rate
   * exceed 100%, and dropping them silently would have made a broken transcript look clean. */
  unattributedFailures: number
  /**
   * Failures counted by READING the result rather than by a recorded outcome.
   *
   * A session whose `.ui.jsonl` is missing has no per-call verdict, so failure has to be
   * inferred from the text — and inference is a guess. Reported rather than folded in
   * silently, because the sessions most likely to be missing that file are the ones that
   * crashed, and a diagnosis that quietly estimated the most interesting sessions would be
   * confident exactly where it is weakest.
   */
  estimatedFailures: number
  /** Per session, so a report from a heavy user and a light one can be compared. */
  callsPerSession: number
  /** Modes the work was done in, by session count. */
  modes: Partial<Record<string, number>>
  /**
   * What each build actually did, not merely that it ran.
   *
   * `SessionMeta.appVersion` exists, in its own words, so the doctor "can say whether a
   * failure pattern belongs to a version — the question 'did that get better after 0.1.5'
   * is unanswerable without it, and it is the first question anybody asks of a diagnosis."
   * The report recorded the version and then answered a different question: how many
   * sessions ran under each. Which is the one thing nobody asks.
   *
   * Sessions with no version recorded are left out entirely rather than pooled under a
   * label. A bucket of unknowns compared against a named build is not a comparison, and it
   * would be read as one.
   */
  versions: Partial<Record<string, VersionStat>>
  /** Sessions that carried a distilled contract — the gate chain's entry condition. */
  contractSessions: number
  /** Sessions where the post-turn gates were turned off by hand. */
  manualGateSessions: number
  /**
   * The checks, read as actors rather than as a total.
   *
   * `harnessMessages` says how many turns the harness took. This says which check took them,
   * what the model did about it, whether that satisfied the check, and what the answering
   * cost in turns and calls. A gate that hands back three times running is more expensive
   * than any tool failure in the report above it and, until this existed, was invisible.
   */
  gates: ReturnType<typeof gateStatsFrom>
  /** Compactions, counted from the markers left in the transcripts. */
  compactions: number
  /** Bracketed status lines the harness wrote. Counted apart from the hand-backs in
   * `gates`, and reported apart, because one is a line and the other is a turn of work. */
  harnessNotes: number
  tools: ToolStat[]
  /**
   * The recurring stories: a failure, what the model did next, and whether that worked.
   *
   * The counting fields above say what happens a lot. These say what it MEANT — and the
   * `invented` count in each is the one to read first, because a value the model was never
   * shown is not a tool-description problem and no amount of rewording will touch it.
   */
  patterns: ReturnType<typeof patternsOf>
  /** Anything the scan itself could not do, so a thin report is never mistaken for a
   * healthy one. */
  problems: string[]
}

/**
 * The three values that come off DISK and are printed as themselves — made printable.
 *
 * This is where the module's claim was nearly, but not actually, true. A tool name is read
 * from `tool_calls[].function.name` in the transcript, which is MODEL OUTPUT, not something
 * out of our registry; `mode` and `appVersion` are read from a meta file that anything can
 * write. Each is a short token in every real case, and none of them is checked by anybody
 * before it reaches the report — so "the only strings are tool names and categories" rested
 * on those three being well-formed rather than on anything stopping them.
 *
 * They are shape-checked now. A value that is not the shape it claims to be does not get
 * clipped or escaped, it gets REPLACED by a literal from this file: whatever it was, it
 * cannot travel. That the fallback is dull is the point — a report saying `unknown-tool 3`
 * is a small loss, and it is the only outcome that cannot become a leak.
 */
/**
 * Harness messages that are NOT hand-backs and must be transparent to the gate walk.
 *
 * A note is a status line and a briefing is the machine talking to itself. Neither takes a
 * turn back from the model, and — because `beforeStep` writes a note between a gate and the
 * model's first step — treating either as a turn boundary hands the gate's whole answer to
 * something the report then hides.
 */
const PASS_THROUGH_KINDS: ReadonlySet<string> = new Set(['note', 'compaction-briefing'])

const KNOWN_MODES = new Set(['normal', 'plan', 'auto-edit', 'autopilot'])
/**
 * Digits and dots, and at most a short dotless tail.
 *
 * The first version allowed `(-[a-z0-9.]+)?` with the `i` flag, which an adversarial review
 * broke in one line: `0.1.5-ProjectAtlas.MergerWith.ZebraCorp.billing.ts` passed and printed
 * whole, as did a two-thousand-character tail. A path survives that pattern the moment its
 * separators are dots. Dots are what had to go, and the length cap is the belt: a version is
 * a short thing, and anything long enough to be a sentence is not one.
 */
const VERSION_CORE = /^\d{1,4}(\.\d{1,4}){0,3}$/
/**
 * Pre-release tags we ship, with an optional number after them.
 *
 * The third and last version of this check, and the first one that obeys the file's own
 * law. `(-[a-z0-9]{1,12})?` survived the audit's reachability argument — `appVersion` is
 * written by our own shell from Tauri's `getVersion()`, so nobody hostile is choosing it —
 * but the law here is not "is it reachable", it is `membership admits what we shipped`. A
 * twelve-character lowercase tail is a shape, and `0.1.5-zebracorp` printed whole.
 *
 * Twice now a shape has been tightened rather than replaced, and twice a reviewer has walked
 * through what was left. The tag is a closed set now; the digits after it carry no letters.
 */
const KNOWN_PRERELEASE = /^(alpha|beta|rc|dev|nightly|preview|canary)\d{0,3}$/

/**
 * MEMBERSHIP, not shape — and the difference is the whole guarantee.
 *
 * A shape check was the first version and it was wrong in a way worth recording, because it
 * looked obviously sufficient. A tool name arriving here comes off the TRANSCRIPT, which
 * stores model output before the registry has ever been consulted (`agent/loop.ts` appends
 * the assistant message, then resolves), so a hallucinated `read_halcyon_nda_client_src` is
 * on disk and looks exactly like a tool name. Worse, and with no hallucination needed at
 * all: an MCP tool is called `mcp__<server>__<tool>`, and `<server>` is a key out of the
 * user's own config file — their client's name, their project's codename. That fires on the
 * ordinary path, on a correctly configured machine, with nothing tampered with.
 *
 * So a name is printed only if it is one we ship. An MCP tool collapses to the prefix, which
 * is ours: the report still says MCP tools were used and how often, and says nothing about
 * whose. Everything else becomes `unknown-tool`, which loses a name and cannot leak one.
 */
function safeToolName(name: string): string {
  if (BUILT_IN_TOOL_NAMES.has(name)) return name
  if (name.startsWith(MCP_TOOL_PREFIX)) return 'mcp-tool'
  return 'unknown-tool'
}
function safeMode(mode: string): string {
  return KNOWN_MODES.has(mode) ? mode : 'unrecognised-mode'
}
/**
 * Returns the version, the version without an unrecognised tag, or nothing recognisable.
 *
 * Dropping just the tag rather than the whole string is deliberate: the numeric core is the
 * answer to the question anybody actually asks of this line — "did that get better after
 * 0.1.5" — and it cannot carry a word. When a tag IS dropped the caller is told, because a
 * silent loss is the one thing this module refuses: a reader comparing two reports would
 * otherwise see two builds silently collapse into one.
 */
function safeVersion(version: string): { version: string; droppedTag: boolean } {
  if (VERSION_CORE.test(version)) return { version, droppedTag: false }
  const dash = version.indexOf('-')
  if (dash > 0) {
    const core = version.slice(0, dash)
    const tag = version.slice(dash + 1)
    if (VERSION_CORE.test(core)) {
      return KNOWN_PRERELEASE.test(tag)
        ? { version, droppedTag: false }
        : { version: core, droppedTag: true }
    }
  }
  return { version: 'unrecognised-version', droppedTag: false }
}

/** Cheap, stable, and one-way: only used to tell "these two calls were identical" apart
 * from "these two were different". Never stored, never reported. */
function fingerprint(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

interface Line {
  role?: string
  content?: unknown
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
}

/**
 * Reads every session on disk and returns the numbers.
 *
 * `metas` is the caller's list, so a caller may narrow it — but note what is read OFF a
 * meta: `mode`, `createdAt`, `updatedAt`, `appVersion`, and whether a contract exists.
 * Never `title`, never `workspaceRoot`.
 */
export function diagnose(workspaceRoot: string, metas: readonly SessionMeta[]): Diagnosis {
  const problems: string[] = []
  const byTool = new Map<string, ToolStat>()
  const modes: Record<string, number> = {}
  const versions: Record<string, VersionStat> = {}

  let sessions = 0
  let emptySessions = 0
  let userMessages = 0
  let harnessMessages = 0
  let assistantMessages = 0
  let toolCalls = 0
  let toolFailures = 0
  let unattributedFailures = 0
  let estimatedFailures = 0
  const allEpisodes: Episode[] = []
  const allGateEvents: GateEvent[] = []
  let compactions = 0
  let harnessNotes = 0
  let contractSessions = 0
  let manualGateSessions = 0
  let oldest = Number.POSITIVE_INFINITY
  let newest = 0

  for (const meta of metas) {
    let raw: string
    try {
      raw = readFileSync(statePath(workspaceRoot, 'sessions', `${meta.id}.jsonl`), 'utf8')
    } catch {
      continue // no transcript on disk is not an error, just nothing to measure
    }
    sessions++
    const mode = safeMode(meta.mode)
    modes[mode] = (modes[mode] ?? 0) + 1
    const rawVersion = (meta as { appVersion?: string }).appVersion
    let versionStat: VersionStat | null = null
    if (typeof rawVersion === 'string' && rawVersion !== '') {
      const v = safeVersion(rawVersion)
      versionStat = versions[v.version]
        ?? { sessions: 0, toolCalls: 0, toolFailures: 0, handBacks: 0 }
      versionStat.sessions++
      versions[v.version] = versionStat
      if (v.droppedTag) {
        problems.push('a session recorded a build tag this report does not ship a name for, so only the numbers of its version are shown')
      }
    }
    if (meta.contract !== undefined) contractSessions++
    if ((meta as { gateMode?: string }).gateMode === 'manual') manualGateSessions++

    const at = Date.parse(meta.updatedAt)
    if (!Number.isNaN(at)) {
      oldest = Math.min(oldest, at)
      newest = Math.max(newest, at)
    }

    // Outcomes live beside the transcript: call id -> did it succeed. Without it every call
    // would read as a success, which would make the failure numbers a flattering lie.
    const outcomes = new Map<string, boolean>()
    try {
      const ui = readFileSync(statePath(workspaceRoot, 'sessions', `${meta.id}.ui.jsonl`), 'utf8')
      for (const line of ui.split('\n')) {
        if (line === '') continue
        try {
          const o = JSON.parse(line) as { id?: string; ok?: boolean }
          if (typeof o.id === 'string' && typeof o.ok === 'boolean') outcomes.set(o.id, o.ok)
        } catch { /* one unparseable line is not a reason to lose the session */ }
      }
    } catch {
      problems.push('one session had no recorded outcomes, so its failures were read from the results themselves')
    }

    // --- the same messages, twice ------------------------------------------------------
    //
    // The `.jsonl` is append-only and a compaction writes a marker followed by the ENTIRE
    // new transcript — which begins with a fresh system message, the briefing, an
    // acknowledgement, and then the RETAINED TAIL of the old one. Those tail messages are
    // already on disk from before the swap. `SessionStore.load()` never notices because it
    // slices at the last marker and reads only what follows; this walk reads the whole file
    // and counted every one of them twice.
    //
    // It was not a doubling, it was a fabrication. Two copies of one hand-back land in the
    // same person-turn, so the run counter reads them as a check that refused TWICE, and
    // the report asserts `worst run 2 · 1 not satisfied · changed files: 2, which satisfied
    // the check 0 of 1` about a check that fired once and was satisfied. An inflated count
    // is bad in a document forwarded as evidence; an invented failure is worse.
    //
    // The length is recoverable exactly, without comparing any text. `selectCompactionTail`
    // returns `droppedMessages = start - floor`, where `floor` is 1 whenever the transcript
    // opened on a system message, so
    //
    //     tail length = (messages in this segment) - droppedMessages - 1
    //
    // and the duplicates are the next that many NON-SYNTHETIC messages after the marker.
    // Counted rather than matched on purpose: `clipToBudget` and `collapseSupersededReads`
    // rewrite the content of some tail messages on the way out, so a byte comparison would
    // silently miss exactly the largest ones.
    let segmentMessages = 0
    let skipDuplicates = 0
    const seen = new Set<string>()
    /** This session's calls in order, so a failure can be read together with what came
     * next. Values live here and are discarded with the session. */
    const attempts: RawAttempt[] = []
    /** Call id -> tool name, so a `tool` RESULT can be attributed when it arrives. */
    const pending = new Map<string, string>()
    let messages = 0

    // --- the checks, as an actor -------------------------------------------------------
    //
    // A check's firing is a user-role message the harness wrote; its ANSWER is everything
    // the model did before the next turn boundary. So one is held open while the assistant
    // messages after it are counted, and closed when the next user-role message arrives —
    // whoever wrote that one.
    //
    // Runs are counted per person-turn rather than per adjacent pair, because a run is
    // interleaved in practice: a failed build hands back, the model edits, the verify runner
    // prints a note, the build fails again. Adjacency would call that two separate first
    // firings; the events of a turn are buffered and compared as a set instead, which sees
    // it as the same check refusing twice.
    let openGate: { kind: NonNullable<ReturnType<typeof splitUserMessage>['harnessKind']>
      steps: number; calls: number; tools: string[]; round: number } | null = null
    const runs = new Map<string, number>()
    let turnGateEvents: GateEvent[] = []
    /** `byHarness` is who spoke next. A check the model never got to answer because ANOTHER
     * check spoke — the chain moving on, a compaction retry replacing the turn — is not the
     * same event as one nobody answered, and calling both "did not reply" would put a claim
     * about the person giving up on a line where the machine simply carried on. */
    const closeGate = (byHarness: boolean): void => {
      if (openGate === null) return
      turnGateEvents.push({
        kind: openGate.kind,
        answer: answerFrom(openGate.steps, openGate.tools, byHarness),
        // Both filled in when the turn ends and the whole set is known.
        refired: false,
        outcomeKnown: true,
        round: openGate.round,
        steps: openGate.steps,
        calls: openGate.calls,
      })
      openGate = null
    }
    /**
     * A person's turn is over: a check that fired again anywhere in it was not satisfied.
     *
     * `endOfSession` marks the very last firing as one whose outcome nobody watched. It is
     * not the same as a check that passed, and the difference lands on the line a reader
     * uses to decide whether an answer worked.
     */
    const closeTurn = (endOfSession = false): void => {
      closeGate(false)
      for (let k = 0; k < turnGateEvents.length; k++) {
        const e = turnGateEvents[k] as GateEvent
        e.refired = turnGateEvents.slice(k + 1).some((later) => later.kind === e.kind)
      }
      const last = turnGateEvents[turnGateEvents.length - 1]
      if (endOfSession && last !== undefined) last.outcomeKnown = false
      allGateEvents.push(...turnGateEvents)
      turnGateEvents = []
      runs.clear()
    }

    for (const line of raw.split('\n')) {
      if (line === '') continue
      let m: Line
      try {
        m = JSON.parse(line) as Line
      } catch {
        continue
      }
      // The marker is not a message. Everything after it re-states a tail already walked.
      if ((m as { __event?: string }).__event === 'compaction') {
        compactions++
        const dropped = (m as { droppedMessages?: unknown }).droppedMessages
        if (typeof dropped === 'number' && Number.isFinite(dropped)) {
          skipDuplicates = Math.max(0, segmentMessages - dropped - 1)
        } else {
          // A marker with no count cannot be reconciled, and guessing would be the one
          // thing this module refuses to do. Say so instead: an inflated number a reader
          // has been warned about is recoverable; a silent one is not.
          problems.push('one session compacted without recording how much history it folded away, so the messages the swap re-appended are counted twice in it')
        }
        segmentMessages = 0
        continue
      }
      segmentMessages++
      // A re-appended tail message: already counted on the far side of the marker. The
      // three synthetic messages the swap writes are NOT duplicates and pass through.
      if (skipDuplicates > 0
        && m.role !== 'system'
        && m.content !== COMPACTION_ACK_TEXT
        && !(m.role === 'user' && typeof m.content === 'string'
          && m.content.startsWith(COMPACTION_BRIEFING_PREFIX))) {
        skipDuplicates--
        continue
      }
      messages++
      if (m.role === 'user') {
        // The harness talks in the user's role — the chat template has nowhere else to put
        // a build log or a list of unmet criteria. Only the SHAPE is inspected here; the
        // text goes no further than `splitUserMessage`, whose answer is a boolean and a
        // member of a literal union.
        const split = typeof m.content === 'string' ? splitUserMessage(m.content) : null
        if (split?.harness === true) {
          harnessMessages++
          const kind = split.harnessKind ?? 'other-harness'
          // A status note is not a turn boundary, and treating it as one was the most
          // damaging thing in this walk.
          //
          // `beforeStep` writes a bracketed note — a plan focus line, a context-fullness
          // warning — BEFORE the model's first generation of a turn. So on a session with
          // a contract, the order on disk is: the gate hands back, the note lands, THEN
          // the model works. Closing the gate on the note meant every check in such a
          // session closed with zero steps, was reported as `preempted` at `cost 0 model
          // turns and 0 tool calls`, and the entire real answer — the turns, the calls, the
          // edits — was charged to `note`, which the report then hides as "a line, not a
          // hand-back". The section built to say what the checking costs said it costs
          // nothing, in exactly the sessions where it costs most.
          //
          // Notes and compaction briefings pass through: counted as harness turns, never
          // opening or closing one. `verify-working` and `verify-unchanged` are bracketed
          // too and are NOT here — they are build failures handed back, which is the whole
          // reason they were given names of their own.
          if (PASS_THROUGH_KINDS.has(kind)) {
            if (kind === 'note') harnessNotes++
            continue
          }
          closeGate(true)
          if (versionStat !== null) versionStat.handBacks++
          const round = (runs.get(kind) ?? 0) + 1
          runs.set(kind, round)
          openGate = { kind, steps: 0, calls: 0, tools: [], round }
        } else {
          userMessages++
          closeGate(false)
          closeTurn()
        }
      }
      if (m.role === 'assistant') {
        // The compaction ACK is the other half of one synthetic round-trip: the swap writes
        // both the briefing and this reply, and no model ever generated a word of it.
        // Counting it inflated `assistantMessages` and, worse, charged a free turn to
        // whichever check happened to be open — so a compaction made the checking look more
        // expensive than it was. `replayEntries` has dropped it from the start, for exactly
        // this reason; the diagnosis was reading the raw file and did not.
        if (m.content === COMPACTION_ACK_TEXT) continue
        assistantMessages++
        if (openGate !== null) openGate.steps++
      }
      for (const call of m.tool_calls ?? []) {
        const raw = call.function?.name
        if (typeof raw !== 'string' || raw === '') continue
        const name = safeToolName(raw)
        toolCalls++
        if (versionStat !== null) versionStat.toolCalls++
        if (openGate !== null) {
          openGate.calls++
          openGate.tools.push(name)
        }
        const stat = byTool.get(name) ?? { name, calls: 0, failed: 0, repeats: 0, failures: {} }
        stat.calls++
        // Identical arguments to a call already made in this session. The hash is computed
        // and discarded; nothing about the arguments survives it.
        const key = `${name}:${fingerprint(call.function?.arguments ?? '')}`
        if (seen.has(key)) stat.repeats++
        else seen.add(key)
        byTool.set(name, stat)
        if (typeof call.id === 'string') {
          pending.set(call.id, name)
          // Recorded with its arguments so the NEXT attempt can be compared against it.
          // Nothing here is reported; `episodesFrom` turns pairs into categories.
          attempts.push({ what: name, args: call.function?.arguments ?? '', ok: true, result: '' })
        }
      }

      // A `tool` message is one call's result. Its content is read ONLY by `classify`, whose
      // return type is a category — this is the single place transcript text is touched and
      // the single place the type system is doing the guarding.
      if (m.role === 'tool' && typeof m.content === 'string') {
        const id = (m as { tool_call_id?: string }).tool_call_id
        const name = typeof id === 'string' ? pending.get(id) : undefined
        const ok = typeof id === 'string' && outcomes.has(id) ? outcomes.get(id) : undefined
        // `ok === undefined` means the outcomes file did not have this call. The fallback
        // used to demand BOTH a recognised category AND a keyword, and an inventory measured
        // what that cost: over 59 real failure literals from the write path, 11 were counted
        // and 48 vanished. The two conditions failed independently — every `validate()`
        // refusal classifies correctly as `bad-arguments` and then carries none of the seven
        // keywords, so it was categorised right and counted as a success.
        //
        // OR, not AND. And it is still a guess, which is why sessions that needed it are
        // counted and said out loud: the sessions most likely to be missing their outcomes
        // sidecar are the ones that crashed, which are the ones worth diagnosing.
        const guessed = ok === undefined
        const failed = ok === false || (guessed && (classify(m.content) !== 'other'
          || /error|failed|refus|could not|cannot|denied|not found|invalid|no such/i.test(m.content)))
        if (failed && guessed) estimatedFailures++
        // Attach the outcome to the attempt this result answers, so the episode builder
        // sees the sequence as it happened.
        if (name !== undefined) {
          for (let k = attempts.length - 1; k >= 0; k--) {
            const at = attempts[k] as RawAttempt
            if (at.what === name && at.result === '') {
              at.ok = !failed
              at.result = m.content
              break
            }
          }
        }
        if (failed) {
          const kind = classify(m.content)
          // A result whose call was never announced cannot be attributed, and inventing a
          // row for it was a real bug rather than an untidiness: the row had `calls: 0`
          // while `toolFailures` still rose, so a transcript with one orphan rendered
          // "1 calls, 2 failed — 200%". A percentage over a hundred in a report somebody
          // forwards as evidence discredits every number beside it.
          if (name === undefined) {
            unattributedFailures++
            continue
          }
          toolFailures++
          if (versionStat !== null) versionStat.toolFailures++
          const stat = byTool.get(name)
            ?? { name, calls: 0, failed: 0, repeats: 0, failures: {} }
          stat.failed++
          stat.failures[kind] = (stat.failures[kind] ?? 0) + 1
          byTool.set(stat.name, stat)
        }
      }
    }
    // The last check of a session has no next turn to close it: the session simply ended,
    // which is itself an answer (`nothing`) and one worth seeing — a session that ends on an
    // unanswered gate is a person who gave up on it.
    closeTurn(true)
    allEpisodes.push(...episodesFrom(attempts))
    // One system message and nothing else: opened, never used.
    if (messages <= 1) emptySessions++
  }

  const spanDays = newest > 0 && oldest < Number.POSITIVE_INFINITY
    ? Math.max(1, Math.round((newest - oldest) / 86_400_000))
    : 0

  return {
    spanDays,
    sessions,
    emptySessions,
    userMessages,
    harnessMessages,
    assistantMessages,
    toolCalls,
    toolFailures,
    unattributedFailures,
    estimatedFailures,
    callsPerSession: sessions === 0 ? 0 : Math.round((toolCalls / sessions) * 10) / 10,
    modes,
    versions,
    contractSessions,
    manualGateSessions,
    gates: gateStatsFrom(allGateEvents),
    compactions,
    harnessNotes,
    tools: [...byTool.values()].sort((a, b) => b.calls - a.calls),
    patterns: patternsOf(allEpisodes),
    problems: [...new Set(problems)],
  }
}

/**
 * The diagnosis as text meant to be COPIED OUT and sent to somebody.
 *
 * Written for a person to read at a glance and for the next reader to trust without
 * auditing: every line is a label this file wrote and a number `diagnose` counted. There is
 * no interpolation of anything that came off a transcript, which is what makes "you can send
 * this as it is" a true sentence rather than a hope.
 */
/** Below this many messages from the person, a percentage of them is noise rather than a
 * measurement. See the `harness turns` line for what reading one off a tiny sample cost. */
const RATIO_MIN_MESSAGES = 5

/** Below this many calls under one build, a failure RATE for it is noise — and this block
 * is read as a comparison, which is exactly where noise reads as a regression. */
const VERSION_MIN_CALLS = 20

export function renderDiagnosis(d: Diagnosis): string {
  const pct = (n: number, of: number): string => (of === 0 ? '0%' : `${Math.round((n / of) * 100)}%`)
  const out: string[] = [
    'PrivateCode self-diagnosis',
    'Counts only. No file names, paths, commands, code or conversation text — safe to send as it is.',
    '',
    `history        ${d.sessions} session${d.sessions === 1 ? '' : 's'} over ${d.spanDays} day${d.spanDays === 1 ? '' : 's'}` +
      (d.emptySessions > 0 ? `, ${d.emptySessions} never used` : ''),
    `messages       ${d.userMessages} from the person, ${d.assistantMessages} from the model`,
    // Deliberately "harness turns" rather than "the gates gave back". This total includes
    // status notes, which are lines and not hand-backs; calling all of it a hand-back
    // overstated the cost of checking, and the breakdown that fixes it is further down.
    //
    // The RATIO is printed only once there is enough history to mean anything, and the
    // threshold is not fussiness. The live model read `400% of what the person sent` off a
    // one-message fixture and concluded in its own summary that the agent "is spinning
    // rather than making progress" — a claim the number cannot support at that sample size,
    // written into a document whose whole purpose is to be forwarded as evidence. A ratio
    // off one or two messages is noise; below the threshold the count still travels and the
    // invitation to over-read it does not.
    // Says what it is made of, because an audit found the number standing alone with
    // nowhere in the report to account for it — a reader told the machine took nine turns
    // and given no way to see what any of them were. The three parts each have their own
    // line or section below, so the total reconciles.
    `harness turns  ${d.harnessMessages} turns the machine took, not the person` +
      ' — checks, status notes and compaction briefings, each broken out below' +
      (d.userMessages < RATIO_MIN_MESSAGES
        ? ''
        : `\n               ${Math.round((d.harnessMessages / d.userMessages) * 100)}% of what the person sent`),
    `tool calls     ${d.toolCalls} (${d.callsPerSession} per session), ${d.toolFailures} failed — ${pct(d.toolFailures, d.toolCalls)}`,
    ...(d.estimatedFailures > 0
      ? [`estimated      ${d.estimatedFailures} of those failures were read from the result text, ` +
         'not from a recorded outcome — treat them as approximate']
      : []),
    ...(d.unattributedFailures > 0
      ? [`orphan results ${d.unattributedFailures} failed results had no call to attribute them to`]
      : []),
    `compactions    ${d.compactions}`,
    `contracts      ${d.contractSessions} of ${d.sessions} sessions distilled one`,
  ]
  if (d.manualGateSessions > 0) {
    out.push(`checks off     ${d.manualGateSessions} sessions ran with the post-turn gates off`)
  }
  out.push(
    `modes          ${Object.entries(d.modes).map(([m, n]) => [m, n ?? 0] as const)
      .sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} (${n})`).join(', ') || 'none'}`,
  )

  // Sorted by version STRING, ascending, because this block is read as a before-and-after
  // and putting the busiest build first would scramble the only ordering that matters.
  const versions = Object.entries(d.versions)
    .map(([v, s]) => [v, s ?? { sessions: 0, toolCalls: 0, toolFailures: 0, handBacks: 0 }] as const)
    .sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))
  if (versions.length === 0) {
    out.push('app versions   not recorded')
  } else {
    out.push('', 'per build — did it get better:')
    for (const [v, s] of versions) {
      out.push(
        `  ${v.padEnd(16)} ${String(s.sessions).padStart(4)} session${s.sessions === 1 ? ' ' : 's'}` +
        `  ${String(s.toolCalls).padStart(5)} calls` +
        // A rate off a handful of calls is noise, and this block exists to be compared
        // across builds — which is exactly where noise reads as a regression.
        // Padded to one width so the last column lines up between builds — the block is
        // meant to be read down, and a ragged column is read as unrelated rows.
        '  ' + (s.toolCalls < VERSION_MIN_CALLS
          ? `${String(s.toolFailures).padStart(4)} failed (too few to rate)`
          : `${String(s.toolFailures).padStart(4)} failed (${pct(s.toolFailures, s.toolCalls)})`
        ).padEnd(26) +
        `  ${String(s.handBacks).padStart(4)} turn${s.handBacks === 1 ? '' : 's'} handed back`,
      )
    }
    if (versions.length === 1) {
      out.push('  (one build only — there is nothing here to compare it against yet)')
    }
  }
  out.push('', 'per tool — calls, failures, exact repeats:')
  for (const t of d.tools) {
    const kinds = Object.entries(t.failures).map(([k, n]) => [k, n ?? 0] as const)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')
    out.push(
      `  ${t.name.padEnd(16)} ${String(t.calls).padStart(5)} calls` +
      `  ${String(t.failed).padStart(4)} failed (${pct(t.failed, t.calls)})` +
      `  ${String(t.repeats).padStart(4)} repeats` +
      (kinds === '' ? '' : `\n      ${kinds}`),
    )
  }
  out.push(...renderGates(d.gates, d.harnessNotes))
  const stories = renderPatterns(d.patterns)
  if (stories.length > 0) {
    out.push(
      '',
      'what went wrong and what happened next — each line is a pattern, not one incident:',
      ...stories,
    )
  }
  if (d.problems.length > 0) {
    out.push('', 'the scan itself:')
    for (const p of d.problems) out.push(`  · ${p}`)
  }
  return out.join('\n')
}
