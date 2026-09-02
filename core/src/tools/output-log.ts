import { readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureStateDir } from '../private-dir.js'
import type { Workspace } from '../workspace.js'

/**
 * Overflow storage for tool output that is too large to hand the model.
 *
 * The problem this solves: a tool that produces more than the context can afford used to
 * middle-elide its output and say so. That is a dead end — the model cannot ask for the
 * part that was cut, so its only recourse is to run the command again with a narrower
 * filter, guessing at what it could not see. On a long build or test log that costs
 * several turns and often never converges.
 *
 * Instead the whole output is written to a file inside the workspace, and the model is
 * told the path and the line count. From there it uses the tools it already has:
 * `Read` with `start_line`/`end_line` walks it in pages, `Grep` with `path`
 * filters it. Nothing is lost, nothing is guessed, and paging costs one small tool call
 * per page instead of one whole command re-run.
 *
 * The directory is `.privatecode/state/logs/` under the primary folder — already ours
 * (sessions live beside it), already inside the jail so `Read` accepts it, and
 * conventionally ignored by tooling.
 */

/** How many log files to keep PER PREFIX (see pruneLogs). Old ones are the least likely to
 * be wanted and the most likely to be forgotten, so the directory prunes itself rather than
 * growing forever. */
const KEEP_LOGS = 20

/** `run-20260804-013245-118`: sortable, unique per call, and readable in a directory
 * listing without opening anything. */
function logName(prefix: string, now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${prefix}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}.log`
}

export interface SpilledLog {
  /** Workspace-relative path, forward slashes, carrying the folder name when the workspace
   * has several — ready to paste into a `Read` call. */
  path: string
  lines: number
}

/**
 * Writes `text` to a fresh log file and returns how to reach it, or `null` if it could not
 * be written.
 *
 * Failure is deliberately soft: an unwritable workspace must degrade to the old clipped
 * output, never turn a successful command into a failed tool call.
 */
export async function spillToLog(
  workspace: Workspace,
  prefix: string,
  text: string,
  now: Date = new Date(),
): Promise<SpilledLog | null> {
  try {
    // Creates the directory AND its self-ignore, so a workspace that is a git repository
    // never sees these logs in `git status`. See private-dir.ts.
    const dir = ensureStateDir(workspace.root, 'logs')
    const abs = join(dir, logName(prefix, now))
    await writeFile(abs, text, 'utf8')
    void pruneLogs(dir, prefix)
    // The address is derived from the file, NOT assembled as `.privatecode/state/logs/…`.
    // In a multi-folder workspace the first segment of a path has to name a mount, so the
    // assembled form is not a path this workspace can resolve at all: `resolve` threw
    // WorkspaceViolation, the catch below turned that into `null`, and every oversized
    // output quietly reverted to the middle-elided dead end this module exists to
    // prevent — with two folders attached, spilling never worked once. `display` spells
    // the path the way the model's own Read/Grep will accept it, in a
    // single-folder workspace and a multi-folder one alike.
    return { path: workspace.display(abs), lines: countLines(text) }
  } catch {
    return null
  }
}

/** Line count as `Read` counts them, so "of N lines" agrees with what paging shows. */
export function countLines(text: string): number {
  if (text === '') return 0
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * Best-effort, fire-and-forget: a failed prune must never affect the call that triggered
 * it, and a log left behind costs a few kilobytes.
 *
 * Prunes ONE prefix, never the directory as a whole. Every spiller shares this folder and
 * they differ only by prefix (`run`, `web`, `browser`, `mcp-<server>`), so a plain
 * lexicographic sort over the mix orders by prefix first and only then by time: with
 * twenty `run-*.log` present, a freshly written `browser-*.log` sorted to the FRONT and
 * was unlinked milliseconds after its path had been handed to the model — which had just
 * been told, in as many words, not to re-run the command to see what was cut. Within one
 * prefix the name is a fixed-width timestamp, so sorting names is sorting by age and the
 * file just written is always last.
 *
 * The cost is that the folder now holds up to KEEP_LOGS per prefix instead of KEEP_LOGS in
 * total. There are a handful of prefixes, each stream still sheds its oldest, and the
 * alternative — one stream's chatter evicting another's advertised file — is the bug.
 */
export async function pruneLogs(dir: string, prefix: string): Promise<void> {
  try {
    const mine = (await readdir(dir))
      .filter((n) => n.startsWith(`${prefix}-`) && n.endsWith('.log'))
      .sort()
    for (const name of mine.slice(0, Math.max(0, mine.length - KEEP_LOGS))) {
      await unlink(join(dir, name)).catch(() => {})
    }
  } catch { /* nothing to prune, or the directory vanished */ }
}

/**
 * The paragraph handed to the model in place of the part that did not fit.
 *
 * It states the size, shows a bounded head so the common case (the answer is near the
 * top) needs no second call, and names both ways to get the rest — by line range and by
 * pattern — with the exact arguments, because a capability the model has to infer is one
 * it will not use.
 */
export function overflowNotice(log: SpilledLog, shownLines: number): string {
  return `\n... ${log.lines - shownLines} more lines not shown here.\n` +
    `The complete output (${log.lines} lines) is saved at ${log.path}\n` +
    `Read any part of it with Read(path="${log.path}", start_line=…, end_line=…), ` +
    `or find lines in it with Grep(pattern="…", path="${log.path}"). ` +
    'Do NOT re-run the command to see what was cut.'
}

/** The first `n` lines of `text`, for the head shown inline before the notice. */
export function headLines(text: string, n: number): string {
  return text.split(/\r?\n/).slice(0, n).join('\n')
}
