import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensurePrivateDir, PRIVATE_DIR } from '../private-dir.js'

/**
 * What the agent actually did, in a form a person can read over coffee.
 *
 * The transcript is the complete record and is the wrong artefact for this: after eight
 * unattended hours it is tens of thousands of tokens of reasoning, tool arguments and tool
 * output, and the question in the morning is not "what did it think" but "what changed, and
 * did anything fail". This file answers that in a screenful per turn.
 *
 * Two properties make it worth trusting:
 *
 * - **The changed-files line comes from the checkpoint diff, not from the model's account of
 *   its own work.** A model that believes it edited a file it did not is exactly the failure
 *   an overnight review has to catch, and a summary written by the same model would agree
 *   with itself.
 * - **It is written by the engine, into `.privatecode/`, which every model-issued write tool
 *   is denied.** The agent can read its own log — useful when resuming — and cannot edit it
 *   to say something that did not happen.
 */

const WORKLOG_FILE = 'worklog.md'

/** One line of the user's ask is enough to recognise a turn; the transcript has the rest. */
const ASK_CHARS = 160

/** Commands are the other half of "what happened"; past this many the list is a wall. */
const MAX_COMMANDS = 8

export interface CommandRecord {
  command: string
  /** From the tool result's first line (`exit 0 in 1.2 s`), or absent when it did not run. */
  exit?: number
  ok: boolean
  /**
   * Whether the command actually executed.
   *
   * The rehearsal caught this being missing, and it was the worst kind of missing: a
   * `run_command` that the permission gate DEFERRED was written into the log under
   * "**Ran:** … → failed", so a person reading in the morning would have concluded the
   * typecheck was run and broken. A blocked call is worth reporting — it is often the most
   * interesting thing that happened — but never under the same heading as one that ran.
   */
  ran: boolean
  /** Why it did not run, for the blocked line. */
  blockedBy?: string
}

export interface WorkLogEntry {
  at: Date
  turn: number
  /** The user text that started the turn, or the runner's nudge. */
  ask: string
  /** Checkpoint taken at the end of this turn, when anything changed. */
  checkpoint?: string
  /** `git diff --stat` output between the previous checkpoint and this one. */
  diffStat?: string
  commands: CommandRecord[]
  /** `TurnResult.stoppedBecause`. */
  ended: string
  steps: number
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Turns `git diff --stat` into one line.
 *
 * The full stat is a block per file plus a summary; what a morning reader wants is the file
 * names and the shape of the damage. Anything past a handful of files collapses to a count,
 * because a turn that touched thirty files is a fact in itself and listing them is noise.
 */
export function summarizeDiff(diffStat: string): string {
  const lines = diffStat.trim().split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return ''
  const files = lines.slice(0, -1)
  const total = lines[lines.length - 1]?.trim() ?? ''
  if (files.length === 0) return total
  if (files.length > 6) return `${files.length} files (${total})`
  return files
    .map((l) => {
      const [name, rest] = l.split('|')
      const counts = (rest ?? '').trim().replace(/\s+/g, ' ')
      return `${(name ?? '').trim()} (${counts})`
    })
    .join(', ')
}

function renderEntry(entry: WorkLogEntry): string {
  const time = `${String(entry.at.getHours()).padStart(2, '0')}:${String(entry.at.getMinutes()).padStart(2, '0')}`
  const head = `## ${time} · turn ${entry.turn}` +
    (entry.checkpoint ? ` · checkpoint ${entry.checkpoint}` : '')

  const lines = [head, `**Asked:** ${clip(entry.ask, ASK_CHARS)}`]

  const changed = entry.diffStat ? summarizeDiff(entry.diffStat) : ''
  // A turn that changed nothing gets NO Changed line rather than "Changed: nothing" — the
  // absence is the signal, and reads faster when scanning a night's worth of entries.
  if (changed !== '') lines.push(`**Changed:** ${changed}`)

  const ran = entry.commands.filter((c) => c.ran)
  const blocked = entry.commands.filter((c) => !c.ran)

  if (ran.length > 0) {
    lines.push(`**Ran:** ${renderCommands(ran, (c) =>
      c.exit !== undefined ? `exit ${c.exit}` : c.ok ? 'ok' : 'failed')}`)
  }
  // Its own line, never folded into "Ran". A command the agent wanted and did not get is
  // frequently the most useful thing in a night's log — it is what the morning's answer to
  // the decision queue is about.
  if (blocked.length > 0) {
    lines.push(`**Blocked:** ${renderCommands(blocked, (c) => c.blockedBy ?? 'not run')}`)
  }

  lines.push(`**Ended:** ${entry.ended}, ${entry.steps} step${entry.steps === 1 ? '' : 's'}`)
  return `${lines.join('\n')}\n\n`
}

function renderCommands(commands: CommandRecord[], status: (c: CommandRecord) => string): string {
  // Collapsed by command-and-outcome, with a count. A model that was blocked twice on the
  // same command produced two identical entries in the rehearsal's log; saying it twice
  // conveys nothing the count does not, and pushes whatever WAS different off the line.
  const groups = new Map<string, { text: string; times: number }>()
  for (const c of commands) {
    const text = `\`${clip(c.command, 80)}\` → ${status(c)}`
    const existing = groups.get(text)
    if (existing) existing.times += 1
    else groups.set(text, { text, times: 1 })
  }
  const all = [...groups.values()]
  const shown = all.slice(0, MAX_COMMANDS)
  const rendered = shown.map((g) => (g.times > 1 ? `${g.text} (×${g.times})` : g.text))
  const more = all.length > shown.length ? ` · and ${all.length - shown.length} more` : ''
  return `${rendered.join(' · ')}${more}`
}

/**
 * The last line of the night: why there are no more turns.
 *
 * Its own shape rather than a turn entry with empty fields. The first rehearsal wrote it as
 * one, which produced a second "turn 1" heading and an "Ended: run ended, 0 steps" line that
 * said nothing — noise at exactly the place a person looks first.
 */
function renderRunEnd(at: Date, turns: number, detail: string): string {
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return `## ${time} · run ended after ${turns} turn${turns === 1 ? '' : 's'}\n${detail}\n\n`
}

export class WorkLog {
  readonly problems: string[] = []
  private readonly path: string
  private readonly root: string
  private started = false

