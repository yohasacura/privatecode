import { readFileSync } from 'node:fs'
import { statePath } from '../private-dir.js'
import { splitUserMessage } from '../host/replay.js'
import { BUILT_IN_TOOL_NAMES, MCP_TOOL_PREFIX } from '../tools/built-in-names.js'
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
  | 'other'

/**
 * Text in, category out. The only function in this module that reads transcript content,
 * and it cannot return any of it.
 *
 * Ordered most specific first, because several of these overlap: a PowerShell parse error
 * is also a failed command, and "file not found" is also just an error.
 */
export function classify(text: string): FailureKind {
  const t = text.toLowerCase()
  if (t.includes('token \'&&\'') || t.includes("token '&&'") || t.includes('is not a valid statement separator')
    || (t.includes('&&') && t.includes('parsererror'))) return 'shell-operator'
  if (t.includes('outside the workspace') || t.includes('not inside this workspace')
    || t.includes('must stay inside')) return 'outside-workspace'
  if (t.includes('denied') || t.includes('not allowed') || t.includes('refused by the user')
    || t.includes('permission')) return 'denied'
  if (t.includes('not found') || t.includes('enoent') || t.includes('no such file')
    || t.includes('does not exist')) return 'not-found'
  if (t.includes('timed out') || t.includes('timeout')) return 'timeout'
  if (t.includes('too large') || t.includes('refuses files larger')
    || t.includes('exceeds')) return 'too-large'
  if (t.includes('invalid glob') || t.includes('not a valid regular expression')
    || t.includes('must be a') || t.includes('unparseable')
    || t.includes('could not parse')) return 'bad-arguments'
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
  /** Per session, so a report from a heavy user and a light one can be compared. */
  callsPerSession: number
  /** Modes the work was done in, by session count. */
  modes: Partial<Record<string, number>>
  /** App versions seen, by session count. Empty when no session recorded one. */
  versions: Partial<Record<string, number>>
  /** Sessions that carried a distilled contract — the gate chain's entry condition. */
  contractSessions: number
  /** Sessions where the post-turn gates were turned off by hand. */
  manualGateSessions: number
  /** Compactions, counted from the markers left in the transcripts. */
  compactions: number
  tools: ToolStat[]
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
const VERSION = /^\d{1,4}(\.\d{1,4}){0,3}(-[a-z0-9]{1,12})?$/

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
function safeVersion(version: string): string {
  return VERSION.test(version) ? version : 'unrecognised-version'
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
  const versions: Record<string, number> = {}

  let sessions = 0
  let emptySessions = 0
  let userMessages = 0
  let harnessMessages = 0
  let assistantMessages = 0
  let toolCalls = 0
  let toolFailures = 0
  let unattributedFailures = 0
  let compactions = 0
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
    const version = (meta as { appVersion?: string }).appVersion
    if (typeof version === 'string' && version !== '') {
      const v = safeVersion(version)
      versions[v] = (versions[v] ?? 0) + 1
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

    const seen = new Set<string>()
    /** Call id -> tool name, so a `tool` RESULT can be attributed when it arrives. */
    const pending = new Map<string, string>()
    let messages = 0

    for (const line of raw.split('\n')) {
      if (line === '') continue
      let m: Line
      try {
        m = JSON.parse(line) as Line
      } catch {
        continue
      }
      messages++
      if (m.role === 'user') {
        // The harness talks in the user's role — the chat template has nowhere else to put
        // a build log or a list of unmet criteria. Only the SHAPE is inspected here; the
        // text goes no further than `splitUserMessage`, whose answer is a boolean.
        if (typeof m.content === 'string' && splitUserMessage(m.content).harness === true) {
          harnessMessages++
        } else {
          userMessages++
        }
      }
      if (m.role === 'assistant') assistantMessages++
      if ((m as { __event?: string }).__event === 'compaction') compactions++

      for (const call of m.tool_calls ?? []) {
        const raw = call.function?.name
        if (typeof raw !== 'string' || raw === '') continue
        const name = safeToolName(raw)
        toolCalls++
        const stat = byTool.get(name) ?? { name, calls: 0, failed: 0, repeats: 0, failures: {} }
        stat.calls++
        // Identical arguments to a call already made in this session. The hash is computed
        // and discarded; nothing about the arguments survives it.
        const key = `${name}:${fingerprint(call.function?.arguments ?? '')}`
        if (seen.has(key)) stat.repeats++
        else seen.add(key)
        byTool.set(name, stat)
        if (typeof call.id === 'string') pending.set(call.id, name)
      }

      // A `tool` message is one call's result. Its content is read ONLY by `classify`, whose
      // return type is a category — this is the single place transcript text is touched and
      // the single place the type system is doing the guarding.
      if (m.role === 'tool' && typeof m.content === 'string') {
        const id = (m as { tool_call_id?: string }).tool_call_id
        const name = typeof id === 'string' ? pending.get(id) : undefined
        const ok = typeof id === 'string' && outcomes.has(id) ? outcomes.get(id) : undefined
        // `ok === undefined` means the outcomes file did not have this call; fall back to
        // the text, which is what the outcomes file was derived from in the first place.
        const failed = ok === false || (ok === undefined && classify(m.content) !== 'other'
          && /error|failed|refus|could not|cannot|denied|not found/i.test(m.content))
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
          const stat = byTool.get(name)
            ?? { name, calls: 0, failed: 0, repeats: 0, failures: {} }
          stat.failed++
          stat.failures[kind] = (stat.failures[kind] ?? 0) + 1
          byTool.set(stat.name, stat)
        }
      }
    }
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
    callsPerSession: sessions === 0 ? 0 : Math.round((toolCalls / sessions) * 10) / 10,
    modes,
    versions,
    contractSessions,
    manualGateSessions,
    compactions,
    tools: [...byTool.values()].sort((a, b) => b.calls - a.calls),
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
export function renderDiagnosis(d: Diagnosis): string {
  const pct = (n: number, of: number): string => (of === 0 ? '0%' : `${Math.round((n / of) * 100)}%`)
  const out: string[] = [
    'PrivateCode self-diagnosis',
    'Counts only. No file names, paths, commands, code or conversation text — safe to send as it is.',
    '',
    `history        ${d.sessions} session${d.sessions === 1 ? '' : 's'} over ${d.spanDays} day${d.spanDays === 1 ? '' : 's'}` +
      (d.emptySessions > 0 ? `, ${d.emptySessions} never used` : ''),
    `messages       ${d.userMessages} from the person, ${d.assistantMessages} from the model`,
    `handed back    ${d.harnessMessages} turns the gates gave back to the model` +
      (d.userMessages === 0 ? '' : ` — ${Math.round((d.harnessMessages / d.userMessages) * 100)}% of what the person sent`),
    `tool calls     ${d.toolCalls} (${d.callsPerSession} per session), ${d.toolFailures} failed — ${pct(d.toolFailures, d.toolCalls)}`,
    ...(d.unattributedFailures > 0
      ? [`orphan results ${d.unattributedFailures} failed results had no call to attribute them to`]
      : []),
    `compactions    ${d.compactions}`,
    `contracts      ${d.contractSessions} of ${d.sessions} sessions distilled one`,
  ]
  if (d.manualGateSessions > 0) {
    out.push(`checks off     ${d.manualGateSessions} sessions ran with the post-turn gates off`)
  }
  const versions = Object.entries(d.versions).map(([v, n]) => [v, n ?? 0] as const)
    .sort((a, b) => b[1] - a[1])
  out.push(
    `app versions   ${versions.length === 0 ? 'not recorded' : versions.map(([v, n]) => `${v} (${n})`).join(', ')}`,
    `modes          ${Object.entries(d.modes).map(([m, n]) => [m, n ?? 0] as const)
      .sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} (${n})`).join(', ') || 'none'}`,
    '',
    'per tool — calls, failures, exact repeats:',
  )
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
  if (d.problems.length > 0) {
    out.push('', 'the scan itself:')
    for (const p of d.problems) out.push(`  · ${p}`)
  }
  return out.join('\n')
}