  constructor(workspaceRoot: string) {
    this.root = workspaceRoot
    this.path = join(workspaceRoot, PRIVATE_DIR, WORKLOG_FILE)
  }

  /** Workspace-relative, so it can be handed to the model or shown in the app. */
  relativePath(): string {
    return `${PRIVATE_DIR}/${WORKLOG_FILE}`
  }

  /**
   * Appends one entry. Never throws: a session that cannot write its log is worse off, but
   * failing the turn over it would be worse still.
   */
  append(entry: WorkLogEntry): void {
    this.write(renderEntry(entry), entry.at)
  }

  /** The last line of the night. See `renderRunEnd`. */
  appendRunEnd(at: Date, turns: number, detail: string): void {
    this.write(renderRunEnd(at, turns, detail), at)
  }

  private write(body: string, at: Date): void {
    try {
      ensurePrivateDir(this.root)
      // A dated header once per process, so a file spanning several days is still readable
      // — the per-entry stamps are times only, which is what makes the entries scannable.
      const header = this.started ? '' : `\n# ${at.toISOString().slice(0, 10)}\n\n`
      this.started = true
      appendFileSync(this.path, header + body, 'utf8')
    } catch (e) {
      if (this.problems.length === 0) {
        this.problems.push(`the work log could not be written (${(e as Error).message})`)
      }
    }
  }
}

/**
 * Pulls the command records out of a turn's tool calls.
 *
 * Reads the exit code out of `run_command`'s first result line rather than re-running
 * anything: that line is `exit 0 in 1.2 s` by construction (see `tools/run-command.ts`), and
 * the alternative — trusting the model's prose about whether the tests passed — is exactly
 * what this file exists not to do.
 */
/**
 * Why a call did not run, as a few words.
 *
 * The full text is written for the MODEL — it explains what to do instead, at length — and
 * the first rehearsal pasted all of it into the log three times over, once per retry, so the
 * one line a person needs was buried under sixty words of instructions addressed to someone
 * else. These are the four ways a call is stopped, and each is a label.
 */
function blockLabel(content: string): string {
  const body = content.replace(/^Not run[:.]\s*/, '')
  if (/queued for the user/i.test(body)) return 'queued for you'
  if (/already called/i.test(body)) return 'already tried twice with the same result'
  if (/declined/i.test(body)) return 'you declined it'
  if (/not available in this mode/i.test(body)) return 'not available in this mode'
  return clip(body, 60)
}

export function commandsFrom(
  calls: { name: string; args: string; content: string; ok: boolean }[],
): CommandRecord[] {
  const records: CommandRecord[] = []
  for (const call of calls) {
    if (call.name !== 'run_command' && call.name !== 'background_task') continue
    let command = ''
    try {
      const parsed = JSON.parse(call.args) as { command?: unknown }
      if (typeof parsed.command === 'string') command = parsed.command
    } catch { /* a call whose arguments did not parse never ran */ }
    if (command === '') continue

    // Every path that stops a call before it executes -- a permission denial, a deferral
    // into the decision queue, a loop-detector refusal, plan mode -- answers with a result
    // beginning `Not run:`. That prefix is the one honest signal available here, and
    // getting it wrong is how a command that never ran ends up logged as one that ran and
    // failed, which is what the first rehearsal produced.
    const blocked = /^Not run[:.]/.test(call.content)
    const exit = /^exit (-?\d+)/.exec(call.content)?.[1]
    records.push({
      command,
      ...(exit !== undefined ? { exit: Number(exit) } : {}),
      ok: call.ok,
      ran: !blocked,
      ...(blocked ? { blockedBy: blockLabel(call.content) } : {}),
    })
  }
  return records
}
